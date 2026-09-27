"""Export file writing: the core of ``write_audio`` (owned by S3).

Contract-agnostic on purpose: it takes numpy buffers and plain metadata, so the HTTP layer only adapts
``RenderResult``/``ExportOptions`` to it. Rules from docs/PLAN.md, "Export rules for Rekordbox/CDJs":

- AIFF (default) or WAV at 24-bit, written with soundfile. 16-bit output gets TPDF dither.
- A WAV is integer PCM with fmt tag 0x0001 in a canonical layout: ``fmt `` first (so bytes 20-21 hold the tag),
  then ``data``, then ``LIST/INFO``. CDJs reject WAVE_FORMAT_EXTENSIBLE (0xFFFE) with E-8305, so an extensible
  header from any library is rewritten.
- Tags: ID3v2.3 in AIFF, RIFF INFO in WAV. Rekordbox reads ID3 from AIFF but only RIFF INFO from WAV.
- Filenames come from ``Settings.filename_pattern`` (default
  ``GUYFVWKS_{preset}_{slug}_{bpm}bpm_{bars}bar_{key}_{variant}_v{version:02d}``). All files of one export
  (variants and stems) share the next free version number.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import string
import struct
import threading
import unicodedata
import uuid
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, Iterable, Literal, Sequence

import numpy as np
import soundfile as sf

from .music import format_bpm, key_name

AudioFormat = Literal["aiff", "wav"]

DEFAULT_ARTIST = "GUY FVWKS"
DEFAULT_ALBUM = "FoxBox"
SOFTWARE = "FoxBox"
RENDER_TXXX = "FVWKS_RENDER"  # TXXX description that holds the render parameters as JSON
MAX_CHANNELS = 8

_SF_FORMAT = {"aiff": "AIFF", "wav": "WAV"}
_SF_SUBTYPE = {16: "PCM_16", 24: "PCM_24"}
_KIND = {"aiff": "AIFF File", "wav": "WAV File"}
WAVE_FORMAT_PCM = 0x0001
WAVE_FORMAT_EXTENSIBLE = 0xFFFE

# One engine process writes the export folder. Version numbers are chosen, and the final paths reserved, under this
# lock; encoding happens outside it, so a Setlist export never holds up an interactive one.
_WRITE_LOCK = threading.Lock()
_RESERVED: set[Path] = set()  # final paths some export is writing right now


# --------------------------------------------------------------------------------------------- text helpers

_MARKUP_RX = re.compile(r"\[[^\]]*\]|[|*]")
_PUNCT = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "…": "...", "·": "-",
                        " ": " "})


def strip_markup(script: str) -> str:
    """Drop script markup (``|``, ``[0.5]``, ``[2b]``, ``*throw*``) and collapse whitespace."""
    return " ".join(_MARKUP_RX.sub(" ", script).split())


def ascii_fold(text: str) -> str:
    """Best-effort ASCII (RIFF INFO has no reliable charset): curly quotes, dashes and accents fold down."""
    text = unicodedata.normalize("NFKD", text.translate(_PUNCT))
    return text.encode("ascii", "ignore").decode("ascii")


def slugify(text: str, max_words: int = 4, max_len: int = 32) -> str:
    """``WE ARE GUY FVWKS | EXPECT *US*`` → ``we-are-guy-fvwks``."""
    words = re.findall(r"[a-z0-9]+", ascii_fold(strip_markup(text)).lower().replace("'", ""))
    out: list[str] = []
    for word in words[:max_words]:
        if out and len("-".join([*out, word])) > max_len:
            break
        out.append(word[:max_len])
    return "-".join(out) or "untitled"


def display_title(text: str, max_len: int = 60) -> str:
    title = strip_markup(text)
    if len(title) <= max_len:
        return title or "Untitled"
    cut = title[: max_len - 3].rsplit(" ", 1)[0]
    return f"{cut}..."


def folder_name(text: str, fallback: str = "Setlist") -> str:
    """A safe single folder name (no separators, no leading dots) from a playlist or setlist name."""
    name = re.sub(r"[^A-Za-z0-9 ._-]+", "-", ascii_fold(text))
    name = re.sub(r"\s+", " ", name).strip(" .-_")
    return name[:64].rstrip(" .-_") or fallback


def _token(text: str) -> str:
    return re.sub(r"-{2,}", "-", re.sub(r"[^A-Za-z0-9#-]+", "-", ascii_fold(text))).strip("-")


def artist_token(artist: str) -> str:
    """``GUY FVWKS`` → ``GUYFVWKS``."""
    return re.sub(r"[^A-Za-z0-9]+", "", ascii_fold(artist)).upper()


def variant_token(variant: str) -> str:
    """``wet``, ``dry``, ``alt:LEGION`` → ``alt-LEGION``, ``stem:sub`` → ``stem-sub``."""
    kind, _, arg = variant.partition(":")
    kind = _token(kind).lower()
    if not kind:
        raise ValueError(f"bad variant: {variant!r}")
    if not arg:
        return kind
    arg = _token(arg)
    return f"{kind}-{arg.upper() if kind == 'alt' else arg.lower()}"


def safe_path(root: Path, *parts: str) -> Path:
    """Join ``parts`` under ``root`` and refuse anything that resolves outside it."""
    base = Path(root).resolve()
    candidate = base.joinpath(*parts).resolve()
    if candidate != base and base not in candidate.parents:
        raise ValueError("path escapes the export root")
    return candidate


# ------------------------------------------------------------------------------------------------- naming


DEFAULT_PATTERN = "GUYFVWKS_{preset}_{slug}_{bpm}bpm_{bars}bar_{key}_{variant}_v{version:02d}"
PATTERN_FIELDS = frozenset({"artist", "preset", "slug", "bpm", "bars", "key", "variant", "version"})
_VARIANT_MARK, _VERSION_MARK = "V", "N"


class _Mark(str):
    """Placeholder that ignores format specs (so ``{version:02d}`` can hold a regex marker)."""


class _PatternFormatter(string.Formatter):
    def get_value(self, key, args, kwargs):
        if not isinstance(key, str) or key not in PATTERN_FIELDS:
            raise ValueError(f"unknown filename field {{{key}}}; use {sorted(PATTERN_FIELDS)}")
        return kwargs[key]

    def format_field(self, value, format_spec):
        return str(value) if isinstance(value, _Mark) else super().format_field(value, format_spec)


_FORMATTER = _PatternFormatter()


def _tidy(name: str) -> str:
    """Filesystem-safe name: no separators, FREE bars read ``free``, no doubled or dangling underscores."""
    name = re.sub(r"[/\\:\x00-\x1f]+", "-", name).replace("freebar", "free")
    return re.sub(r"_{2,}", "_", name).strip(" ._-")


def validate_pattern(pattern: str) -> str:
    """Check a user filename pattern: known fields only, and ``{variant}`` + ``{version}`` so files never clash."""
    fields = {f for _, f, _, _ in string.Formatter().parse(pattern) if f is not None}
    if not {"variant", "version"} <= fields:
        raise ValueError("filename pattern must contain {variant} and {version}")
    FileNaming("PACT", "slug", 140, 4, "Am", pattern=pattern).filename("wet", 1, "aiff")  # raises on bad fields/specs
    return pattern


@dataclass(frozen=True)
class FileNaming:
    preset: str
    slug: str
    bpm: float | None = None
    bars: int | None = None
    key: str | None = None  # any accepted spelling; normalised to "Am", "F#m", ...
    artist: str = DEFAULT_ARTIST
    pattern: str = DEFAULT_PATTERN

    def _fields(self) -> dict[str, Any]:
        return {
            "artist": artist_token(self.artist) or "VOICEBOX",
            "preset": _token(self.preset).upper() or "RAW",
            "slug": self.slug,
            "bpm": format_bpm(self.bpm) if self.bpm else "",
            "bars": str(int(self.bars)) if self.bars else "free",
            "key": key_name(self.key) or "",
        }

    def stem(self, variant: str, version: int) -> str:
        return _tidy(_FORMATTER.format(self.pattern, **self._fields(), variant=variant_token(variant),
                                       version=int(version)))

    def filename(self, variant: str, version: int, fmt: AudioFormat) -> str:
        return f"{self.stem(variant, version)}.{fmt}"

    def version_regex(self) -> re.Pattern[str]:
        """Matches this export's files for any variant and format; group 1 is the version number."""
        marked = _tidy(_FORMATTER.format(self.pattern, **self._fields(), variant=_Mark(_VARIANT_MARK),
                                         version=_Mark(_VERSION_MARK)))
        rx = re.escape(marked).replace(_VARIANT_MARK, r"[A-Za-z0-9#-]+").replace(_VERSION_MARK, r"(\d+)")
        return re.compile(rx + r"\.(?:aiff?|wav)$", re.IGNORECASE)


def next_version(directory: Path, naming: FileNaming, taken: Iterable[str] = ()) -> int:
    """1 + the highest version any variant of this export uses in ``directory`` (or in ``taken`` file names)."""
    rx = naming.version_regex()
    names = list(taken)
    if Path(directory).is_dir():
        names += [entry.name for entry in os.scandir(directory)]
    return 1 + max((int(m.group(1)) for m in map(rx.match, names) if m), default=0)


# ------------------------------------------------------------------------------------------------- audio


def to_frames(audio: np.ndarray, channels: int | None = 2) -> np.ndarray:
    """Return float64 ``[n, ch]`` for soundfile.

    Accepts fvwks_fx's channels-first ``[ch, n]`` and 1-D mono (``[n, ch]`` too when unambiguous).
    Mono is duplicated when ``channels`` is 2. NaN/Inf raise instead of reaching a file.
    """
    a = np.asarray(audio)
    if a.ndim == 1:
        a = a[:, None]
    elif a.ndim == 2:
        if a.shape[0] <= MAX_CHANNELS and a.shape[0] < a.shape[1]:
            a = a.T
    else:
        raise ValueError(f"audio must be 1-D or 2-D, got shape {a.shape}")
    if a.shape[0] == 0:
        raise ValueError("audio is empty")
    if not np.isfinite(a).all():
        raise ValueError("audio contains NaN or Inf")
    if channels and a.shape[1] != channels:
        if a.shape[1] == 1:
            a = np.repeat(a, channels, axis=1)
        else:
            raise ValueError(f"expected {channels} channel(s), got {a.shape[1]}")
    return np.ascontiguousarray(a, dtype=np.float64)


def quantize(frames: np.ndarray, bit_depth: int, rng: np.random.Generator | None = None) -> tuple[np.ndarray, int]:
    """Float [-1, 1) → integer PCM that soundfile writes verbatim. Returns (pcm, clipped sample count).

    16-bit adds TPDF dither (two uniform variables, ±1 LSB peak) when ``rng`` is given. 24-bit is rounded and
    returned left-aligned in int32, which libsndfile's PCM_24 writer truncates back to the top 24 bits.
    """
    if bit_depth == 16:
        scaled = frames * 32768.0
        if rng is not None:
            scaled = scaled + (rng.random(scaled.shape) - rng.random(scaled.shape))
        lo, hi, dtype, shift = -32768, 32767, np.int16, 0
    elif bit_depth == 24:
        scaled = frames * 8388608.0
        lo, hi, dtype, shift = -8388608, 8388607, np.int32, 8
    else:
        raise ValueError(f"bit depth must be 16 or 24, got {bit_depth}")
    q = np.floor(scaled + 0.5)
    clipped = int(np.count_nonzero((q < lo) | (q > hi)))
    pcm = np.clip(q, lo, hi).astype(dtype)
    return (pcm << shift if shift else pcm), clipped


def _seeded_rng(seed: str) -> np.random.Generator:
    """Deterministic dither per file name, so re-exporting identical audio gives identical bytes."""
    return np.random.default_rng(int.from_bytes(hashlib.sha256(seed.encode()).digest()[:8], "little"))


# ------------------------------------------------------------------------------------------------- tags


@dataclass
class TrackTags:
    title: str
    artist: str = DEFAULT_ARTIST
    album: str | None = DEFAULT_ALBUM
    bpm: float | None = None
    key: str | None = None
    script: str = ""
    preset: str = ""
    render_params: dict[str, Any] | None = None
    year: int | None = None
    created: str | None = None  # ISO date for RIFF ICRD; defaults to today
    software: str = SOFTWARE

    def comment(self) -> str:
        """COMM text: preset and script, e.g. ``[PACT] WE ARE GUY FVWKS | EXPECT *US*``."""
        preset = f"[{self.preset}] " if self.preset else ""
        return f"{preset}{self.script}".strip()


def riff_info_fields(tags: TrackTags) -> dict[str, str]:
    """RIFF INFO subchunks. WAV has no BPM/key fields, so they ride along in the comment."""
    musical = ", ".join(x for x in (f"{format_bpm(tags.bpm)} BPM" if tags.bpm else "", key_name(tags.key) or "") if x)
    comment = tags.comment() + (f" ({musical})" if musical else "")
    fields = {
        "INAM": tags.title,
        "IART": tags.artist,
        "IPRD": tags.album or "",
        "ICMT": comment,
        "ICRD": tags.created or date.today().isoformat(),
        "ISFT": tags.software,
    }
    return {k: v for k, v in fields.items() if v}


def build_info_chunk(fields: dict[str, str]) -> bytes:
    body = bytearray(b"INFO")
    for cid, text in fields.items():
        if len(cid) != 4:
            raise ValueError(f"INFO id must be 4 characters: {cid!r}")
        data = ascii_fold(text).encode("ascii") + b"\x00"
        body += cid.encode("ascii") + struct.pack("<I", len(data)) + data
        if len(data) % 2:
            body += b"\x00"
    return b"LIST" + struct.pack("<I", len(body)) + bytes(body)


def tag_aiff(path: Path, tags: TrackTags) -> None:
    """Write an ID3v2.3 chunk into an AIFF (TIT2, TPE1, TALB, TBPM, TKEY, COMM, TXXX, TDRC→TYER, TSSE)."""
    from mutagen.aiff import AIFF
    from mutagen.id3 import COMM, TALB, TBPM, TDRC, TIT2, TKEY, TPE1, TSSE, TXXX

    audio = AIFF(str(path))
    if audio.tags is None:
        audio.add_tags()
    t = audio.tags
    t.add(TIT2(encoding=3, text=[tags.title]))
    t.add(TPE1(encoding=3, text=[tags.artist]))
    if tags.album:
        t.add(TALB(encoding=3, text=[tags.album]))
    if tags.bpm:
        t.add(TBPM(encoding=3, text=[format_bpm(tags.bpm)]))
    key = key_name(tags.key)
    if key:
        t.add(TKEY(encoding=3, text=[key]))
    t.add(COMM(encoding=3, lang="eng", desc="", text=[tags.comment()]))
    if tags.render_params is not None:
        t.add(TXXX(encoding=3, desc=RENDER_TXXX, text=[canonical_json(tags.render_params)]))
    t.add(TDRC(encoding=3, text=[str(tags.year or date.today().year)]))
    t.add(TSSE(encoding=3, text=[tags.software]))
    t.update_to_v23()
    audio.save(v2_version=3)


def canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


# ------------------------------------------------------------------------------------------------- RIFF


def iter_riff_chunks(raw: bytes, start: int = 12):
    """Yield (id, offset of body, body size) for top-level chunks after the RIFF/WAVE header."""
    pos = start
    while pos + 8 <= len(raw):
        cid = raw[pos : pos + 4]
        size = struct.unpack_from("<I", raw, pos + 4)[0]
        yield cid, pos + 8, size
        pos += 8 + size + (size & 1)


def wav_format_tag(path: Path) -> int:
    """The WAVE format tag at bytes 20-21 (little-endian). 0x0001 = integer PCM."""
    with open(path, "rb") as fh:
        head = fh.read(22)
    if head[:4] != b"RIFF" or head[8:12] != b"WAVE" or head[12:16] != b"fmt ":
        raise ValueError("not a canonical WAV (fmt must be the first chunk)")
    return struct.unpack_from("<H", head, 20)[0]


def normalize_wav(path: Path, info: dict[str, str] | None = None) -> None:
    """Rewrite a WAV as RIFF/WAVE: 16-byte PCM ``fmt `` (tag 0x0001), ``data``, then optional LIST/INFO.

    Converts WAVE_FORMAT_EXTENSIBLE headers whose subformat is integer PCM; refuses float or compressed
    audio. Other chunks (fact, PEAK, junk) are dropped.
    """
    raw = Path(path).read_bytes()
    if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise ValueError("not a RIFF/WAVE file")
    fmt = data = None
    for cid, off, size in iter_riff_chunks(raw):
        if cid == b"fmt " and fmt is None:
            fmt = raw[off : off + size]
        elif cid == b"data" and data is None:
            data = raw[off : off + size]
    if fmt is None or data is None:
        raise ValueError("WAV lacks fmt or data chunk")
    tag, channels, rate, _, _, bits = struct.unpack_from("<HHIIHH", fmt, 0)
    if tag == WAVE_FORMAT_EXTENSIBLE:
        if len(fmt) < 40:
            raise ValueError("truncated WAVE_FORMAT_EXTENSIBLE header")
        valid_bits = struct.unpack_from("<H", fmt, 18)[0]
        subformat = struct.unpack_from("<H", fmt, 24)[0]
        if subformat != WAVE_FORMAT_PCM:
            raise ValueError(f"extensible WAV subformat 0x{subformat:04x} is not integer PCM")
        if valid_bits not in (0, bits):
            raise ValueError(f"{valid_bits} valid bits in a {bits}-bit container cannot be plain PCM")
    elif tag != WAVE_FORMAT_PCM:
        raise ValueError(f"WAV must be integer PCM, got format tag 0x{tag:04x}")
    if bits not in (8, 16, 24, 32):
        raise ValueError(f"unsupported bit depth {bits}")
    block = channels * bits // 8
    out = bytearray(b"fmt ")
    out += struct.pack("<IHHIIHH", 16, WAVE_FORMAT_PCM, channels, rate, rate * block, block, bits)
    out += b"data" + struct.pack("<I", len(data)) + data
    if len(data) % 2:
        out += b"\x00"
    if info:
        out += build_info_chunk(info)
    Path(path).write_bytes(b"RIFF" + struct.pack("<I", 4 + len(out)) + b"WAVE" + bytes(out))


def read_riff_info(path: Path) -> dict[str, str]:
    raw = Path(path).read_bytes()
    fields: dict[str, str] = {}
    for cid, off, size in iter_riff_chunks(raw):
        if cid == b"LIST" and raw[off : off + 4] == b"INFO":
            for sub, soff, ssize in iter_riff_chunks(raw[off : off + size], start=4):
                fields[sub.decode("ascii", "replace")] = raw[off + soff : off + soff + ssize].rstrip(b"\x00").decode(
                    "utf-8", "replace"
                )
    return fields


def read_tags(path: Path) -> dict[str, Any]:
    """Tags as written, for verification and the library: ID3 frames for AIFF, RIFF INFO for WAV."""
    path = Path(path)
    if path.suffix.lower() == ".wav":
        return {"format": "wav", "info": read_riff_info(path)}
    from mutagen.aiff import AIFF

    audio = AIFF(str(path))
    frames: dict[str, Any] = {}
    if audio.tags is not None:
        for frame_id, frame in audio.tags.items():
            frames[frame_id] = list(getattr(frame, "text", [])) if hasattr(frame, "text") else str(frame)
        frames["_version"] = audio.tags.version
    return {"format": "aiff", "id3": frames}


# ------------------------------------------------------------------------------------------------- writing


@dataclass
class TrackFile:
    path: Path
    format: AudioFormat
    sample_rate: int
    bit_depth: int
    channels: int
    frames: int
    bytes: int
    clipped_samples: int

    @property
    def duration_s(self) -> float:
        return self.frames / self.sample_rate

    @property
    def kind(self) -> str:
        return _KIND[self.format]


def write_track(
    path: Path,
    audio: np.ndarray,
    sample_rate: int,
    *,
    fmt: AudioFormat = "aiff",
    bit_depth: int = 24,
    tags: TrackTags | None = None,
    channels: int | None = 2,
    dither_seed: str | None = None,
) -> TrackFile:
    """Encode, tag and verify one file at ``path`` (written in place; callers stage via a temp name)."""
    if fmt not in _SF_FORMAT:
        raise ValueError(f"format must be aiff or wav, got {fmt!r}")
    path = Path(path)
    frames = to_frames(audio, channels)
    rng = _seeded_rng(dither_seed or path.name) if bit_depth == 16 else None
    pcm, clipped = quantize(frames, bit_depth, rng)
    sf.write(path, pcm, int(sample_rate), subtype=_SF_SUBTYPE[bit_depth], format=_SF_FORMAT[fmt])
    if fmt == "wav":
        normalize_wav(path, riff_info_fields(tags) if tags else None)
        if wav_format_tag(path) != WAVE_FORMAT_PCM:
            raise RuntimeError("WAV header is not integer PCM (0x0001)")
    elif tags:
        tag_aiff(path, tags)
    info = sf.info(str(path))
    if info.frames != frames.shape[0] or info.samplerate != int(sample_rate):
        raise RuntimeError(f"wrote {info.frames} frames @ {info.samplerate} Hz, expected {frames.shape[0]}")
    return TrackFile(path, fmt, int(sample_rate), bit_depth, frames.shape[1], frames.shape[0],
                     path.stat().st_size, clipped)


@dataclass
class ExportItem:
    variant: str  # "wet" | "dry" | "alt:<PRESET>" | "stem:<name>"
    audio: np.ndarray
    sample_rate: int
    preset: str | None = None  # alt variants carry their own preset
    render_params: dict[str, Any] | None = None


@dataclass
class ExportMeta:
    script: str
    preset: str
    bpm: float | None = None
    bars: int | None = None
    key: str | None = None
    name: str | None = None  # user-chosen export name; replaces the script as title and slug source
    artist: str = DEFAULT_ARTIST
    album: str | None = DEFAULT_ALBUM
    render_params: dict[str, Any] = field(default_factory=dict)
    pattern: str = DEFAULT_PATTERN


@dataclass
class WrittenFile(TrackFile):
    filename: str = ""
    variant: str = "wet"
    version: int = 1
    title: str = ""


def _item_label(meta: ExportMeta, item: ExportItem) -> tuple[str, str]:
    """(preset for tags, label for the title) of one item."""
    kind, _, arg = item.variant.partition(":")
    preset = item.preset or (arg.upper() if kind == "alt" and arg else meta.preset)
    if kind == "wet" or kind == "alt":
        return preset, preset
    if kind == "stem":
        return preset, f"{preset} stem {arg}".strip()
    return preset, f"{preset} {kind}"


def export_files(
    directory: Path,
    meta: ExportMeta,
    items: Sequence[ExportItem],
    *,
    fmt: AudioFormat = "aiff",
    bit_depth: int = 24,
    channels: int | None = 2,
) -> list[WrittenFile]:
    """Write one export (its variants and stems) into ``directory`` under a shared new version number.

    Files are staged under hidden temp names and renamed only when all of them encoded and verified, so
    Finder/Rekordbox never see half-written drops.
    """
    if not items:
        raise ValueError("nothing to export")
    tokens = [variant_token(i.variant) for i in items]
    if len(set(tokens)) != len(tokens):
        raise ValueError(f"duplicate variants: {tokens}")
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    directory = directory.resolve()  # reservations compare paths
    naming = FileNaming(meta.preset, slugify(meta.name or meta.script), meta.bpm, meta.bars, meta.key, meta.artist,
                        meta.pattern)
    base_title = display_title(meta.name or meta.script)
    with _WRITE_LOCK:
        reserved_here = [p.name for p in _RESERVED if p.parent == directory]
        version = next_version(directory, naming, reserved_here)
        while any((p := directory / naming.filename(i.variant, version, fmt)).exists() or p in _RESERVED
                  for i in items):
            version += 1
        finals = [directory / naming.filename(i.variant, version, fmt) for i in items]
        _RESERVED.update(finals)
    temps: list[Path] = []
    written: list[WrittenFile] = []
    try:
        for item in items:
            filename = naming.filename(item.variant, version, fmt)
            preset, label = _item_label(meta, item)
            title = f"{base_title} ({label} v{version:02d})"
            params = {
                "variant": item.variant, "version": version, "preset": preset, "script": meta.script,
                "bpm": meta.bpm, "bars": meta.bars, "key": key_name(meta.key),
                "render": item.render_params if item.render_params is not None else meta.render_params,
            }
            tags = TrackTags(title=title, artist=meta.artist, album=meta.album, bpm=meta.bpm, key=meta.key,
                             script=meta.script, preset=preset if item.variant == "wet" else label,
                             render_params=params)
            temps.append(directory / f".{filename}.{uuid.uuid4().hex[:8]}.part")
            track = write_track(temps[-1], item.audio, item.sample_rate, fmt=fmt, bit_depth=bit_depth,
                                tags=tags, channels=channels, dither_seed=filename)
            written.append(WrittenFile(**{**track.__dict__, "path": directory / filename}, filename=filename,
                                       variant=item.variant, version=version, title=title))
        for tmp, out in zip(temps, written):
            os.replace(tmp, out.path)
    except BaseException:
        for tmp in temps:
            tmp.unlink(missing_ok=True)
        raise
    finally:
        with _WRITE_LOCK:
            _RESERVED.difference_update(finals)
    return written
