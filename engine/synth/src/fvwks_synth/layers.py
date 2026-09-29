"""Drum sample layers (1.5.1, M1.19): a CC0 one-shot under each synthesized hit, so the kit sounds recorded, not only
designed. The synths stay the main sound.

  layer(synth, voice, sr, seed, mode) -> synth's shape; mode synth | sample | both: the take's kit.layer (a choose()
  axis in fvwks_fx's styles/common.json, weighted to both)

  both    the synth hit plus a sample of its role: the sample's transient peak on the synth's (no flam), its polarity
          flipped when it would cancel the synth, its level matched to the synth's and 6 dB under it, then filtered (4th
          order, zero phase) to complement it: the kick's sample high-passed at 90 Hz (the synth kick and the 808 keep the sub), the snare's
          at 150 Hz (crack and body), the clap's at 400, the hats' at 3 kHz, the metal perc and the impact at 200 / 60;
          added under the synth, which is left as it was (the kit's loudness is matched downstream)
  sample  the sample alone, full band, at the synth's peak
  synth   the synth alone

One sample per role per take (the seed picks it): a kit, not a different drum every hit. The bank is samples/<role>/*.flac
(samples/manifest.json: every file CC0 with its source and author; scripts/build_sample_bundle.py makes it). The user's
own packs (v0.15, set_user_samples: the server registers the enabled ones whose folder is there) replace it for the
roles they cover; a file that can't be read falls back to the bundle.
"""

from __future__ import annotations

import json
import zlib
from functools import lru_cache
from math import gcd
from pathlib import Path

import numpy as np
from scipy import signal

SAMPLES = Path(__file__).parent / "samples"
ROLE = {"kick": "kick", "kick_riddim": "kick", "kick_tearout": "kick", "snare": "snare", "snare_pan": "snare",
        "clap": "clap", "hats": "hat", "hat": "hat", "open_hat": "open_hat", "perc": "perc", "impact": "impact",
        "crash": "cymbal", "reverse_cymbal": "cymbal"}
HIGHPASS = {"kick": 90.0, "snare": 150.0, "clap": 400.0, "hat": 3000.0, "open_hat": 3000.0, "perc": 200.0,
            "impact": 60.0, "cymbal": 300.0}
UNDER_DB = 6.0


_USER: dict[str, tuple[str, ...]] = {}  # role -> the user's one-shots (absolute paths; never returned by the engine)


def set_user_samples(entries: list[tuple[str, str]]) -> None:
    """The enabled user packs' one-shots, (role, path) each: they replace the bundle for their roles."""
    global _USER
    roles: dict[str, list[str]] = {}
    for role, path in entries:
        roles.setdefault(role, []).append(path)
    _USER = {r: tuple(sorted(ps)) for r, ps in roles.items()}


def bank_version() -> str:
    """Changes whenever the user samples do (for a kit clip's cache key)."""
    return f"{zlib.crc32(repr(sorted(_USER.items())).encode()):08x}" if _USER else "bundle"


@lru_cache(maxsize=1)
def manifest() -> tuple[dict, ...]:
    path = SAMPLES / "manifest.json"
    return tuple(json.loads(path.read_text())) if path.is_file() else ()


@lru_cache(maxsize=256)
def _load(file: str, sr: int, stamp: float = 0.0) -> np.ndarray:
    """A bundled file (relative) or a user one-shot (absolute; `stamp` its mtime, so an edited file is read again), mono."""
    import soundfile as sf

    x, rate = sf.read(SAMPLES / file, dtype="float32", always_2d=True)
    x = x.mean(axis=1)
    if rate != sr:
        g = gcd(rate, sr)
        x = signal.resample_poly(x, sr // g, rate // g).astype(np.float32)
    return x


def pick(voice: str, seed: int, sr: int) -> np.ndarray | None:
    """The take's sample for this voice's role (mono), or None when the bank has none."""
    role = ROLE.get(voice)
    rng = np.random.default_rng([int(seed), zlib.crc32(str(role).encode())])
    if voice == "reverse_cymbal" and _USER.get("reverse"):  # the user's own reverses play as they are
        mine, flip = _USER["reverse"], False
    else:
        mine, flip = _USER.get(role, ()), voice == "reverse_cymbal"
    if mine:
        path = mine[int(rng.integers(len(mine)))]
        try:
            x = _load(path, sr, Path(path).stat().st_mtime)
            return x[::-1].copy() if flip else x
        except (OSError, RuntimeError):
            rng = np.random.default_rng([int(seed), zlib.crc32(str(role).encode())])  # unplugged: the bundle stands in
    files = [e["file"] for e in manifest() if e["role"] == role]
    if not files:
        return None
    x = _load(files[int(rng.integers(len(files)))], sr)
    return x[::-1].copy() if voice == "reverse_cymbal" else x


def _peak(x: np.ndarray, sr: int, from_end: bool = False) -> int:
    """The transient's peak: the largest sample in the first 60 ms (a reverse: the last 60 ms)."""
    env = np.abs(x.reshape(-1, x.shape[-1]).mean(axis=0))
    w = min(len(env), int(0.06 * sr))
    return int(len(env) - w + np.argmax(env[-w:])) if from_end else int(np.argmax(env[:w]))


def layer(synth: np.ndarray, voice: str, sr: int, seed: int = 0, mode: str = "both") -> np.ndarray:
    """`synth` (mono (n,) or (channels, n)) with its sample layer, same shape and length; unchanged for mode 'synth', a
    voice without a role, or an empty bank."""
    if mode == "synth" or voice not in ROLE or not np.any(synth):
        return synth
    s = pick(voice, seed, sr)
    if s is None:
        return synth
    role, rev = ROLE[voice], voice == "reverse_cymbal"
    mono = synth.reshape(-1, synth.shape[-1]).mean(axis=0)
    n = mono.shape[-1]
    shift = (_peak(mono, sr, rev) - _peak(s, sr, rev)) if not rev else (n - len(s))  # a reverse: their ends together
    cut_tail = len(s) + shift > n
    s = np.pad(s, (shift, 0))[:n] if shift >= 0 else s[-shift:][:n].copy()
    if shift < 0:  # its head (before its peak) didn't fit before the hit: a 2 ms raised-cosine start, not a step
        k = min(len(s), int(0.002 * sr))
        s[:k] *= 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, k))
    if cut_tail:  # longer than the hit: a 5 ms raised-cosine end
        k = min(len(s), int(0.005 * sr))
        s[len(s) - k:] *= 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, k))
    s = np.pad(s, (0, n - len(s)))
    a, b = max(0, _peak(mono, sr, rev) - int(0.01 * sr)), _peak(mono, sr, rev) + int(0.03 * sr)
    if np.dot(mono[a:b], s[a:b]) < 0:  # its phase would cancel the synth's body: flip it
        s = -s
    top = float(np.max(np.abs(synth))) or 1.0
    if mode == "sample":
        out = s * top / (np.max(np.abs(s)) or 1.0)
        return np.broadcast_to(out, synth.shape).astype(synth.dtype).copy()
    rms = lambda y: float(np.sqrt(np.mean(y[a:b] ** 2))) or 1e-12  # noqa: E731
    s = s * (rms(mono) / rms(s)) * 10 ** (-UNDER_DB / 20)  # the whole sample matched, then filtered: the filter only takes
    s = signal.sosfiltfilt(signal.butter(4, HIGHPASS[role], "highpass", fs=sr, output="sos"), s)  # away (a sub isn't made up)
    return (synth + (s if synth.ndim == 1 else s[None, :])).astype(synth.dtype)  # added under it: the synth untouched
