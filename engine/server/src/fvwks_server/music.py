"""Musical helpers shared by the file writer and rekordbox.xml: keys, BPM text, bar lengths."""
from __future__ import annotations

import re
from dataclasses import dataclass

# Camelot-wheel names, which is also Rekordbox's "classic" key notation.
_MAJOR_NAMES = ("C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")
_MINOR_NAMES = ("Cm", "Dbm", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "Abm", "Am", "Bbm", "Bm")
# Camelot number by pitch class (A = minor, B = major).
_CAMELOT_MINOR = {8: 1, 3: 2, 10: 3, 5: 4, 0: 5, 7: 6, 2: 7, 9: 8, 4: 9, 11: 10, 6: 11, 1: 12}
_CAMELOT_MAJOR = {11: 1, 6: 2, 1: 3, 8: 4, 3: 5, 10: 6, 5: 7, 0: 8, 7: 9, 2: 10, 9: 11, 4: 12}
_NOTE_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

_NOTE_RX = re.compile(
    r"^(?P<note>[A-Ga-g])\s*(?P<acc>#|b|♯|♭|sharp|flat)?[\s_-]*(?P<mode>m|M|min|minor|maj|major)?$", re.IGNORECASE
)
_CAMELOT_RX = re.compile(r"^(?P<num>1[0-2]|[1-9])\s*(?P<letter>[ABab])$")
_OFF_KEY = {"", "o", "off", "none", "-", "nokey", "atonal"}


@dataclass(frozen=True)
class MusicalKey:
    pitch_class: int  # 0 = C
    minor: bool

    @property
    def name(self) -> str:
        """Rekordbox Tonality / ID3 TKEY / filename token, e.g. ``Am``, ``F#m``, ``Bb``."""
        return (_MINOR_NAMES if self.minor else _MAJOR_NAMES)[self.pitch_class]

    @property
    def camelot(self) -> str:
        table = _CAMELOT_MINOR if self.minor else _CAMELOT_MAJOR
        return f"{table[self.pitch_class]}{'A' if self.minor else 'B'}"

    @property
    def root_name(self) -> str:
        return _MAJOR_NAMES[self.pitch_class]


def parse_key(text: str | None) -> MusicalKey | None:
    """Parse ``Am``, ``A minor``, ``F#m``, ``Gb major``, ``bbm``, ``8A`` (Camelot) and friends.

    Returns None for "no key" spellings; raises ValueError for anything else.
    """
    if text is None:
        return None
    raw = text.strip()
    if raw.lower() in _OFF_KEY:
        return None
    m = _CAMELOT_RX.match(raw)
    if m:
        num, minor = int(m["num"]), m["letter"].upper() == "A"
        table = _CAMELOT_MINOR if minor else _CAMELOT_MAJOR
        pc = next(p for p, n in table.items() if n == num)
        return MusicalKey(pc, minor)
    m = _NOTE_RX.match(raw)
    if not m:
        raise ValueError(f"unrecognised key: {text!r}")
    pc = _NOTE_PC[m["note"].upper()]
    acc = (m["acc"] or "").lower()
    if acc in ("#", "♯", "sharp"):
        pc += 1
    elif acc in ("b", "♭", "flat"):
        pc -= 1
    mode = m["mode"] or ""
    # A bare "m" is minor and a bare "M" is major, as in chord symbols; words are case-insensitive.
    minor = mode == "m" or mode.lower() in ("min", "minor")
    return MusicalKey(pc % 12, minor)


def key_name(text: str | None) -> str | None:
    """Normalise any accepted key spelling to its Rekordbox name, or None."""
    key = parse_key(text)
    return key.name if key else None


def format_bpm(bpm: float) -> str:
    """``140`` for whole tempos, otherwise up to two decimals (``128.5``)."""
    return f"{round(float(bpm), 2):g}"


def bar_seconds(bpm: float, beats_per_bar: int = 4) -> float:
    """One bar of 4/4 lasts 240/BPM seconds."""
    return 60.0 * beats_per_bar / float(bpm)
