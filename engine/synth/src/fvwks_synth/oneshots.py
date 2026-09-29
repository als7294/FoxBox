"""Drop a folder of one-shots (1.5.1, the engine half of M3.9): find the drum one-shots in a user's sample pack and say
what each is, so the kit can layer them (fvwks_synth.layers). The files stay where they are; nothing is copied.

  scan(folder, max_files=5000) -> [OneShot(path, name, role, confidence, seconds, why)]
  classify(name, x, sr) -> (role | None, confidence, why)

Roles are the layer bank's: kick, snare, clap, hat, open_hat, cymbal, reverse, impact, perc. A file is a one-shot when it
is at most ~2 s long and has one transient (a loop's second hit rules it out). The name decides first (kick / kck / bd,
snare / snr / sd, clap / clp, hat / hh / ch, oh / open hat, rev / reverse, crash / cym / ride, impact / boom / hit, perc /
metal / anvil / tom ...); a name that says nothing leaves it to its sound: the low band's share, the spectral centroid and
flatness, the length, and a rising envelope (a reverse).
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy import signal

AUDIO = {".wav", ".aif", ".aiff", ".flac", ".mp3"}
MAX_SECONDS, MAX_BYTES = 2.2, 20 << 20
# name tokens -> role, strongest first ("hit" last: a "snare hit" is a snare)
TOKENS = [("reverse", {"rev", "reverse", "reversed", "riser"}), ("kick", {"kick", "kck", "kik", "bd", "bassdrum"}),
          ("snare", {"snare", "snr", "sd", "rimshot"}), ("clap", {"clap", "clp", "claps", "snap"}),
          ("open_hat", {"oh", "ohh", "openhat", "ophat"}), ("hat", {"hat", "hh", "hihat", "ch", "chh", "closedhat"}),
          ("cymbal", {"crash", "cym", "cymbal", "ride", "splash", "china"}),
          ("perc", {"perc", "metal", "anvil", "clang", "tom", "cowbell", "bell", "rim", "block", "pan", "shaker"}),
          ("impact", {"impact", "boom", "hit", "sub", "fx"})]


@dataclass
class OneShot:
    path: Path  # server-side only: never returned or logged by the engine
    name: str
    role: str
    confidence: float
    seconds: float
    why: str


def _tokens(name: str) -> list[str]:
    spaced = re.sub(r"([a-z])([A-Z])", r"\1 \2", name)  # camelCase
    return [t for t in re.split(r"[^a-z0-9]+|(?<=[a-z])(?=[0-9])|(?<=[0-9])(?=[a-z])", spaced.lower()) if t]


def _by_name(name: str) -> str | None:
    toks = _tokens(name)
    if "open" in toks and ("hat" in toks or "hh" in toks or "hihat" in toks):
        return "open_hat"
    for role, words in TOKENS:
        if any(t in words for t in toks):
            return role
    return None


def _transients(x: np.ndarray, sr: int) -> int:
    """How many hits: envelope peaks (10 ms smoothed) over half the loudest, at least 80 ms apart."""
    env = np.convolve(np.abs(x), np.ones(int(0.01 * sr)) / int(0.01 * sr), "same")
    peaks, _ = signal.find_peaks(env, height=0.5 * env.max(), distance=int(0.08 * sr), prominence=0.3 * env.max())
    return len(peaks)


def classify(name: str, x: np.ndarray, sr: int) -> tuple[str | None, float, str]:
    """(role, confidence 0-1, why) for a mono one-shot; role None when it isn't a drum one-shot (too long, a loop)."""
    seconds = len(x) / sr
    if seconds > MAX_SECONDS or not np.any(x):
        return None, 0.0, "not a one-shot (too long or silent)"
    env = np.abs(signal.hilbert(x)) if len(x) < 1 << 18 else np.abs(x)
    env = np.convolve(env, np.ones(int(0.01 * sr)) / int(0.01 * sr), "same")
    if _transients(x, sr) > 1:  # (a reverse swells to one peak)
        return None, 0.0, "more than one hit (a loop or a roll)"
    rising = int(np.argmax(env)) > 0.6 * len(env)
    role = _by_name(name)
    if role:
        return ("reverse" if rising and role == "cymbal" else role), 0.9, "its name"
    if rising:
        return "reverse", 0.7, "it swells to its end"
    f, p = signal.welch(x, sr, nperseg=min(4096, len(x)))
    p = p + 1e-18
    low = p[f < 150].sum() / p.sum()
    centroid = float((f * p).sum() / p.sum())
    flat = float(np.exp(np.mean(np.log(p))) / np.mean(p))  # 0 tonal .. 1 noise
    decay = float(np.flatnonzero(env > 0.1 * env.max())[-1]) / sr  # to -20 dB
    if low > 0.5:
        return ("impact", 0.6, "low, long") if decay > 0.6 else ("kick", 0.7, "low and short")
    if centroid > 6000:
        return ("hat", 0.7, "bright and short") if decay < 0.25 else (("open_hat", 0.6, "bright, rings") if decay < 1.0
                                                                      else ("cymbal", 0.6, "bright, long"))
    if flat > 0.25:
        return ("snare", 0.5, "noisy, with body") if p[(f > 150) & (f < 350)].sum() / p.sum() > 0.08 else ("clap", 0.5, "noise, no body")
    return "perc", 0.5, "tonal, mid"


def candidates(folder: str | Path, max_files: int = 5000) -> list[Path]:
    """The audio files under `folder` (its subfolders too, hidden ones skipped), by extension, at most `max_files`."""
    root = Path(folder).resolve(strict=True)
    out: list[Path] = []
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for fname in sorted(files):
            if Path(fname).suffix.lower() in AUDIO and not fname.startswith("."):
                out.append(Path(dirpath) / fname)
                if len(out) >= max_files:
                    return out
    return out


def check(raw: Path) -> tuple[OneShot | None, str]:
    """(the one-shot, "") or (None, why: 'unsupported' | 'unreadable' | 'not_one_shot'). Symlinks resolved, then the
    target must still be a regular audio file of at most MAX_BYTES; the length is read from the header first."""
    import soundfile as sf

    try:
        path = raw.resolve(strict=True)
    except (OSError, RuntimeError):
        return None, "unreadable"
    if path.suffix.lower() not in AUDIO or not path.is_file() or path.stat().st_size > MAX_BYTES:
        return None, "unsupported"
    try:
        info = sf.info(path)
        if info.frames / max(1, info.samplerate) > MAX_SECONDS:
            return None, "not_one_shot"
        x, sr = sf.read(path, dtype="float32", always_2d=True)
    except (OSError, RuntimeError, sf.LibsndfileError):
        return None, "unreadable"
    role, conf, why = classify(raw.stem, x.mean(axis=1), sr)
    if role is None:
        return None, "not_one_shot"
    return OneShot(path, raw.stem[:120], role, conf, round(len(x) / sr, 3), why), ""


def scan(folder: str | Path, max_files: int = 5000) -> list[OneShot]:
    """The drum one-shots under `folder` (see candidates and check)."""
    return [shot for shot, _ in map(check, candidates(folder, max_files)) if shot]
