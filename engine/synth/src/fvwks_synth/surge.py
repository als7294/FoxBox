"""Surge XT (GPL-3.0) bass patches, rendered offline for REMIX grooves.

surgepy (Surge's Python module, built by native/build_surgepy.sh into _native/) runs in a child process
(_surge_child.py) with its own HOME: creating a Surge makes ~/Documents/Surge Synth Team/… and app-support folders,
which must land in the engine's data dir, never the user's. A native crash also stays out of the engine.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np

from .library import PATCHES_DIR, entry

# Where surgepy is: FVWKS_SURGEPY_DIR (a release may ship it elsewhere), else the package's _native/.
NATIVE = Path(os.environ.get("FVWKS_SURGEPY_DIR") or Path(__file__).parent / "_native")


class SynthError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def available() -> bool:
    """surgepy is built into this engine (Apple silicon builds; absent elsewhere)."""
    return any(NATIVE.glob("surgepy*.so"))


def render(patch_id: str, clip: dict, bpm: float, *, home: Path, sr: int = 48_000) -> np.ndarray:
    """A clip (groove.cut()) through a Surge patch at `bpm`: (2, n) float32 at `sr`. `home`: a folder in the engine's
    data dir for Surge's own files."""
    if not available():
        raise SynthError("synth_unavailable", "Surge XT isn't part of this engine build.")
    p = entry(patch_id)
    if p["engine"] != "surge":
        raise SynthError("invalid_request", f"{patch_id} isn't a Surge patch.")
    home.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "HOME": str(home), "CFFIXED_USER_HOME": str(home), "SURGE_DATA_HOME": str(PATCHES_DIR),
           "FVWKS_SURGEPY_DIR": str(NATIVE)}
    job = {"patch": str(PATCHES_DIR / p["file"]), "sr": sr, "bpm": bpm, "clip": clip}
    r = subprocess.run([sys.executable, "-m", "fvwks_synth._surge_child"], input=json.dumps(job).encode(),
                       capture_output=True, env=env, timeout=120)
    if r.returncode != 0:
        raise SynthError("render_failed", f"Surge XT stopped: {r.stderr.decode(errors='replace')[-400:]}")
    head, _, raw = r.stdout.partition(b"\n")
    shape = json.loads(head)
    return np.frombuffer(raw, dtype=np.float32).reshape(shape["channels"], shape["frames"]).copy()
