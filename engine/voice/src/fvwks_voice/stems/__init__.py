"""Song stems (v0.9): drums, bass, vocals and other, for the visuals.

Meta's HT-Demucs (htdemucs, MIT) on the Apple GPU: demucs-mlx's MLX model classes, vendored in _demucs (no runtime
dependency), with mlx-community's fp16 conversion of the official weights (the stems-htdemucs model, 84 MB). They are
loaded here directly, so nothing ever converts from PyTorch. The song is resampled to the model's 44.1 kHz and split the way Demucs does it by default
(7.8 s segments, 25% overlap, one shift); each stem comes back at the input's rate, length and channel count.

Then, in one STFT pass (refine), two clean-ups for bass music (the user's "stems bleed together"):
- sharpening: each stem's share of each time-frequency bin raised to `sharpen_p` (2: Wiener-like; the vocals gentler,
  `vocal_p`, so a voice isn't left watery) and re-applied to the mix, so a bin goes mostly to one stem (and the four sum
  back to the mix exactly);
- 808 routing: below ~100 Hz the drums keep only ~80 ms after each hit, the 808's sustained sub goes to the bass (HT-
  Demucs, trained on pop and rock, leaves it in the drums);
- the vocal residue gate: where the vocals sit `vocal_gate_db` or more under the mix (a stretch with no voice, the
  vocals stem only leftovers: the user's "watery"), their energy goes to OTHER (50 ms attack, 200 ms release).
The user's A/B pick on a bass-music drop (2026-10-02). All off (1, 1, False, None): the model's stems as they come.
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
SHARPEN_P = 2.0  # 1: off
VOCAL_P = 1.2  # the vocals' own (1: off)
VOCAL_GATE_DB = -30.0  # None: off
GATE_ATTACK_S, GATE_RELEASE_S = 0.05, 0.2
ROUTE_808 = True
NFFT, HOP = 2048, 512  # 46 ms windows, 11.6 ms hops at 44.1 kHz
SUB_HZ = (90.0, 120.0)  # the 808 routing's band: all of it below 90 Hz, fading out by 120
HIT_KEEP_S, HIT_FADE_S = 0.08, 0.03  # the drums keep this much sub after a hit, fading out over this
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

    def separate(self, audio: np.ndarray, sr: int, progress: Progress, sharpen_p: float = SHARPEN_P,
                 route_808: bool = ROUTE_808, vocal_p: float = VOCAL_P,
                 vocal_gate_db: float | None = VOCAL_GATE_DB) -> dict[str, np.ndarray]:
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
        refined = refine(stereo, {name: est[i] for i, name in enumerate(model.sources)}, sharpen_p, route_808,
                         vocal_p=vocal_p, vocal_gate_db=vocal_gate_db)
        stems: dict[str, np.ndarray] = {}
        for name in STEM_NAMES:
            s = _fit(resample(refined[name], MODEL_SR, sr), n)
            stems[name] = s.mean(axis=0, keepdims=True) if channels == 1 else s
        progress(1.0, "Stems ready.")
        return stems


def refine(mix: np.ndarray, est: dict[str, np.ndarray], sharpen_p: float = SHARPEN_P, route_808: bool = ROUTE_808,
           sr: int = MODEL_SR, vocal_p: float = VOCAL_P, vocal_gate_db: float | None = VOCAL_GATE_DB) -> dict[str, np.ndarray]:
    """The model's stems (each (channels, n) at `sr`, `mix` the same) sharpened, the 808's sub routed to the bass and
    the vocals' leftovers gated into OTHER, in one STFT pass; as they came with none of them."""
    exponent = {k: (vocal_p if k == "vocals" else sharpen_p) for k in est}
    if all(p == 1 for p in exponent.values()) and not route_808 and vocal_gate_db is None:
        return est
    from scipy.signal import istft, stft

    n = mix.shape[-1]
    spec = lambda x: stft(x, sr, nperseg=NFFT, noverlap=NFFT - HOP)[2]  # noqa: E731
    S = {k: spec(v) for k, v in est.items()}  # (channels, bins, frames)
    M = spec(mix)
    if any(p != 1 for p in exponent.values()):
        power = {k: np.abs(v) ** exponent[k] for k, v in S.items()}
        total = sum(power.values()) + 1e-12
        S = {k: M * (p / total) for k, p in power.items()}  # the shares sum to 1: the stems sum to the mix
    if route_808 and "drums" in S and "bass" in S:
        f = np.fft.rfftfreq(NFFT, 1 / sr)
        band = np.clip((SUB_HZ[1] - f) / (SUB_HZ[1] - SUB_HZ[0]), 0.0, 1.0)[:, None]  # 1 below 90 Hz, 0 by 120
        moved = S["drums"] * band * (1.0 - _hit_windows(S["drums"], sr))[None, None, :]
        S["drums"], S["bass"] = S["drums"] - moved, S["bass"] + moved
    if vocal_gate_db is not None and "vocals" in S and "other" in S:
        gone = S["vocals"] * (1.0 - _vocal_gate(S["vocals"], M, vocal_gate_db, sr))[None, None, :]
        S["vocals"], S["other"] = S["vocals"] - gone, S["other"] + gone
    out = {k: istft(v, sr, nperseg=NFFT, noverlap=NFFT - HOP)[1] for k, v in S.items()}
    return {k: _fit(np.atleast_2d(v), n) for k, v in out.items()}


def _vocal_gate(vocals: np.ndarray, mix: np.ndarray, floor_db: float, sr: int) -> np.ndarray:
    """Per frame, 1 where the vocals are within `floor_db` of the mix, 0 where they sit further under it (only
    leftovers), opening over GATE_ATTACK_S and closing over GATE_RELEASE_S (no pumping, no chop)."""
    ev = (np.abs(vocals) ** 2).sum(axis=(0, 1))
    em = (np.abs(mix) ** 2).sum(axis=(0, 1)) + 1e-12
    want = (10 * np.log10(ev / em + 1e-12) > floor_db).astype(float)
    attack, release = np.exp(-HOP / sr / GATE_ATTACK_S), np.exp(-HOP / sr / GATE_RELEASE_S)
    g, x = np.empty_like(want), 0.0
    for i, w in enumerate(want):
        x = w + (x - w) * (attack if w > x else release)
        g[i] = x
    return g


def _hit_windows(drums: np.ndarray, sr: int) -> np.ndarray:
    """Per frame, 1 within HIT_KEEP_S after a low drum hit (a jump in the drums' flux below 150 Hz: kicks and 808s, not
    hats), fading to 0 over HIT_FADE_S after it: where the drums keep their sub."""
    f = np.fft.rfftfreq(NFFT, 1 / sr)
    mag = np.abs(drums).mean(axis=0)[f < 150]  # (low bins, frames)
    flux = np.maximum(0.0, np.diff(mag, axis=1, prepend=mag[:, :1])).sum(axis=0)
    # a hit: a local peak well up among the strongest (relative, so a quiet track still has hits), 100 ms apart at least
    thresh = max(np.median(flux) + 3 * np.median(np.abs(flux - np.median(flux))), 0.25 * np.percentile(flux, 99)) + 1e-9
    peaks = np.flatnonzero((flux > thresh) & (flux >= np.roll(flux, 1)) & (flux >= np.roll(flux, -1)))
    gap, hits = int(round(0.1 * sr / HOP)), []
    for h in peaks[np.argsort(-flux[peaks])]:
        if all(abs(h - k) >= gap for k in hits):
            hits.append(int(h))
    keep, fade = int(round(HIT_KEEP_S * sr / HOP)), max(1, int(round(HIT_FADE_S * sr / HOP)))
    shape = np.concatenate([np.ones(keep + 1), np.linspace(1.0, 0.0, fade + 1)[1:]])
    w = np.zeros(mag.shape[1])
    for h in hits:
        a = max(0, h - 1)  # from a hop before it: the attack
        seg = shape[: len(w) - a]
        w[a : a + len(seg)] = np.maximum(w[a : a + len(seg)], seg)
    return w


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
