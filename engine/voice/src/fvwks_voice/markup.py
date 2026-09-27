"""Script markup -> chunks (one contract Segment each).

| Markup           | Meaning                                                              |
|------------------|----------------------------------------------------------------------|
| `|`              | Beat break: flags the chunk before it `beat_break`.                  |
| `[0.5]`          | Pause in seconds after the chunk (`[0.5s]`, `[500ms]` work too).     |
| `[2b]`           | Pause in beats after the chunk (`[1/2b]`, `[2 beats]`).              |
| `*word*`         | Throw: flags the chunk `throw` (the span may cover several words).   |
| newline          | Starts a new chunk with a slightly longer natural gap; no flag.      |
| `\\|` `\\*` `\\[` `\\\\` | Literal characters.                                          |

A chunk is the text between breaks. It becomes one Segment and is synthesized in one TTS call, so its
prosody stays natural. Chunks depend only on the script, never on the voice, so STACK voices rendered from
the same script always get the same segment count. `fixtures/markup_cases.json` is the shared reference.

The parser is lenient: an unmatched `*`, an unknown `[tag]` or a leading pause is dropped and reported
in `warnings`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from fractions import Fraction

from .errors import VoiceError
from .lexicon import Lexicon

DEFAULT_BPM = 120.0
MAX_SCRIPT_CHARS = 2000  # TTSRequest.script max_length
MAX_PAUSE_S = 30.0
MAX_PAUSE_BEATS = 64.0
TERMINAL_PUNCT = ".!?…"
CONTINUING_PUNCT = ",;:-—"
CLOSERS = "\"'”’)]"

PAUSE_RE = re.compile(
    r"""\[\s*
        (?P<num>\d+(?:\.\d*)?|\.\d+)
        (?:\s*/\s*(?P<den>\d+))?
        \s*(?P<unit>ms|s|secs?|seconds?|b|beats?)?
        \s*\]""",
    re.IGNORECASE | re.VERBOSE,
)
_WS_RE = re.compile(r"\s+")
_ALNUM_RE = re.compile(r"[^\W_]")
_WORD_TAIL_RE = re.compile(r"[^\W_]+(?:['’][^\W_]*)*$")  # "DON'" in "*DON'*T" still ends mid-word
_WORD_HEAD_RE = re.compile(r"(?:['’]?[^\W_]+)+")


@dataclass(frozen=True)
class Piece:
    """A run of chunk text (markers removed) with one throw state."""

    text: str
    throw: bool = False


@dataclass(frozen=True)
class Chunk:
    index: int
    text: str  # original chunk text including markup, e.g. "EXPECT *US*"
    pieces: tuple[Piece, ...]  # whitespace-collapsed, markers removed; "".join(texts) == clean text
    beat_break: bool = False  # followed by '|'
    pause_after_s: float = 0.0
    pause_after_beats: float = 0.0
    line_break: bool = False  # followed by a newline (a natural gap; not a contract flag)

    @property
    def throw(self) -> bool:
        return any(p.throw for p in self.pieces)

    @property
    def clean_text(self) -> str:
        return "".join(p.text for p in self.pieces)

    def pause_seconds(self, bpm: float) -> float:
        return self.pause_after_s + self.pause_after_beats * 60.0 / bpm


@dataclass(frozen=True)
class Script:
    source: str
    chunks: tuple[Chunk, ...]
    warnings: tuple[str, ...] = ()

    @property
    def segment_count(self) -> int:
        return len(self.chunks)


# -- lexer --------------------------------------------------------------------------------------
_TEXT, _BAR, _PAUSE, _STAR, _NEWLINE = "text", "bar", "pause", "star", "newline"


@dataclass
class _Tok:
    kind: str
    start: int
    end: int
    text: str = ""
    pause: tuple[float, float] = (0.0, 0.0)  # (seconds, beats)


def _pause_from_match(m: re.Match[str]) -> tuple[float, float]:
    value = Fraction(m.group("num"))
    if m.group("den"):
        value /= int(m.group("den"))  # ZeroDivisionError handled by the caller
    unit = (m.group("unit") or "s").lower()
    if unit.startswith("b"):
        return 0.0, float(value)
    if unit == "ms":
        return float(value) / 1000.0, 0.0
    return float(value), 0.0


def _lex(src: str, warnings: list[str]) -> list[_Tok]:
    toks: list[_Tok] = []
    buf: list[str] = []
    buf_start = 0

    def flush(at: int) -> None:
        if buf:
            toks.append(_Tok(_TEXT, buf_start, at, "".join(buf)))
            buf.clear()

    def add_char(c: str, at: int) -> None:
        nonlocal buf_start
        if not buf:
            buf_start = at
        buf.append(c)

    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c == "\\" and i + 1 < n and src[i + 1] in "|*[]\\":
            add_char(src[i + 1], i)
            i += 2
            continue
        if c in "|*\n":
            flush(i)
            toks.append(_Tok({"|": _BAR, "*": _STAR, "\n": _NEWLINE}[c], i, i + 1))
            i += 1
            continue
        if c == "[":
            m = PAUSE_RE.match(src, i)
            if m:
                flush(i)
                try:
                    toks.append(_Tok(_PAUSE, i, m.end(), pause=_pause_from_match(m)))
                except ZeroDivisionError:
                    warnings.append(f"Ignored pause {m.group(0)!r}: division by zero.")
                i = m.end()
                continue
            close = src.find("]", i + 1)
            if close != -1 and "\n" not in src[i:close]:
                warnings.append(f"Ignored unknown tag {src[i:close + 1]!r}.")
                add_char(" ", i)
                i = close + 1
                continue
        add_char(c, i)
        i += 1
    flush(n)

    stars = [k for k, t in enumerate(toks) if t.kind == _STAR]
    if len(stars) % 2:
        warnings.append("Ignored an unmatched '*'.")
        toks[stars[-1]] = _Tok(_TEXT, toks[stars[-1]].start, toks[stars[-1]].end, "")
    return toks


# -- parser -------------------------------------------------------------------------------------
def _speakable(text: str) -> bool:
    return bool(_ALNUM_RE.search(text))


def _pieces(raw: list[tuple[str, bool]]) -> tuple[Piece, ...]:
    """Collapse whitespace across the chunk, trim its ends, and merge runs that share a throw state.
    Punctuation/space-only runs join the run before them so a throw doesn't start on ", "."""
    runs: list[list] = []
    for text, throw in raw:
        text = _WS_RE.sub(" ", text)
        if runs and runs[-1][0].endswith(" ") and text.startswith(" "):
            text = text[1:]
        if not text:
            continue
        if runs and (runs[-1][1] == throw or not _speakable(text)):
            runs[-1][0] += text
        else:
            runs.append([text, throw])
    if not runs:
        return ()
    runs[0][0] = runs[0][0].lstrip()
    runs[-1][0] = runs[-1][0].rstrip()
    runs = [r for r in runs if r[0]]
    merged: list[list] = []
    for text, throw in runs:
        if merged and merged[-1][1] == throw:
            merged[-1][0] += text
        else:
            merged.append([text, throw])
    # A throw mark inside a word ("*FV*WKS") throws the whole word: splitting it would also hide it from the
    # lexicon (FVWKS -> "Fawkes") and make TTS read two fragments.
    for k in range(len(merged) - 1):
        a, b = merged[k], merged[k + 1]
        tail, head = _WORD_TAIL_RE.search(a[0]), _WORD_HEAD_RE.match(b[0])
        if not (tail and head):
            continue
        if a[1]:  # the throw piece takes the rest of the word
            a[0], b[0] = a[0] + head.group(0), b[0][head.end():]
        else:
            a[0], b[0] = a[0][:tail.start()], tail.group(0) + b[0]
    return tuple(Piece(t, th) for t, th in merged if t)


def parse(script: str) -> Script:
    """Parse markup into chunks. Only a too-long script or pause raises; the rest is lenient."""
    if len(script) > MAX_SCRIPT_CHARS:
        raise VoiceError("script_too_long", f"The script has {len(script)} characters; the limit is "
                         f"{MAX_SCRIPT_CHARS}.", "Split it into several lines in the Setlist.")
    src = script.replace("\r\n", "\n").replace("\r", "\n")
    warnings: list[str] = []
    toks = _lex(src, warnings)

    # Group into candidate chunks: runs of TEXT/STAR tokens, separated by break tokens.
    chunks: list[dict] = []
    cur: dict | None = None
    throw = False
    lead_pause = False
    for t in toks:
        if t.kind in (_TEXT, _STAR):
            if t.kind == _STAR:
                throw = not throw
            if cur is None:
                cur = {"raw": [], "start": t.start, "end": t.end, "breaks": []}
            cur["end"] = t.end
            if t.kind == _TEXT:
                cur["raw"].append((t.text, throw))
            continue
        # A break token. Close the current chunk; unspeakable chunks vanish and pass their breaks on.
        if cur is not None:
            pieces = _pieces(cur["raw"])
            if pieces and _speakable("".join(p.text for p in pieces)):
                cur["pieces"] = pieces
                chunks.append(cur)
            cur = None
        if chunks:
            chunks[-1]["breaks"].append(t)
        elif t.kind == _PAUSE:
            lead_pause = True
    if cur is not None:
        pieces = _pieces(cur["raw"])
        if pieces and _speakable("".join(p.text for p in pieces)):
            cur["pieces"] = pieces
            chunks.append(cur)
    if lead_pause:
        warnings.append("Ignored a pause before the first words; use ARRANGE's first-word beat for pre-roll.")

    out: list[Chunk] = []
    for i, c in enumerate(chunks):
        breaks = c["breaks"]
        secs = sum(b.pause[0] for b in breaks if b.kind == _PAUSE)
        beats = sum(b.pause[1] for b in breaks if b.kind == _PAUSE)
        if secs > MAX_PAUSE_S or beats > MAX_PAUSE_BEATS:
            raise VoiceError("pause_too_long", "A pause in the script is too long.",
                             f"Keep pauses under {MAX_PAUSE_S:.0f} s or {MAX_PAUSE_BEATS:.0f} beats.")
        out.append(Chunk(
            index=i,
            text=src[c["start"]:c["end"]].strip(),
            pieces=c["pieces"],
            beat_break=any(b.kind == _BAR for b in breaks),
            pause_after_s=round(secs, 6),
            pause_after_beats=round(beats, 6),
            line_break=any(b.kind == _NEWLINE for b in breaks),
        ))
    return Script(script, tuple(out), tuple(warnings))


# -- text for TTS -------------------------------------------------------------------------------
@dataclass(frozen=True)
class SpokenChunk:
    say: str  # lexicon + ALL-CAPS rule applied: what markup_cases.json calls "say"
    plain: str  # TTS text as the tokenizer sees it (sentence case, closing period); offsets refer here
    g2p: str  # `plain` plus misaki phoneme links from the lexicon; this is what Kokoro receives
    spans: tuple[tuple[int, int], ...]  # per piece: [start, end) in `plain`


def _capitalize_first_letter(text: str) -> str:
    for i, c in enumerate(text):  # a leading phoneme link "[text](/../)" holds the first letter
        if c.isdigit():
            return text
        if c.isalpha():
            return text[:i] + c.upper() + text[i + 1:] if c.islower() else text
    return text


def speak_chunk(chunk: Chunk, lexicon: Lexicon, *, sentence: bool = True) -> SpokenChunk:
    """Lexicon + ALL-CAPS rule per piece. With `sentence`, also capitalize the first letter and close
    with a period when the chunk has no end punctuation: Kokoro ends an isolated phrase more cleanly."""
    plain_parts: list[str] = []
    g2p_parts: list[str] = []
    spans: list[tuple[int, int]] = []
    pos = 0
    for piece in chunk.pieces:
        sp = lexicon.speak(piece.text)
        spans.append((pos, pos + len(sp.plain)))
        plain_parts.append(sp.plain)
        g2p_parts.append(sp.g2p)
        pos += len(sp.plain)
    plain = "".join(plain_parts)
    g2p = "".join(g2p_parts)
    say = g2p
    if sentence:
        plain = _capitalize_first_letter(plain)
        g2p = _capitalize_first_letter(g2p)
        end = plain.rstrip(CLOSERS)
        if not end.endswith(tuple(TERMINAL_PUNCT + CONTINUING_PUNCT)):
            plain += "."
            g2p += "."
    return SpokenChunk(say, plain, g2p, tuple(spans))
