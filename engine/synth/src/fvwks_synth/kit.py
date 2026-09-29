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
import re
import zlib
from functools import lru_cache
from pathlib import Path

import numpy as np

from fvwks_contracts.models import DrumKit

KITS_DIR = Path(__file__).parent / "kits"
VOICES = ("kick", "snare", "hats", "clap", "open_hat", "perc", "808")
FOXBOX_KIT = {"id": "foxbox", "name": "FOXBOX", "source": "foxbox"}
BASE_808 = 36  # the MIDI note an 808 one-shot is tuned to (C1)
VERSION = 3  # bump when a kit's sound changes (a kit clip's cache key; 2: FOXBOX on fvwks_synth.drums, tuned; 3: the bundle's acoustic snares)


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


ROUND_ROBIN = {"hats": 7, "open_hat": 7}  # an odd cycle never locks to 4/4 phrases; the rest 5 (REMIX_HARMONY 4.2)
_PC = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}


def key_tonic(key: str | None) -> tuple[int, bool] | None:
    """(the tonic's pitch class, minor) from 'Am', 'F#', 'Bbm', 'C# minor' or Camelot '8A' / '8B'; None when unclear."""
    k = (key or "").strip().lower().replace("♯", "#").replace("♭", "b")
    if m := re.fullmatch(r"(1[0-2]|[1-9])([ab])", k):  # Camelot: 8A = A minor, 8B = C major
        n = int(m.group(1)) - 1
        return ((9 + 7 * (n - 7)) % 12, True) if m.group(2) == "a" else ((0 + 7 * (n - 7)) % 12, False)
    if m := re.fullmatch(r"([a-g])([#b]?)\s*(m|min|minor|maj|major)?", k):
        pc = (_PC[m.group(1)] + {"#": 1, "b": -1}.get(m.group(2), 0)) % 12
        return pc, m.group(3) in ("m", "min", "minor")
    return None


def kick_tuning(pc: int) -> tuple[float, int]:
    """(the kick's end Hz, its pitch class): the tonic folded into 40-62 Hz, else its 5th (C -> G1 49.0, D -> A1 55.0)."""
    for p in (pc, (pc + 7) % 12):
        f = 32.7032 * 2 ** (p / 12)  # octave 1
        f = f * 2 if f < 40 else f
        if f <= 62:
            return f, p
    return 52.0, pc  # (unreachable: one of a note and its 5th always folds in)


def snare_tuning(pc: int) -> float:
    """The snare body: R or 5, in any octave, nearest 200 Hz within 150-260 (Fm -> F3 174.6, Dm -> A3 220)."""
    cands = [16.3516 * 2 ** (p / 12 + o) for p in (pc, (pc + 7) % 12) for o in range(8)]
    inside = [f for f in cands if 150 <= f <= 260]
    return min(inside or cands, key=lambda f: abs(f - 200))


def perc_tuning(pc: int, minor: bool, variant: int) -> float:
    """Toms and fill percussion on R, b3 (3 in major) and 5, by variant, in 165-330 Hz."""
    p = (pc + (0, 3 if minor else 4, 7)[variant % 3]) % 12
    f = 16.3516 * 2 ** (p / 12)
    while f < 165:
        f *= 2
    return f


@lru_cache(maxsize=512)
def _drum(voice: str, sr: int, seed: int, variant: int, root_hz: float | None, tone_hz: float | None) -> np.ndarray:
    from .drums import render_drum

    return render_drum(voice, sr, seed=seed, variant=variant, root_hz=root_hz, tone_hz=tone_hz)


def _perc(sr: int, hz: float) -> np.ndarray:
    t = np.arange(int(0.25 * sr)) / sr
    y = np.sin(2 * np.pi * np.cumsum(hz * (1 + 0.27 * np.exp(-t / 0.02))) / sr) * np.exp(-t / 0.08)
    return (0.9 * y / (np.abs(y).max() or 1)).astype(np.float32)


def _variant(kit_id: str, voice: str, v: int, sr: int, seed: int, tune: dict) -> np.ndarray:
    """Round-robin variant `v` of a voice, (2, n): FOXBOX plays fvwks_synth.drums (its own per-seed pitch and decay
    jitter), tuned to the key; a sample kit repitches its one-shot +-12 cents per variant."""
    vseed = zlib.crc32(f"{seed}:{voice}:{v}".encode())
    if kit_id == "foxbox" and voice in ("kick", "snare", "clap", "hats", "open_hat"):
        name = {"hats": "hat"}.get(voice, voice)
        x = _drum(name, sr, vseed, v % 2 if voice == "snare" else v % 4, tune.get("kick_hz") if voice == "kick" else None,
                  tune.get("snare_hz") if voice == "snare" else None)
        return np.array(x, np.float32)
    if voice == "perc" and "pc" in tune and not (KITS_DIR / kit_id / "perc.wav").is_file():
        x = _perc(sr, perc_tuning(tune["pc"], tune["minor"], v) * tune["theta"])
    else:
        x = one_shot(kit_id, voice, sr)
        if kit_id != "foxbox" and voice != "808":
            st = np.random.default_rng(vseed).uniform(-0.12, 0.12)
            if voice == "kick" and "kick_hz" in tune and (hz := _kick_pitch(kit_id)):  # onto the key's kick, within +-6 st
                st = st / 4 + (12 * math.log2(tune["kick_hz"] / hz) + 6) % 12 - 6  # +-3 c: variants, still in tune
            x = _retune(x, st)
    return np.stack([x, x]).astype(np.float32)


def _kick_pitch(kit_id: str) -> float | None:
    """A sample kit's kick pitch (kits.json pitch_hz: its tail's f0 after the transient, measured once), or None."""
    return next((k.get("pitch_hz", {}).get("kick") for k in _kit_entries() if k["id"] == kit_id), None)


def _velocity(x: np.ndarray, vel: float, sr: int) -> np.ndarray:
    """Harder is brighter: +1.5 dB above 3 kHz per +0.25 of velocity (from 1.0: softer hits are darker)."""
    g = 10 ** (6.0 * (vel - 1.0) / 20) - 1
    if abs(g) < 1e-3 or x.shape[-1] < 32:
        return x
    from scipy import signal

    top = signal.sosfiltfilt(signal.butter(2, 3000, "highpass", fs=sr, output="sos"), x, axis=-1)
    return (x + g * top).astype(np.float32)


def _kick_tail(x: np.ndarray, sr: int) -> np.ndarray:
    """-30 dB by 150 ms (a raised cosine from 100 ms), gone by 170: no 1-10 Hz beating against another root's sub."""
    t = np.arange(x.shape[-1]) / sr
    floor = 10 ** (-30 / 20)
    g = np.where(t < 0.10, 1.0, np.where(t < 0.15, floor + (1 - floor) * (0.5 + 0.5 * np.cos(np.pi * (t - 0.10) / 0.05)),
                                          floor * np.clip((0.17 - t) / 0.02, 0, 1)))
    return (x * g).astype(np.float32)


def render_kit(kit_id: str, hits: list, *, bpm: float, beats: float, sr: int = 48_000, layer: str = "synth",
               seed: int = 0, key: str | None = None, tuning_cents: float = 0.0,
               roots: list[tuple[float, int]] | None = None) -> np.ndarray:
    """A kit clip: `hits` (KitHit or dicts: beat, voice, vel 0-1; `midi` for an 808) over `beats` at `bpm` on a kit.
    (2, n) float32, n = beats at bpm (a hit's tail past the end is cut). `layer` (the take's kit.layer: synth | sample |
    both) puts a CC0 one-shot under FOXBOX's synthesized hits (fvwks_synth.layers; the take's `seed` picks the samples),
    before the chokes cut them.

    REMIX_HARMONY 4.2: each voice cycles 5 round-robin variants (7 for hats), never the same twice running; velocity sets
    the level (+-0.5 dB per hit) and the brightness. With `key` the kick ends on the tonic folded into 40-62 Hz (else its
    5th), the snare's body is R or 5 nearest 200 Hz, perc plays R / b3 / 5; a kick under another root (`roots`: (beat,
    pitch class) where the clip's root changes) is under -30 dB by 150 ms. A sample kit's kick with a measured pitch
    (kits.json pitch_hz) is repitched onto the same note within +-6 st and gated the same; perc a kit lacks is FOXBOX's,
    tuned. `tuning_cents` (the source's tuning) moves
    every tuned voice and the 808."""
    if kit_id not in {k["id"] for k in _kit_entries()}:
        raise KeyError(kit_id)
    hits = [h.model_dump() if hasattr(h, "model_dump") else dict(h) for h in hits]
    n = int(round(beats * 60.0 / bpm * sr))
    out = np.zeros((2, n), np.float32)
    spb = 60.0 / bpm
    hits = sorted(hits, key=lambda h: h["beat"])
    theta = 2 ** (tuning_cents / 1200)
    tune: dict = {"theta": theta}
    if tonic := key_tonic(key):
        kick_hz, kick_pc = kick_tuning(tonic[0])
        tune.update(pc=tonic[0], minor=tonic[1], kick_hz=kick_hz * theta, kick_pc=kick_pc,
                    snare_hz=snare_tuning(tonic[0]) * theta)
    roots = sorted(roots or [])
    count: dict[str, int] = {}
    jitter = np.random.default_rng([int(seed), 0x4B17])
    for i, h in enumerate(hits):
        voice = h["voice"]
        if voice not in VOICES:
            raise KeyError(voice)
        a = int(h["beat"] * spb * sr)
        if a >= n:
            continue
        v = count.get(voice, 0) % ROUND_ROBIN.get(voice, 5)
        count[voice] = count.get(voice, 0) + 1
        x = _variant(kit_id, voice, v, sr, seed, tune)
        if kit_id == "foxbox" and layer != "synth":
            from .layers import layer as sample_layer

            x = sample_layer(x, voice, sr, seed, layer)
        if voice == "808":
            x = np.stack([_retune(x[0], h.get("midi", BASE_808) - BASE_808 + tuning_cents / 100)] * 2)
        if voice == "kick" and "kick_pc" in tune and roots and (kit_id == "foxbox" or _kick_pitch(kit_id)):
            under = [pc for b, pc in roots if b <= h["beat"] + 1e-6]
            if under and under[-1] % 12 != tune["kick_pc"]:
                x = _kick_tail(x, sr)
        vel = float(np.clip(h.get("vel", 1.0), 0.0, 1.0))
        x = _velocity(x, vel, sr) * vel * 10 ** (jitter.uniform(-0.5, 0.5) / 20)
        # Choke groups: the next closed hat cuts an open hat; the next 808 cuts an 808.
        choke = {"open_hat": "hats", "808": "808"}.get(voice)
        if choke:
            nxt = next((g for g in hits[i + 1 :] if g["voice"] == choke), None)
            if nxt:
                cut = int((nxt["beat"] - h["beat"]) * spb * sr)
                x = x[:, : max(1, cut)].copy()
                fade = min(x.shape[-1], int(0.004 * sr))
                x[:, x.shape[-1] - fade :] *= np.linspace(1, 0, fade)
        b = min(n, a + x.shape[-1])
        out[:, a:b] += x[:, : b - a]
    return out
