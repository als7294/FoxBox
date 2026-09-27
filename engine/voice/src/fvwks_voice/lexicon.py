"""Pronunciation lexicon: respellings, phoneme overrides and acronyms, plus the ALL-CAPS rule.

Kokoro's G2P (misaki) spells out any word written in capitals, so "EXPECT US" comes out as
"expect U.S.". Words of two or more letters that are entirely upper-case are therefore lower-cased
before TTS, unless the lexicon marks them as acronyms.

Entries are matched whole-word and case-insensitively; multi-word keys ("GUY FVWKS") work too.
A user JSON file overrides the defaults. It may be a bare mapping or wrapped in {"entries": ...}:

    {"entries": {
        "FVWKS": "Fawkes",                 # respelling
        "GIF":   {"phonemes": "ʤˈɪf"},     # misaki phonemes, bypassing G2P
        "DJ":    {"acronym": true},        # keep capitals: spelled "D J"
        "NSA":   null                      # remove a default entry
    }}

A list of {"word", "say", "phonemes", "acronym"} rows (what a table editor produces) is accepted too.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

from fvwks_contracts.models import DEFAULT_LEXICON

from .errors import VoiceError

# A word: letters/digits with optional internal apostrophes ("DON'T", "we're").
WORD_RE = re.compile(r"[^\W_]+(?:['’][^\W_]+)*")
LEXICON_FILENAME = "lexicon.json"
APP_DATA_DIR = Path.home() / "Library" / "Application Support" / "FoxBox"


@dataclass(frozen=True)
class LexEntry:
    say: str | None = None  # respelling fed to TTS, e.g. "Fawkes"
    phonemes: str | None = None  # misaki phonemes, e.g. "fˈɔks"; wins over G2P
    acronym: bool = False  # keep capitals so the letters are spelled out

    def to_obj(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.say:
            out["say"] = self.say
        if self.phonemes:
            out["phonemes"] = self.phonemes
        if self.acronym:
            out["acronym"] = True
        return out




@dataclass(frozen=True)
class Spoken:
    """Text for TTS. `plain` is what the tokenizer sees; `g2p` adds misaki phoneme links."""

    plain: str
    g2p: str


def _norm_key(word: str) -> str:
    return " ".join(word.split()).casefold()


def _is_all_caps_word(word: str) -> bool:
    letters = [c for c in word if c.isalpha()]
    if len(letters) < 2 or any(c.isdigit() for c in word):
        return False
    return all(c.isupper() for c in letters)


def apply_caps_rule(text: str, keep: Iterable[str] = ()) -> str:
    """Lower-case ALL-CAPS words (2+ letters, no digits) except those in `keep` (case-insensitive)."""
    keep_keys = {_norm_key(k) for k in keep}

    def fix(m: re.Match[str]) -> str:
        w = m.group(0)
        if _is_all_caps_word(w) and _norm_key(w) not in keep_keys:
            return w.lower()
        return w

    return WORD_RE.sub(fix, text)


def _parse_entry(word: str, value: Any) -> LexEntry | None:
    if value is None:
        return None
    if isinstance(value, str):
        if not value.strip():
            raise VoiceError("lexicon_invalid", f"Lexicon entry {word!r} has an empty respelling.",
                             "Give a respelling such as \"Fawkes\", or delete the entry.")
        return LexEntry(say=value.strip())
    if isinstance(value, Mapping):
        say = value.get("say")
        phonemes = value.get("phonemes")
        acronym = value.get("acronym", False)
        for name, v in (("say", say), ("phonemes", phonemes)):
            if v is not None and not isinstance(v, str):
                raise VoiceError("lexicon_invalid", f"Lexicon entry {word!r}: {name!r} must be text.")
        if not isinstance(acronym, bool):
            raise VoiceError("lexicon_invalid", f"Lexicon entry {word!r}: 'acronym' must be true or false.")
        phonemes = phonemes.strip().strip("/").strip() if phonemes else None
        if phonemes and any(c in phonemes for c in "[]()"):
            raise VoiceError("lexicon_invalid", f"Lexicon entry {word!r}: phonemes may not contain brackets.")
        entry = LexEntry(say=(say or "").strip() or None, phonemes=phonemes or None, acronym=acronym)
        if not (entry.say or entry.phonemes or entry.acronym):
            raise VoiceError("lexicon_invalid", f"Lexicon entry {word!r} is empty.",
                             "Set 'say', 'phonemes' or 'acronym'.")
        return entry
    raise VoiceError("lexicon_invalid", f"Lexicon entry {word!r} must be text or an object.")


def _iter_entries(obj: Any) -> Iterable[tuple[str, Any]]:
    if isinstance(obj, Mapping) and "entries" in obj and isinstance(obj["entries"], (Mapping, list)):
        obj = obj["entries"]
    if isinstance(obj, Mapping):
        yield from obj.items()
    elif isinstance(obj, list):
        for row in obj:
            if not isinstance(row, Mapping) or not isinstance(row.get("word"), str):
                raise VoiceError("lexicon_invalid", "Each lexicon row needs a 'word'.")
            rest = {k: v for k, v in row.items() if k != "word"}
            yield row["word"], rest
    else:
        raise VoiceError("lexicon_invalid", "The lexicon must be a JSON object or a list of rows.")


def _contract_rows(lexicon: Any) -> list[dict[str, Any]]:
    """fvwks_contracts Lexicon (or its entries) -> rows for Lexicon.update(). `say` in slashes is phonemes;
    an acronym whose `say` is just the word needs no respelling."""
    rows: list[dict[str, Any]] = []
    for e in getattr(lexicon, "entries", lexicon):
        word, say, acronym = (e.word, e.say, e.acronym) if hasattr(e, "word") else (
            e["word"], e.get("say", ""), e.get("acronym", False))
        say = (say or "").strip()
        row: dict[str, Any] = {"word": word, "acronym": bool(acronym)}
        if len(say) > 2 and say.startswith("/") and say.endswith("/"):
            row["phonemes"] = say
        elif say and not (acronym and _norm_key(say) == _norm_key(word)):
            row["say"] = say
        rows.append(row)
    return rows


class Lexicon:
    def __init__(self, entries: Any = None, *, defaults: bool = True) -> None:
        """`defaults` starts from fvwks_contracts' DEFAULT_LEXICON (FVWKS and the acronyms)."""
        self._entries: dict[str, tuple[str, LexEntry]] = {}  # casefolded key -> (display key, entry)
        self._removed: dict[str, str] = {}  # casefolded key -> display key, kept so saves persist removals
        self._pattern: re.Pattern[str] | None = None
        if defaults:
            self.update(_contract_rows(DEFAULT_LEXICON))
        if entries is not None:
            self.update(entries)

    # -- construction -------------------------------------------------------------------------
    @classmethod
    def from_contract(cls, lexicon: Any | None) -> "Lexicon":
        """From fvwks_contracts.models.Lexicon. None -> DEFAULT_LEXICON. A supplied lexicon is the user's complete
        list (deleting FVWKS in the UI really deletes it)."""
        if lexicon is None:
            return cls()
        return cls(_contract_rows(lexicon), defaults=False)

    def to_contract_rows(self) -> list[dict[str, Any]]:
        """Rows for fvwks_contracts.models.Lexicon (builtins excluded)."""
        rows = []
        for display, e in self._entries.values():
            say = f"/{e.phonemes}/" if e.phonemes else (e.say or display)
            rows.append({"word": display, "say": say, "acronym": e.acronym})
        return rows

    @classmethod
    def from_json(cls, path: str | os.PathLike[str], *, defaults: bool = True) -> "Lexicon":
        p = Path(path)
        if not p.exists():
            return cls(defaults=defaults)
        try:
            obj = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            raise VoiceError("lexicon_invalid", f"Could not read the lexicon file: {e}",
                             f"Fix or delete {p}.") from e
        return cls(obj, defaults=defaults)

    def update(self, entries: Any) -> None:
        for word, value in _iter_entries(entries):
            if not isinstance(word, str) or not WORD_RE.search(word):
                raise VoiceError("lexicon_invalid", f"Lexicon key {word!r} contains no word.")
            display = " ".join(word.split())
            entry = _parse_entry(display, value)
            key = _norm_key(display)
            if entry is None:
                self._entries.pop(key, None)
                self._removed[key] = display
            else:
                self._entries[key] = (display, entry)
                self._removed.pop(key, None)
        self._pattern = None

    # -- queries ------------------------------------------------------------------------------
    def lookup(self, word: str) -> LexEntry | None:
        hit = self._entries.get(_norm_key(word))
        return hit[1] if hit else None

    def entries(self) -> dict[str, LexEntry]:
        return {display: entry for display, entry in self._entries.values()}

    def to_obj(self) -> dict[str, Any]:
        out: dict[str, Any] = {display: entry.to_obj() for display, entry in self._entries.values()}
        out.update({display: None for display in self._removed.values()})
        return {"entries": out}

    def __len__(self) -> int:
        return len(self._entries)

    def _regex(self) -> re.Pattern[str] | None:
        if self._pattern is None and self._entries:
            keys = sorted((d for d, _ in self._entries.values()), key=len, reverse=True)
            alts = "|".join(r"\s+".join(re.escape(part) for part in k.split()) for k in keys)
            # Whole words only; an optional possessive rides along ("FVWKS's" -> "Fawkes's").
            self._pattern = re.compile(
                rf"(?<![^\W_])(?P<key>{alts})(?P<poss>['’][sS])?(?![^\W_])", re.IGNORECASE)
        return self._pattern

    # -- transform ----------------------------------------------------------------------------
    def speak(self, text: str) -> Spoken:
        """Apply lexicon entries, then the ALL-CAPS rule to everything else."""
        plain: list[str] = []
        g2p: list[str] = []
        pos = 0
        pattern = self._regex()
        for m in pattern.finditer(text) if pattern else ():
            before = apply_caps_rule(text[pos:m.start()])
            plain.append(before)
            g2p.append(before)
            word = m.group("key")
            entry = self.lookup(word)
            assert entry is not None
            poss = (m.group("poss") or "").lower()
            if entry.acronym:
                said = entry.say or word.upper()
            elif entry.say:
                said = apply_caps_rule(entry.say)
            else:
                said = apply_caps_rule(word)
            plain.append(said + poss)
            if entry.phonemes:
                # misaki link syntax: [text](/phonemes/) replaces G2P for that token.
                g2p.append(f"[{said}](/{entry.phonemes}/){poss}")
            else:
                g2p.append(said + poss)
            pos = m.end()
        tail = apply_caps_rule(text[pos:])
        plain.append(tail)
        g2p.append(tail)
        return Spoken("".join(plain), "".join(g2p))


def user_lexicon_path() -> Path:
    """FVWKS_LEXICON, else $FVWKS_DATA_DIR/lexicon.json, else the app's Application Support folder."""
    if env := os.environ.get("FVWKS_LEXICON"):
        return Path(env).expanduser()
    if env := os.environ.get("FVWKS_DATA_DIR"):
        return Path(env).expanduser() / LEXICON_FILENAME
    return APP_DATA_DIR / LEXICON_FILENAME


_cache: dict[Path, tuple[float, Lexicon]] = {}


def load_user_lexicon(path: str | os.PathLike[str] | None = None) -> Lexicon:
    """Defaults merged with the user's JSON, re-read only when the file changes."""
    p = Path(path) if path is not None else user_lexicon_path()
    try:
        mtime = p.stat().st_mtime
    except OSError:
        return Lexicon()
    hit = _cache.get(p)
    if hit and hit[0] == mtime:
        return hit[1]
    lex = Lexicon.from_json(p)
    _cache[p] = (mtime, lex)
    return lex


def save_user_lexicon(entries: Any, path: str | os.PathLike[str] | None = None) -> Lexicon:
    """Validate and write the user's entries (not the defaults). Returns the merged lexicon."""
    user_only = Lexicon(entries, defaults=False)  # validates
    p = Path(path) if path is not None else user_lexicon_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(user_only.to_obj(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(p)
    _cache.pop(p, None)
    return load_user_lexicon(p)
