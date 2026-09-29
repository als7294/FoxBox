"""REMIX synth-bass clips: a BASS DNA groove through any library patch, Surge XT or FoxBox's own synth."""

from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np

from . import foxsynth, surge
from .groove import cut, level_gain
from .library import entry

_data: Path | None = None


def configure(data_dir: Path) -> None:
    """Called at engine start with a folder in the engine's data dir: Surge keeps its own files in <data_dir>/surge-home
    (never the user's folders) and previews are cached in <data_dir>/previews."""
    global _data
    _data = Path(data_dir)


def data_dir() -> Path:
    return _data or Path(tempfile.gettempdir()) / "fvwks-synth"


def render_groove(groove, patch_id: str, *, start_bar: int, bars: int, bpm: float, shift_st: float = 0.0,
                  sr: int = 48_000) -> np.ndarray:
    """`bars` bars of a BassGroove from song bar `start_bar`, transposed `shift_st`, on `patch_id` at `bpm`:
    (2, n) float32, n = the bars' exact length at bpm. The groove's level curve (the bounce) rides on top."""
    clip = cut(groove, start_bar=start_bar, bars=bars, shift_st=shift_st)
    p = entry(patch_id)
    if p["engine"] == "foxbox":
        audio = foxsynth.render(p, clip, bpm, sr)
    else:
        audio = surge.render(patch_id, clip, bpm, home=data_dir() / "surge-home", sr=sr)
    n = int(round(clip["beats"] * 60.0 / bpm * sr))
    audio = audio[:, :n] if audio.shape[1] >= n else np.pad(audio, ((0, 0), (0, n - audio.shape[1])))
    gain = level_gain(clip["level"], clip["per_beat"], bpm, sr, n)
    return (audio * gain if gain is not None else audio).astype(np.float32)


def usable(patch_id: str) -> bool:
    """False for a Surge patch on an engine built without surgepy (the library shows it, greyed out)."""
    return entry(patch_id)["engine"] == "foxbox" or surge.available()
