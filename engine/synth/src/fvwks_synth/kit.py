"""The kit sampler (REMIX): a kit clip's hits (contracts v0.11.2 KitHit: beat, voice kick|snare|hats, vel 0-1) played
on a kit's one-shots. S2's GENRE FLIP writes the hits; render_kit plays them.

Kits: FOXBOX, synthesised here (numpy, our own sounds), and four TR-808 kits of Michael Fischer's samples of a real
TR-808 (tidalcycles/sounds-tr808-fischer, CC0; kits/kits.json has the credit). A sample kit is kits/<id>/<voice>.wav;
a voice it lacks comes from FOXBOX. Beyond the contract's three voices the sampler also plays clap, open_hat, perc and a
tuned 808 (`midi`); an open hat is cut by the next closed hat and an 808 by the next 808, as on the machine.
"""

from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path

import numpy as np

from fvwks_contracts.models import DrumKit

KITS_DIR = Path(__file__).parent / "kits"
VOICES = ("kick", "snare", "hats", "clap", "open_hat", "perc", "808")
FOXBOX_KIT = {"id": "foxbox", "name": "FOXBOX", "source": "foxbox"}
BASE_808 = 36  # the MIDI note an 808 one-shot is tuned to (C1)


@lru_cache(maxsize=1)
def _kit_entries() -> tuple[dict, ...]:
    extra = json.loads((KITS_DIR / "kits.json").read_text()) if (KITS_DIR / "kits.json").is_file() else []
    return (FOXBOX_KIT, *extra)


def kits() -> list[DrumKit]:
    """FOXBOX first, then the bundled sample kits."""
    return [DrumKit(id=k["id"], name=k["name"], source=k["source"]) for k in _kit_entries()]


def _noise(n: int, seed: int) -> np.ndarray:
    return np.random.default_rng(seed).uniform(-1, 1, n)


def _bandish(x: np.ndarray, sr: int, lo: float, hi: float) -> np.ndarray:
    """A cheap band-pass: the difference of two one-pole low-passes."""

    def lp(v: np.ndarray, fc: float) -> np.ndarray:
        from scipy.signal import lfilter

        k = math.exp(-2 * math.pi * fc / sr)
        return lfilter([1 - k], [1, -k], v)

    return lp(x, hi) - lp(x, lo)


@lru_cache(maxsize=16)
def _foxbox(voice: str, sr: int) -> np.ndarray:
    """FOXBOX's own one-shots (mono float32), made once per sample rate."""
    t = lambda s: np.arange(int(s * sr)) / sr  # noqa: E731
    if voice == "kick":
        x = t(0.5)
        f = 45 + 110 * np.exp(-x / 0.03)
        y = np.sin(2 * np.pi * np.cumsum(f) / sr) * np.exp(-x / 0.18)
        y[: int(0.002 * sr)] += _noise(int(0.002 * sr), 1) * 0.4  # the click
        y = np.tanh(y * 1.6)
    elif voice == "snare":
        x = t(0.3)
        tone = np.sin(2 * np.pi * 185 * x) * np.exp(-x / 0.05)
        body = _bandish(_noise(len(x), 2), sr, 900, 7000) * np.exp(-x / 0.09)
        y = 0.55 * tone + 1.2 * body
    elif voice == "clap":
        x = t(0.35)
        env = np.exp(-x / 0.12)
        for k in (0.0, 0.011, 0.022):  # three hands, then the room
            env += np.where((x >= k) & (x < k + 0.008), 1.0, 0.0)
        y = _bandish(_noise(len(x), 3), sr, 800, 2600) * env * 1.4
    elif voice == "hats":
        x = t(0.06)
        y = _bandish(_noise(len(x), 4), sr, 7000, 16000) * np.exp(-x / 0.015) * 1.6
    elif voice == "open_hat":
        x = t(0.45)
        y = _bandish(_noise(len(x), 5), sr, 6500, 16000) * np.exp(-x / 0.16) * 1.3
    elif voice == "perc":
        x = t(0.25)
        y = np.sin(2 * np.pi * (220 + 60 * np.exp(-x / 0.02)) * x) * np.exp(-x / 0.08)
    elif voice == "808":
        x = t(1.6)
        # BASE_808 (65.4 Hz), dropping an octave onto it; retuned per hit by _retune.
        f = 440 * 2 ** ((BASE_808 - 69) / 12) * 2 ** np.exp(-x / 0.03)
        y = np.tanh(1.8 * np.sin(2 * np.pi * np.cumsum(f) / sr)) * np.exp(-x / 0.6)
    else:
        raise KeyError(voice)
    return (0.9 * y / (np.abs(y).max() or 1)).astype(np.float32)


@lru_cache(maxsize=64)
def _sample(kit_id: str, voice: str, sr: int) -> np.ndarray | None:
    path = KITS_DIR / kit_id / f"{voice}.wav"
    if not path.is_file():
        return None
    import soundfile as sf
    from scipy.signal import resample_poly

    x, rate = sf.read(path, dtype="float32", always_2d=True)
    x = x.mean(1)
    if rate != sr:
        g = math.gcd(rate, sr)
        x = resample_poly(x, sr // g, rate // g).astype(np.float32)
    return x


def one_shot(kit_id: str, voice: str, sr: int) -> np.ndarray:
    """A voice's one-shot for a kit; a sample kit without that voice falls back to FOXBOX's."""
    if kit_id != "foxbox" and (x := _sample(kit_id, voice, sr)) is not None:
        return x
    return _foxbox(voice, sr)


def _retune(x: np.ndarray, semitones: float) -> np.ndarray:
    """Re-pitch a one-shot (and its length) by resampling: how a sampler plays an 808 up or down."""
    if abs(semitones) < 1e-3:
        return x
    ratio = 2 ** (semitones / 12)
    idx = np.arange(0, len(x) - 1, ratio)
    return np.interp(idx, np.arange(len(x)), x).astype(np.float32)


def render_kit(kit_id: str, hits: list, *, bpm: float, beats: float, sr: int = 48_000) -> np.ndarray:
    """A kit clip: `hits` (KitHit or dicts: beat, voice, vel 0-1; `midi` for an 808) over `beats` at `bpm` on a kit.
    (2, n) float32, n = beats at bpm (a hit's tail past the end is cut)."""
    if kit_id not in {k["id"] for k in _kit_entries()}:
        raise KeyError(kit_id)
    hits = [h.model_dump() if hasattr(h, "model_dump") else dict(h) for h in hits]
    n = int(round(beats * 60.0 / bpm * sr))
    out = np.zeros(n, np.float32)
    spb = 60.0 / bpm
    hits = sorted(hits, key=lambda h: h["beat"])
    for i, h in enumerate(hits):
        voice = h["voice"]
        if voice not in VOICES:
            raise KeyError(voice)
        a = int(h["beat"] * spb * sr)
        if a >= n:
            continue
        x = one_shot(kit_id, voice, sr)
        if voice == "808":
            x = _retune(x, h.get("midi", BASE_808) - BASE_808)
        # Choke groups: the next closed hat cuts an open hat; the next 808 cuts an 808.
        choke = {"open_hat": "hats", "808": "808"}.get(voice)
        if choke:
            nxt = next((g for g in hits[i + 1 :] if g["voice"] == choke), None)
            if nxt:
                cut = int((nxt["beat"] - h["beat"]) * spb * sr)
                x = x[: max(1, cut)].copy()
                fade = min(len(x), int(0.004 * sr))
                x[len(x) - fade :] *= np.linspace(1, 0, fade)
        b = min(n, a + len(x))
        out[a:b] += x[: b - a] * float(h.get("vel", 1.0))
    return np.stack([out, out])
