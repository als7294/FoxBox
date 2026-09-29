"""Auditions for the PatchPicker and the kit list: about 2 s (one bar at 140 BPM) of a stock riff on a patch, or a
stock beat on a kit, loudness-matched so patches compare fairly, cached as WAV under <data_dir>/previews. The cache
key covers the patch (its file or params) and the stock riff, so a changed patch re-renders."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import soundfile as sf

from fvwks_contracts.models import BassGroove, GrooveNote, GrooveWobble, KitHit

from . import bass
from .kit import kits, render_kit
from .library import PATCHES_DIR, entry

BPM = 140.0
SR = 48_000
STOCK = 2  # bump when the stock riff or beat changes (2: FOXBOX kit on fvwks_synth.drums)
# The wobble a category is auditioned with (reese and 808 sound best without one).
WOBBLE = {"wobble": ("1/8", 0.8), "growl": ("1/16", 0.6), "riddim": ("1/8T", 0.8)}


def _riff(category: str) -> BassGroove:
    """One bar: a long root, a pickup, a root sliding up a fifth, the fifth."""
    notes = [
        GrooveNote(beat=0, beats=1.5, midi=36, vel=1.0),
        GrooveNote(beat=1.5, beats=0.5, midi=36, vel=0.8),
        GrooveNote(beat=2, beats=1.5, midi=36, vel=1.0, glide_to=43),
        GrooveNote(beat=3.5, beats=0.5, midi=43, vel=0.8),
    ]
    wobble = [GrooveWobble(bar=0, div=WOBBLE[category][0], depth=WOBBLE[category][1], phase=0)] if category in WOBBLE else []
    return BassGroove(song_id="preview", start_bar=1, bars=1, bpm=BPM, notes=notes, wobble=wobble)


BEAT = [KitHit(beat=b, voice="kick", vel=1.0) for b in (0, 1.5, 2.5)] + [KitHit(beat=b, voice="snare", vel=0.9) for b in (1, 3)] + [
    KitHit(beat=b / 2, voice="hats", vel=0.6 if b % 2 else 0.8) for b in range(8)
]


def _loudness_matched(x: np.ndarray) -> np.ndarray:
    """-16 dBFS RMS, never above -1 dBFS peak."""
    rms = float(np.sqrt(np.mean(x**2))) or 1.0
    y = x * (10 ** (-16 / 20) / rms)
    peak = float(np.abs(y).max()) or 1.0
    return (y * min(1.0, 10 ** (-1 / 20) / peak)).astype(np.float32)


def _cached(name: str, key: dict, render) -> Path:
    digest = hashlib.sha1(json.dumps(key, sort_keys=True).encode()).hexdigest()[:12]
    path = bass.data_dir() / "previews" / f"{name}-{digest}.wav"
    if not path.is_file():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp.wav")
        sf.write(tmp, _loudness_matched(render()).T, SR, subtype="PCM_16")
        tmp.replace(path)
    return path


def preview(patch_id: str) -> Path:
    """A patch's audition (WAV). Surge patches need surgepy (SynthError 'synth_unavailable' without it)."""
    p = entry(patch_id)
    source = hashlib.sha1((PATCHES_DIR / p["file"]).read_bytes()).hexdigest() if p["engine"] == "surge" else p["params"]
    riff = _riff(p["category"])
    return _cached(patch_id, {"stock": STOCK, "patch": source, "category": p["category"]},
                   lambda: bass.render_groove(riff, patch_id, start_bar=1, bars=1, bpm=BPM, sr=SR))


def kit_preview(kit_id: str) -> Path:
    """A kit's audition (WAV): one bar of kick, snare and hats."""
    if kit_id not in {k.id for k in kits()}:
        raise KeyError(kit_id)
    return _cached(f"kit-{kit_id}", {"stock": STOCK, "kit": kit_id}, lambda: render_kit(kit_id, BEAT, bpm=BPM, beats=4, sr=SR))
