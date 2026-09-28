"""Song stems (v0.9): drums, bass, vocals and other, for the visuals.

Meta's HT-Demucs (htdemucs, MIT) on the Apple GPU: demucs-mlx's MLX model classes, vendored in _demucs (no runtime
dependency), with mlx-community's fp16 conversion of the official weights (the stems-htdemucs model, 84 MB). They are
loaded here directly, so nothing ever converts from PyTorch. The song is resampled to the model's 44.1 kHz and split the way Demucs does it by default
(7.8 s segments, 25% overlap, one shift); each stem comes back at the input's rate, length and channel count.
"""

from __future__ import annotations

import json
import threading
from fractions import Fraction
from typing import Any, Callable

import numpy as np

from fvwks_contracts.audio import resample
from fvwks_contracts.models import STEM_NAMES

from .. import models
from ..errors import VoiceError

MODEL_SR = 44_100
BATCH = 2  # segments per GPU call (demucs-mlx's default)
OVERLAP = 0.25

Progress = Callable[[float | None, str | None], None]


class _Counted:
    """The model, counting the segments it has separated so the job can show progress."""

    def __init__(self, model: Any, total: int, progress: Progress) -> None:
        self._model, self._total, self._progress, self._done = model, max(1, total), progress, 0

    def __getattr__(self, name: str) -> Any:
        return getattr(self._model, name)

    def __call__(self, x: Any) -> Any:
        out = self._model(x)
        self._done += int(x.shape[0])
        self._progress(min(0.99, self._done / self._total), "Splitting stems…")
        return out


class StemSplitter:
    name = "stems-htdemucs"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._model: Any = None

    def is_installed(self) -> bool:
        return models.is_installed(models.STEMS)

    def _load(self) -> Any:
        if self._model is None:
            if not self.is_installed():
                raise VoiceError("model_not_installed", "The stem splitter isn't installed.",
                                 "Install it from VOICES → Models (84 MB).", status=503, model_id=models.STEMS.id)
            import mlx.core as mx
            from ._demucs.mlx_htdemucs import HTDemucsMLX
            from mlx.utils import tree_flatten, tree_unflatten

            path = models.repo_path(models.STEMS, models.STEMS_REPO)
            cfg = json.loads((path / "htdemucs_config.json").read_text())
            kwargs = dict(cfg["kwargs"], segment=Fraction(cfg["kwargs"]["segment"]))
            model = HTDemucsMLX(**kwargs)
            # One model saved as a one-model bag ("model_0." prefix). fp16 on disk; float32 in memory is faster.
            weights = {k.removeprefix("model_0."): v.astype(mx.float32)
                       for k, v in mx.load(str(path / "htdemucs.safetensors")).items()}
            expected = {k: tuple(v.shape) for k, v in tree_flatten(model.state_dict())}
            if expected != {k: tuple(v.shape) for k, v in weights.items()}:
                raise VoiceError("model_corrupt", "The stem splitter's weights don't fit the model.",
                                 "Remove it in VOICES → Models and install it again.", status=500,
                                 model_id=models.STEMS.id)
            model.update(tree_unflatten(list(weights.items())))
            model.eval()
            mx.eval(model.parameters())
            self._model = model
        return self._model

    def try_unload(self) -> bool:
        """Unload unless a separation is running (then False): before the model's files go."""
        if not self._lock.acquire(blocking=False):
            return False
        try:
            self._model = None
            return True
        finally:
            self._lock.release()

    def separate(self, audio: np.ndarray, sr: int, progress: Progress) -> dict[str, np.ndarray]:
        x = np.asarray(audio, dtype=np.float32)
        if x.ndim == 1:
            x = x[None]
        if x.ndim != 2 or x.shape[1] == 0:
            raise VoiceError("invalid_request", "The song has no audio to split.")
        channels, n = x.shape
        stereo = np.stack([x[0], x[0]]) if channels == 1 else x[:2]
        stereo = resample(stereo, sr, MODEL_SR)
        progress(0.0, "Loading the stem splitter…")
        with self._lock:
            import mlx.core as mx
            from ._demucs.apply_mlx import apply_model

            model = self._load()
            seg = int(MODEL_SR * float(model.segment))
            total = len(range(0, stereo.shape[1], int((1 - OVERLAP) * seg)))
            try:
                out = apply_model(_Counted(model, total, progress), mx.array(stereo)[None], shifts=1,
                                  overlap=OVERLAP, batch_size=BATCH, seed=0)
                est = np.asarray(out[0], dtype=np.float32)  # (sources, 2, n44)
            finally:
                mx.clear_cache()
        stems: dict[str, np.ndarray] = {}
        for name in STEM_NAMES:
            s = _fit(resample(est[list(model.sources).index(name)], MODEL_SR, sr), n)
            stems[name] = s.mean(axis=0, keepdims=True) if channels == 1 else s
        progress(1.0, "Stems ready.")
        return stems


def _fit(x: np.ndarray, n: int) -> np.ndarray:
    """Exactly n samples: resampling can be a sample off either way."""
    if x.shape[1] >= n:
        return np.ascontiguousarray(x[:, :n], dtype=np.float32)
    return np.pad(x, ((0, 0), (0, n - x.shape[1]))).astype(np.float32)


_splitter: StemSplitter | None = None
_splitter_lock = threading.Lock()


def get_splitter() -> StemSplitter:
    global _splitter
    with _splitter_lock:
        if _splitter is None:
            _splitter = StemSplitter()
        return _splitter
