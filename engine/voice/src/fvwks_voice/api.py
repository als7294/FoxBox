"""fvwks_voice public seam, FoxBox 2.0: the stem splitter and its model (fvwks_contracts.seam's VoiceHooks).
fvwks_server is the only caller; it calls these from worker threads and serializes the splitter.

- separate_stems(audio, sr, progress) -> {drums, bass, vocals, other}: HT-Demucs on MLX, the stems-htdemucs model
  (84 MB, never required at boot: it downloads on the first split). About 25x realtime or better on Apple silicon,
  so it runs in the server's song_stems job.
- list_models() / install_model(model_id, progress) / uninstall_model(model_id) / apply_model_manifest(manifest)
- configure(data_dir): called once at engine start with <engine data dir>/voice (the model pins a manifest set).
- ENGINE_NAME, STEMS_ENGINE (the stems cache's salt: the splitter's pinned model revision).

Failures raise fvwks_voice.errors.VoiceError (code, message, hint, HTTP status).
"""
from __future__ import annotations

from pathlib import Path
from typing import Callable

import numpy as np

from fvwks_contracts.models import ModelInfo, ModelManifest

from . import models
from .errors import VoiceError
from .stems import get_splitter

ENGINE_NAME = "demucs-mlx"


def _stems_engine() -> str:
    """The stems' content-address salt: the model revision in use, so code-only updates keep old splits."""
    used = models.active(models.STEMS) or models.STEMS
    return f"htdemucs-mlx@{used.repos[0].revision[:12]}"


STEMS_ENGINE = _stems_engine()


def configure(data_dir: Path) -> None:
    """Called once at engine start with <engine data dir>/voice: the model pins a manifest set earlier."""
    global STEMS_ENGINE
    models.configure(Path(data_dir))
    STEMS_ENGINE = _stems_engine()


# -- models -------------------------------------------------------------------------------------
def list_models() -> list[ModelInfo]:
    return [models.model_info(spec) for spec in models.MODELS.values()]


def _model(model_id: str) -> models.ModelSpec:
    spec = models.MODELS.get(model_id)
    if spec is None:
        raise VoiceError("not_found", f"Unknown model {model_id!r}.", "GET /api/models lists them.", status=404)
    return spec


def install_model(model_id: str, progress: Callable[..., None]) -> None:
    """Blocking download (run it in a background job), or the update a manifest pinned. progress(fraction, message)
    also gets bytes_done, bytes_total and current_item as keywords when it takes **kwargs. It raises when the user
    cancels; that exception propagates after the download is stopped."""
    models.install(_model(model_id), progress)


def uninstall_model(model_id: str) -> None:
    """Remove a model's files; list_models() then shows it not installed. A splitter mid-split is model_busy (409);
    an idle one is unloaded first."""
    spec = _model(model_id)
    if spec.required:
        raise VoiceError("model_required", f"{spec.name} is required, so it can't be removed.", status=409)
    if model_id == models.STEMS.id and not get_splitter().try_unload():
        raise VoiceError("model_busy", f"{spec.name} is in use.", "Try again when it has finished.", status=409)
    models.uninstall(spec)


def apply_model_manifest(manifest: ModelManifest) -> list[ModelInfo]:
    """Take newer pins from a model manifest the server has verified, then list the models (versions,
    update_available). Only revisions of the same repos move; install_model() downloads them and re-checks file names
    and license with the Hub first."""
    global STEMS_ENGINE
    models.apply_manifest(manifest)
    STEMS_ENGINE = _stems_engine()
    return list_models()


# -- stems --------------------------------------------------------------------------------------
def separate_stems(audio: np.ndarray, sr: int,
                   progress: Callable[[float | None, str | None], None]) -> dict[str, np.ndarray]:
    """A song split into drums, bass, vocals and other: each (channels, n) float32 at `sr`, the same length as
    `audio`. Raises model_not_installed (model_id stems-htdemucs) without the stem splitter."""
    return get_splitter().separate(audio, int(sr), progress)
