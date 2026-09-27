"""DeepFilterNet3 (mlx-audio, MIT) for recordings: full-band 48 kHz, delay-compensated, about 0.05x real time.

`strength` mixes the enhanced signal with the input (1.0 = fully denoised, 0.0 = untouched). The model has no
latency after its own compensation, so the mix is sample-aligned. Measured on a clean Kokoro line with added
noise (SI-SDR against the clean line; sibilant = 4-10 kHz energy in speech frames):
- white 15 dB SNR: 15.0 -> 24.0 dB, sibilants 70%; pink 15 dB: 15.0 -> 20.5 dB, sibilants 81%
- hum + rumble 5 dB: 5.1 -> 20.0 dB, sibilants 95%; clean input passes almost untouched (36 dB, 95%)
- limits: very heavy broadband noise (5 dB SNR) costs consonants (26-42% of the sibilant energy), and it can't
  separate a competing voice (babble at 5 dB SNR gets worse). Lower `strength` for those takes.
"""

from __future__ import annotations

import threading
from typing import Any

import numpy as np

from . import models
from .util import quiet

SR = 48_000
DEFAULT_STRENGTH = 1.0
_BLOCK_S = 30.0
_OVERLAP_S = 0.5


class Denoiser:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._model: Any = None

    def is_installed(self) -> bool:
        return models.is_installed(models.DENOISE)

    def _load(self) -> Any:
        if self._model is None:
            from mlx_audio.sts.models.deepfilternet import DeepFilterNetModel

            path = models.repo_path(models.DENOISE, models.DF3_REPO)
            if path is None:
                from .errors import VoiceError

                raise VoiceError("model_not_installed", "The DeepFilterNet3 denoiser isn't installed.",
                                 "Install it from VOICES → Models (8.7 MB).", status=503, model_id=models.DENOISE.id)
            with quiet():
                self._model = DeepFilterNetModel.from_pretrained(str(path), subfolder=None)
        return self._model

    def enhance(self, x: np.ndarray, strength: float = DEFAULT_STRENGTH) -> np.ndarray:
        """Denoise mono 48 kHz audio. Long files go through in 30 s blocks with short cross-fades."""
        strength = float(np.clip(strength, 0.0, 1.0))
        x = np.asarray(x, dtype=np.float32)
        if strength <= 0.0 or x.size == 0:
            return x
        import mlx.core as mx

        with self._lock:
            model = self._load()
            try:
                y = self._blocks(model, x)
            finally:
                mx.clear_cache()
        return (strength * y + (1.0 - strength) * x).astype(np.float32)

    @staticmethod
    def _blocks(model: Any, x: np.ndarray) -> np.ndarray:
        block, ov = int(_BLOCK_S * SR), int(_OVERLAP_S * SR)
        if x.size <= block + ov:
            return model.enhance_array(x)
        out = np.zeros_like(x)
        ramp = np.linspace(0.0, 1.0, ov, dtype=np.float32)
        pos = 0
        while pos < x.size:
            a, b = max(0, pos - ov), min(x.size, pos + block)
            y = model.enhance_array(x[a:b])
            if a < pos:  # cross-fade the overlap with the previous block
                y[: pos - a] *= ramp[: pos - a]
                out[a:pos] *= 1.0 - ramp[: pos - a]
            out[a:b] += y
            pos = b
        return out


_denoiser: Denoiser | None = None
_denoiser_lock = threading.Lock()


def get_denoiser() -> Denoiser:
    global _denoiser
    with _denoiser_lock:
        if _denoiser is None:
            _denoiser = Denoiser()
        return _denoiser
