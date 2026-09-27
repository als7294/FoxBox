"""Keys, notes, scales and tempo helpers."""

from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np

_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
# Camelot wheel: number -> (minor root pc, major root pc)
_CAMELOT = {
    1: (8, 11), 2: (3, 6), 3: (10, 1), 4: (5, 8), 5: (0, 3), 6: (7, 10),
    7: (2, 5), 8: (9, 0), 9: (4, 7), 10: (11, 2), 11: (6, 9), 12: (1, 4),
}
MINOR_STEPS = (0, 2, 3, 5, 7, 8, 10)
MAJOR_STEPS = (0, 2, 4, 5, 7, 9, 11)


@dataclass(frozen=True)
class Key:
    root_pc: int  # 0 = C
    minor: bool

    @property
    def scale(self) -> tuple[int, ...]:
        steps = MINOR_STEPS if self.minor else MAJOR_STEPS
        return tuple(sorted((self.root_pc + s) % 12 for s in steps))

    @property
    def name(self) -> str:
        return _NAMES[self.root_pc] + ("m" if self.minor else "")

    def triad(self) -> tuple[int, int, int]:
        """Semitone offsets of the tonic triad."""
        return (0, 3 if self.minor else 4, 7)


def parse_key(key: str | None) -> Key:
    """Parse "Am", "A minor", "F#m", "Bbmaj", "C", Camelot "8A"/"8B". Defaults to A minor."""
    if not key:
        return Key(9, True)
    s = str(key).strip()
    cam = re.fullmatch(r"(\d{1,2})\s*([ABab])", s)
    if cam:
        num = int(cam.group(1))
        if num in _CAMELOT:
            mi, ma = _CAMELOT[num]
            return Key(mi, True) if cam.group(2).upper() == "A" else Key(ma, False)
    m = re.fullmatch(r"([A-Ga-g])\s*([#♯b♭]?)\s*(.*)", s)
    if not m:
        return Key(9, True)
    pc = _PC[m.group(1).upper()]
    acc = m.group(2)
    if acc in ("#", "♯"):
        pc += 1
    elif acc in ("b", "♭"):
        pc -= 1
    rest = m.group(3).strip().lower()
    minor = rest.startswith("m") and not rest.startswith("maj") or rest.startswith("min")
    if rest in ("", "maj", "major", "M"):
        minor = False
    return Key(pc % 12, bool(minor))


def midi_to_hz(m: float | np.ndarray) -> float | np.ndarray:
    return 440.0 * np.power(2.0, (np.asarray(m, dtype=np.float64) - 69.0) / 12.0)


def hz_to_midi(f: float | np.ndarray) -> float | np.ndarray:
    return 69.0 + 12.0 * np.log2(np.maximum(np.asarray(f, dtype=np.float64), 1e-6) / 440.0)


def root_hz_near(key: Key, target_hz: float) -> float:
    """Frequency of the key's root pitch class closest (in log-frequency) to ``target_hz``."""
    m = float(hz_to_midi(max(target_hz, 20.0)))
    base = key.root_pc + 12 * np.round((m - key.root_pc) / 12.0)
    return float(midi_to_hz(base))


def root_hz_octave(key: Key, octave: int) -> float:
    """Root of ``key`` in scientific-pitch ``octave`` (A2 = 110 Hz, C2 = 65.4 Hz)."""
    return float(midi_to_hz(12 * (octave + 1) + key.root_pc))


def quantize_to_scale(midi: np.ndarray, key: Key) -> np.ndarray:
    """Snap fractional MIDI notes to the nearest note of ``key``'s scale."""
    m = np.asarray(midi, dtype=np.float64)
    allowed = np.array(key.scale, dtype=np.float64)
    octave = np.floor(m / 12.0)
    cands = (octave[..., None] - 1) * 12 + np.concatenate([allowed, allowed + 12, allowed + 24])[None, :]
    idx = np.argmin(np.abs(cands - m[..., None]), axis=-1)
    return np.take_along_axis(cands, idx[..., None], axis=-1)[..., 0]


def bar_seconds(bpm: float, beats_per_bar: int = 4) -> float:
    """1 bar = 240 / BPM seconds in 4/4."""
    return 60.0 * beats_per_bar / float(bpm)


def beat_seconds(bpm: float) -> float:
    return 60.0 / float(bpm)


_NOTE_RE = re.compile(r"^\s*(\d+)\s*/\s*(\d+)\s*([dDtT.]?)\s*$")


def note_seconds(value: str | float, bpm: float) -> float:
    """Tempo-synced duration: "1/4", "1/8d" (dotted), "1/8t" (triplet), "1bar", "2b" (beats), or seconds."""
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip().lower()
    beat = beat_seconds(bpm)
    if s.endswith("bar") or s.endswith("bars"):
        return float(s.rstrip("bars") or 1) * bar_seconds(bpm)
    if s.endswith("b") and s[:-1].replace(".", "", 1).isdigit():
        return float(s[:-1]) * beat
    if s.endswith("s") and s[:-1].replace(".", "", 1).isdigit():
        return float(s[:-1])
    m = _NOTE_RE.match(s)
    if not m:
        try:
            return float(s)
        except ValueError as exc:
            raise ValueError(f"bad note value {value!r}") from exc
    whole = 4.0 * beat
    dur = whole * int(m.group(1)) / int(m.group(2))
    mod = m.group(3)
    if mod in ("d", "."):
        dur *= 1.5
    elif mod == "t":
        dur *= 2.0 / 3.0
    return dur
