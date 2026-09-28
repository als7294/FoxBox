# Vendored from mlx-spectro 0.9.7 (MIT; Copyright (c) 2026 ssmall256). See LICENSE.
"""Reusable MLX spectral ops for STFT, mel, MFCC, and hybrid-CQT frontends."""

from collections import Counter, OrderedDict, deque
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal, Optional, Union

import mlx.core as mx

__all__ = [
    "FilteredSpectrogramResult",
    "STFTFeatures",
    "RepeatedShapeCompileCache",
    "SpectralTransform",
    "MelSpectrogramTransform",
    "LogMelSpectrogramTransform",
    "FilteredSpectrogramTransform",
    "HybridCQTTransform",
    "MFCCTransform",
    "SpectralFeatureTransform",
    "ISTFTBackendPolicy",
    "STFTOutputLayout",
    "CenterPadMode",
    "CenterTailPad",
    "MelScale",
    "MelNorm",
    "MelMode",
    "MelOutputScale",
    "LogMelMode",
    "FilteredOutputScale",
    "WindowLike",
    "make_window",
    "melscale_fbanks",
    "fft_frequencies",
    "log_frequencies",
    "frequencies_to_bins",
    "triangular_filterbank",
    "mel_filterbank",
    "rectangular_filterbank",
    "logarithmic_spectrogram",
    "amplitude_to_db",
    "dct_matrix",
    "log_triangular_fbanks",
    "filtered_transform_from_filterbank",
    "cached_filtered_transform",
    "cached_log_filterbank",
    "cached_mel_filterbank",
    "compute_filtered_spectrogram",
    "compute_filtered_spectrogram_at_starts",
    "compute_filtered_spectrogram_at_fps",
    "compute_filtered_spectrogram_mlx",
    "compute_log_filtered_spectrogram",
    "compute_mel_spectrogram",
    "compute_mel_spectrogram_mlx",
    "trim_to_shortest",
    "repeat_pad_frames",
    "stack_feature_blocks",
    "positive_spectral_diff_numpy",
    "madmom_multires_log_diff_features",
    "madmom_multires_log_diff_features_mlx",
    "madmom_multires_mel_stack",
    "madmom_multires_mel_stack_mlx",
    "madmom_single_resolution_log_stack",
    "madmom_single_resolution_log_stack_mlx",
    "filtered_spectrogram",
    "filtered_spectrogram_at_starts",
    "filtered_spectrogram_at_fps",
    "hybrid_cqt",
    "frame_starts_from_fps",
    "hop_size_from_fps",
    "frame_origin_from_mode",
    "num_frames_for_hop",
    "stft_features_at_fps",
    "diff_frames_from_hann",
    "positive_spectral_diff",
    "phase_deviation",
    "weighted_phase_deviation",
    "normalized_weighted_phase_deviation",
    "local_group_delay",
    "complex_domain_odf",
    "rectified_complex_domain_odf",
    "high_frequency_content_odf",
    "spectral_flux_odf",
    "superflux_odf",
    "modified_kullback_leibler_odf",
    "complex_flux_odf",
    "spectral_odf",
    "mfcc",
    "chroma_stft",
    "spectral_features",
    "spectral_centroid",
    "spectral_bandwidth",
    "spectral_rolloff",
    "spectral_contrast",
    "rms",
    "zero_crossing_rate",
    "resolve_fft_params",
    "get_transform_mlx",
    "spec_mlx_device_key",
    "get_cache_debug_stats",
    "reset_cache_debug_stats",
]

import hashlib
import json
import math
import os
import sys
import threading
import time
import warnings
from pathlib import Path
from typing import Any, Dict, Tuple

import numpy as np

ISTFTBackendPolicy = Literal["auto", "mlx_fft", "metal", "torch_fallback"]
STFTOutputLayout = Literal["bfn", "bnf"]
CenterPadMode = Literal["reflect", "constant"]
CenterTailPad = Literal["symmetric", "minimal"]
MelScale = Literal["htk", "slaney"]
MelNorm = Literal["slaney"] | None
MelMode = Literal["mlx_native", "torchaudio_compat", "default"]
MelOutputScale = Literal["linear", "log", "db"]
LogMelMode = Literal["clamp", "add", "log1p"]
FilteredOutputScale = Literal["linear", "log", "db", "log10_plus_one"]
FramingEnd = Literal["normal", "extend"]

DEFAULT_SAMPLE_RATE = 44_100
DEFAULT_FMIN = 30.0
DEFAULT_FMAX = 17_000.0
DEFAULT_FREF = 440.0


@dataclass(frozen=True)
class FilteredSpectrogramResult:
    spectrogram: np.ndarray
    filterbank: np.ndarray


@dataclass(frozen=True)
class STFTFeatures:
    stft: np.ndarray
    magnitude: np.ndarray
    phase: np.ndarray
    bin_frequencies: np.ndarray


class RepeatedShapeCompileCache:
    """Promote repeated input shapes to bounded shape-specialized compiled callables.

    This is intended for wrapper code that mostly sees variable-length audio but
    still encounters a small repeated set of shapes in steady-state workloads.
    The helper only manages shape hit counting and compiled-callable caching; the
    caller still owns the eager fallback path.
    """

    __slots__ = (
        "_compile_factory",
        "_min_hits",
        "_max_compiled_shapes",
        "_max_pending_shapes",
        "_pending_hits",
        "_compiled",
    )

    def __init__(
        self,
        compile_factory,
        *,
        min_hits: int = 2,
        max_compiled_shapes: int = 8,
        max_pending_shapes: Optional[int] = None,
    ) -> None:
        if min_hits < 1:
            raise ValueError("min_hits must be >= 1")
        if max_compiled_shapes < 1:
            raise ValueError("max_compiled_shapes must be >= 1")
        if max_pending_shapes is None:
            max_pending_shapes = max(16, max_compiled_shapes * 4)
        if max_pending_shapes < 1:
            raise ValueError("max_pending_shapes must be >= 1")

        self._compile_factory = compile_factory
        self._min_hits = int(min_hits)
        self._max_compiled_shapes = int(max_compiled_shapes)
        self._max_pending_shapes = int(max_pending_shapes)
        self._pending_hits: OrderedDict[tuple[int, ...], int] = OrderedDict()
        self._compiled: OrderedDict[tuple[int, ...], Any] = OrderedDict()

    @staticmethod
    def _normalize_shape(shape: Any) -> tuple[int, ...]:
        if isinstance(shape, tuple):
            return tuple(int(dim) for dim in shape)
        return tuple(int(dim) for dim in tuple(shape))

    def get(self, shape: Any):
        shape_key = self._normalize_shape(shape)

        cached = self._compiled.get(shape_key)
        if cached is not None:
            self._compiled.move_to_end(shape_key)
            _record_cache_event("shape_compile_cache.hit", key=shape_key)
            return cached

        hits = self._pending_hits.get(shape_key, 0) + 1
        self._pending_hits[shape_key] = hits
        self._pending_hits.move_to_end(shape_key)
        if len(self._pending_hits) > self._max_pending_shapes:
            evicted_shape, _ = self._pending_hits.popitem(last=False)
            _record_cache_event("shape_compile_cache.pending_evict", key=evicted_shape)

        if hits < self._min_hits:
            _record_cache_event("shape_compile_cache.miss", key=shape_key, detail=f"hits={hits}")
            return None

        compiled = self._compile_factory(shape_key)
        if len(self._compiled) >= self._max_compiled_shapes:
            evicted_shape, _ = self._compiled.popitem(last=False)
            _record_cache_event("shape_compile_cache.compiled_evict", key=evicted_shape)
        self._compiled[shape_key] = compiled
        self._pending_hits.pop(shape_key, None)
        _record_cache_event("shape_compile_cache.promote", key=shape_key)
        return compiled

    def clear(self) -> None:
        self._pending_hits.clear()
        self._compiled.clear()

    def cache_info(self) -> dict[str, Any]:
        return {
            "min_hits": self._min_hits,
            "max_compiled_shapes": self._max_compiled_shapes,
            "max_pending_shapes": self._max_pending_shapes,
            "pending_shapes": len(self._pending_hits),
            "compiled_shapes": len(self._compiled),
            "compiled_shape_keys": list(self._compiled.keys()),
        }

_CACHE_STATS_ENABLED = (
    os.environ.get("SPEC_MLX_CACHE_STATS", "0").lower()
    not in ("0", "false", "no", "off")
)
_CACHE_STATS_TRACE = _CACHE_STATS_ENABLED and (
    os.environ.get("SPEC_MLX_CACHE_STATS_TRACE", "0").lower() in ("1", "true", "yes", "on")
)
try:
    _CACHE_STATS_TRACE_MAX_RAW = int(os.environ.get("SPEC_MLX_CACHE_STATS_TRACE_MAX", "128"))
except Exception:
    _CACHE_STATS_TRACE_MAX_RAW = 128
_CACHE_STATS_TRACE_MAX = max(16, _CACHE_STATS_TRACE_MAX_RAW)
_CACHE_STATS_LOCK = threading.Lock()
_CACHE_STATS_COUNTS: Counter[str] = Counter()
_CACHE_STATS_LAST_KEY: Dict[str, str] = {}
_CACHE_STATS_RECENT: deque = deque(maxlen=_CACHE_STATS_TRACE_MAX)


def _summarize_cache_key(key: Any) -> str:
    if isinstance(key, tuple):
        head = ", ".join(type(v).__name__ for v in key[:4])
        return f"tuple(len={len(key)}, types=[{head}])"
    if isinstance(key, dict):
        keys = list(key.keys())[:6]
        return f"dict(keys={keys})"
    if hasattr(key, "shape"):
        shape = getattr(key, "shape", None)
        return f"{type(key).__name__}(shape={tuple(int(d) for d in shape)})"
    return type(key).__name__


if _CACHE_STATS_ENABLED:
    def _record_cache_event(name: str, *, key: Any = None, detail: Optional[str] = None) -> None:
        with _CACHE_STATS_LOCK:
            _CACHE_STATS_COUNTS[name] += 1
            if key is not None:
                _CACHE_STATS_LAST_KEY[name] = _summarize_cache_key(key)
            if _CACHE_STATS_TRACE:
                item = {"event": str(name)}
                if key is not None:
                    item["key"] = _summarize_cache_key(key)
                if detail is not None:
                    item["detail"] = str(detail)
                _CACHE_STATS_RECENT.append(item)
else:
    def _record_cache_event(name: str, *, key: Any = None, detail: Optional[str] = None) -> None:
        return None


def reset_cache_debug_stats() -> None:
    with _CACHE_STATS_LOCK:
        _CACHE_STATS_COUNTS.clear()
        _CACHE_STATS_LAST_KEY.clear()
        _CACHE_STATS_RECENT.clear()


def get_cache_debug_stats(*, reset: bool = False) -> dict:
    """Return lightweight cache/debug counters for runtime tuning.

    Includes cache hit/miss/eviction counters plus representative key-shape hints.
    """
    with _CACHE_STATS_LOCK:
        payload = {
            "enabled": bool(_CACHE_STATS_ENABLED),
            "counts": dict(_CACHE_STATS_COUNTS),
            "last_key_shapes": dict(_CACHE_STATS_LAST_KEY),
            "recent_events": list(_CACHE_STATS_RECENT),
        }
    payload["kernel_cache"] = _KernelCache.debug_snapshot()
    payload["transform_cache"] = dict(_get_transform_cached.cache_info()._asdict())
    if reset:
        reset_cache_debug_stats()
    return payload

def _default_cache_path() -> Path:
    # Allow override
    override = os.environ.get("SPEC_MLX_AUTOTUNE_CACHE_PATH")
    if override:
        return Path(override).expanduser()

    home = Path.home()

    # macOS
    if sys.platform == "darwin":
        base = home / "Library" / "Caches"
    # Windows
    elif os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", str(home / "AppData" / "Local")))
    # Linux/others
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME", str(home / ".cache")))

    return base / "mlx-spectro" / "spec_mlx_autotune.json"


def _encode_key(device_key: str, kernel_name: str, n_fft: int, hop: int) -> str:
    # Stable, JSON-friendly
    return f"{device_key}||{kernel_name}||{int(n_fft)}||{int(hop)}"


def _decode_key(k: str) -> Optional[Tuple[str, str, int, int]]:
    try:
        device_key, kernel_name, n_fft_s, hop_s = k.split("||", 3)
        return device_key, kernel_name, int(n_fft_s), int(hop_s)
    except Exception:
        return None


def _atomic_write_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    data = json.dumps(obj, indent=2, sort_keys=True)

    tmp.write_text(data, encoding="utf-8")
    # Atomic on POSIX + Windows when replacing in same directory
    tmp.replace(path)


# ==============================================================================
# Autotuning configuration
# ==============================================================================
# Set SPEC_MLX_AUTOTUNE=0 to disable autotuning (fallback to 256).
_SPEC_MLX_AUTOTUNE = (
    os.environ.get("SPEC_MLX_AUTOTUNE", "1").lower()
    not in ("0", "false", "no", "off")
)


def _parse_tgx_int(raw: str) -> Optional[int]:
    try:
        v = int(str(raw).strip())
    except Exception:
        return None
    return v if v > 0 else None


def _resolve_manual_tgx_override(kernel_name: str) -> Optional[int]:
    """Return explicit threadgroup override from SPEC_MLX_TGX, if present.

    Supported forms:
    - "256" (global override)
    - "kernel_name:256,other_kernel:512,*:128" (per-kernel with optional wildcard)
    """
    raw = os.environ.get("SPEC_MLX_TGX", "").strip()
    if not raw:
        return None

    # Simple global override, e.g. SPEC_MLX_TGX=256
    if ":" not in raw and "," not in raw:
        return _parse_tgx_int(raw)

    wildcard: Optional[int] = None
    for token in raw.split(","):
        token = token.strip()
        if not token:
            continue
        if ":" not in token:
            tgx = _parse_tgx_int(token)
            if tgx is not None:
                wildcard = tgx
            continue
        k, v = token.split(":", 1)
        k = k.strip()
        tgx = _parse_tgx_int(v)
        if tgx is None:
            continue
        if k == kernel_name:
            return tgx
        if k == "*":
            wildcard = tgx
    return wildcard

@lru_cache(maxsize=1)
def spec_mlx_device_key() -> str:
    """Best-effort device identifier for caching autotune results.

    We keep this extremely defensive because MLX APIs can differ by version.
    """
    # Prefer MLX metal device name if available.
    try:
        metal = getattr(mx, "metal", None)
        if metal is not None:
            name_fn = getattr(metal, "device_name", None)
            if callable(name_fn):
                name = name_fn()
                if name:
                    return str(name)
    except Exception:
        pass

    # Fallback to default_device / current_device if available.
    for attr in ("default_device", "current_device", "device"):
        try:
            fn = getattr(mx, attr, None)
            if callable(fn):
                dev = fn()
                if dev is not None:
                    return str(dev)
        except Exception:
            pass

    # Last resort: backend hint or platform.
    return os.environ.get("MLX_BACKEND", "metal")


# ==============================================================================
# Metal Kernels
# ==============================================================================

# Shared k-bounds macro, prepended to each kernel source.
# Computes the range of overlapping frames [k_min, k_max] for output sample `st`.
# HOP, FRAME are compile-time template constants.
# n_frames and out_len are runtime values loaded from a `params` int32 buffer.
_METAL_K_BOUNDS = """
int k_max = st / HOP;
if (k_max >= n_frames) k_max = n_frames - 1;
int k_min = 0;
{ int target = st - FRAME; if (target >= 0) k_min = (target / HOP) + 1; }
"""

# --- 1) Metal Kernel: Gather-style OLA ---
# Type-polymorphic template; float32 accumulation, cast to T on output.
# Dynamic lengths (n_frames, out_len) are passed via `params` buffer to avoid
# kernel recompilation for every unique audio length.
# UNROLL_K is a compile-time template constant = min(FRAME/HOP, 8), matching
# the overlap ratio so the compiler can fully unroll common cases (e.g. 4 for
# standard 4× overlap, 8 for high-overlap configs). See _unroll_k for why it is
# clamped below.
def _unroll_k(frame: int, hop: int) -> int:
    """Overlap ratio for `#pragma unroll UNROLL_K`, clamped to a legal value.

    A hop larger than the frame is a legitimate, if unusual, configuration --
    frames simply do not overlap -- and integer division then yields 0. Metal
    rejects `#pragma unroll 0` outright ("invalid value '0'; must be positive"),
    so the kernel fails to build and istft raises instead of reconstructing.
    Clamping to 1 restores the pre-0.8 behaviour, where the pragma was a
    literal.
    """
    if hop <= 0:
        return 1
    return max(1, min(frame // hop, 8))


_METAL_OLA_TEMPLATE = """
int n_frames = params[0];
int out_len = params[1];
int st = (int)thread_position_in_grid.x;
int sb = (int)thread_position_in_grid.y;
if (st >= out_len) return;
""" + _METAL_K_BOUNDS + """
float acc = 0.0f;
int base_offset = sb * n_frames * FRAME;

#pragma unroll UNROLL_K
for (int k = k_max; k >= k_min; --k) {
    int off = st - k * HOP;
    acc += (float)frames[base_offset + k * FRAME + off] * (float)window[off];
}

out[sb * out_len + st] = (T)acc;
"""

# --- 2) Metal Kernel: Gather-style OLA + normalization ---
# Fused overlap-add with Torch-style masked divide by window² envelope.
_METAL_OLA_NORM_TEMPLATE = """
int n_frames = params[0];
int out_len = params[1];
int st = (int)thread_position_in_grid.x;
int sb = (int)thread_position_in_grid.y;
if (st >= out_len) return;
""" + _METAL_K_BOUNDS + """
float acc = 0.0f;
float den = 0.0f;
int base_offset = sb * n_frames * FRAME;

#pragma unroll UNROLL_K
for (int k = k_max; k >= k_min; --k) {
    int off = st - k * HOP;
    acc += (float)frames[base_offset + k * FRAME + off] * (float)window[off];
    den += (float)window_sq[off];
}

// Torch-style masked normalization (no epsilon clamp):
// keep zero where overlap-add envelope is effectively zero.
out[sb * out_len + st] = (den > 1.0e-11f) ? (T)(acc / den) : (T)(0.0f);
"""


# --- 3) Metal Kernel: OLA Envelope ---
# Computes window² overlap-add envelope (1-D, no batch dimension).
_METAL_OLA_ENVELOPE_TEMPLATE = """
int n_frames = params[0];
int out_len = params[1];
int st = (int)thread_position_in_grid.x;
if (st >= out_len) return;
""" + _METAL_K_BOUNDS + """
float den = 0.0f;

#pragma unroll UNROLL_K
for (int k = k_min; k <= k_max; ++k) {
    int off = st - k * HOP;
    den += (float)window_sq[off];
}

out[st] = (T)den;
"""

# --- 4) Metal Kernel: Fused windowed frame extraction ---
# Combines reflect-pad + as_strided + window multiply into a single pass.
# Reads directly from the unpadded signal with reflect-boundary indexing,
# multiplies by the analysis window, and writes windowed frames.
# Eliminates the padded-signal intermediate allocation entirely.
#
# Two variants:
#   Simple — Grid: (n_fft, n_frames, B).  One thread per (fft_bin, frame, batch).
#            Each thread reads one sample from global memory independently.
#   Tiled  — One threadgroup per tile of consecutive frames.  Loads the shared
#            signal chunk into threadgroup memory once, then each thread reads
#            from fast shared memory.  ~NFFT/HOP data reuse ratio (typically 4×).
#            Faster when the workload is bandwidth-bound (large B × sig_len).

_METAL_FUSED_FRAME_EXTRACT_TEMPLATE = """
int sig_len = params[0];
int n_frames = params[1];
int f_idx = (int)thread_position_in_grid.x;
int n_idx = (int)thread_position_in_grid.y;
int b_idx = (int)thread_position_in_grid.z;
if (f_idx >= NFFT || n_idx >= n_frames) return;

// Position in the (virtual) padded signal
int src_pos = n_idx * HOP + f_idx;

// Reflect-pad boundary: map to original signal index
int orig_idx;
if (src_pos < PAD) {
    orig_idx = PAD - src_pos;
} else if (src_pos < PAD + sig_len) {
    orig_idx = src_pos - PAD;
} else {
    orig_idx = sig_len - 2 - (src_pos - PAD - sig_len);
}

float val = (float)signal[b_idx * sig_len + orig_idx] * (float)win[f_idx];
out[b_idx * n_frames * NFFT + n_idx * NFFT + f_idx] = (T)val;
"""

_METAL_TILED_FRAME_EXTRACT_TEMPLATE = """
// Threadgroup shared memory for the signal chunk covering this tile of frames.
// CHUNK_LEN = (TILE_FRAMES - 1) * HOP + NFFT, sized at compile time.
threadgroup float shared_buf[CHUNK_LEN];

int sig_len = params[0];
int n_frames = params[1];

int local_x = (int)thread_position_in_threadgroup.x;
int local_y = (int)thread_position_in_threadgroup.y;
int tg_x_idx = (int)threadgroup_position_in_grid.x;
int b_idx = (int)threadgroup_position_in_grid.z;

// Frame range for this tile
int frame_start = tg_x_idx * TILE_FRAMES;
int frame_end = frame_start + TILE_FRAMES;
if (frame_end > n_frames) frame_end = n_frames;
int n_tile_frames = frame_end - frame_start;

// Virtual-padded range this tile needs
int sig_start = frame_start * HOP;
int sig_end_val = (frame_end - 1) * HOP + NFFT;
int chunk_len = sig_end_val - sig_start;

// Cooperative load: all threads load signal into shared memory
int n_threads = TG_X * TG_Y;
int my_id = local_y * TG_X + local_x;
for (int i = my_id; i < chunk_len; i += n_threads) {
    int src_pos = sig_start + i;
    int orig_idx;
    if (src_pos < PAD) {
        orig_idx = PAD - src_pos;
    } else if (src_pos < PAD + sig_len) {
        orig_idx = src_pos - PAD;
    } else {
        orig_idx = sig_len - 2 - (src_pos - PAD - sig_len);
    }
    shared_buf[i] = (float)signal[b_idx * sig_len + orig_idx];
}
threadgroup_barrier(mem_flags::mem_threadgroup);

// Each thread handles one frame in the tile, looping over fft bins
int tile_frame = local_y;
if (tile_frame < n_tile_frames) {
    int n_idx = frame_start + tile_frame;
    for (int f = local_x; f < NFFT; f += TG_X) {
        int local_pos = tile_frame * HOP + f;
        float val = shared_buf[local_pos] * (float)win[f];
        out[b_idx * n_frames * NFFT + n_idx * NFFT + f] = (T)val;
    }
}
"""

# --- 5) Metal Kernel: STFT backward (frame extract adjoint) ---
# Given grad_frames [B, N, n_fft], computes grad_signal [B, T].
# For each input position t, sums the gradient contributions from all overlapping
# frames, accounting for reflect-pad boundary conditions.
# Grid: (sig_len, B, 1).  One thread per (input_sample, batch).
#
# The adjoint of the windowed frame extraction is:
#   grad_signal[b, t] = Σ_n grad_frames[b, n, f] * window[f]
# where f = (t + pad) - n * hop, summing over all frames n where 0 <= f < NFFT.
# For reflect-pad positions, the gradient folds back to the mirrored interior position.
_METAL_STFT_BACKWARD_TEMPLATE = """
int sig_len = params[0];
int n_frames = params[1];
int t_idx = (int)thread_position_in_grid.x;
int b_idx = (int)thread_position_in_grid.y;
if (t_idx >= sig_len) return;

int base_offset = b_idx * n_frames * NFFT;
float acc = 0.0f;

// Interior contribution: padded position = t_idx + PAD
{
    int padded_pos = t_idx + PAD;
    int k_max = padded_pos / HOP;
    if (k_max >= n_frames) k_max = n_frames - 1;
    int k_min = 0;
    { int target = padded_pos - NFFT; if (target >= 0) k_min = (target / HOP) + 1; }

    #pragma unroll 4
    for (int k = k_min; k <= k_max; ++k) {
        int f = padded_pos - k * HOP;
        acc += (float)grad_frames[base_offset + k * NFFT + f] * (float)win[f];
    }
}

// Reflect-pad left: original position t_idx maps to padded position PAD - t_idx
// (for the reflected copy of x[t_idx] that appears in the left padding)
if (t_idx > 0 && t_idx <= PAD) {
    int padded_pos = PAD - t_idx;
    int k_max = padded_pos / HOP;
    if (k_max >= n_frames) k_max = n_frames - 1;
    int k_min = 0;
    { int target = padded_pos - NFFT; if (target >= 0) k_min = (target / HOP) + 1; }

    #pragma unroll 4
    for (int k = k_min; k <= k_max; ++k) {
        int f = padded_pos - k * HOP;
        acc += (float)grad_frames[base_offset + k * NFFT + f] * (float)win[f];
    }
}

// Reflect-pad right: original position t_idx maps to padded position
// PAD + 2*sig_len - 2 - t_idx  (for the reflected copy in the right padding)
// Valid when t_idx is in the range used by the right reflect: [sig_len-PAD-1, sig_len-2]
if (t_idx >= sig_len - PAD - 1 && t_idx < sig_len - 1) {
    int padded_pos = PAD + 2 * sig_len - 2 - t_idx;
    int padded_len = sig_len + 2 * PAD;
    if (padded_pos >= 0 && padded_pos < padded_len) {
        int k_max = padded_pos / HOP;
        if (k_max >= n_frames) k_max = n_frames - 1;
        int k_min = 0;
        { int target = padded_pos - NFFT; if (target >= 0) k_min = (target / HOP) + 1; }

        #pragma unroll 4
        for (int k = k_min; k <= k_max; ++k) {
            int f = padded_pos - k * HOP;
            acc += (float)grad_frames[base_offset + k * NFFT + f] * (float)win[f];
        }
    }
}

out[b_idx * sig_len + t_idx] = (T)acc;
"""

# --- 6) Metal Kernel: iSTFT backward (OLA adjoint) ---
# Given grad_output [B, out_len], computes grad_frames [B, N, n_fft].
# For each (b, n, f), gathers from grad_output and weights by window/envelope.
# Grid: (n_fft, n_frames, B).  One thread per (fft_bin, frame, batch).
#
# The adjoint of the fused OLA+norm is:
#   grad_frames[b, n, f] = grad_output[b, n*hop + f] * window[f] / envelope[n*hop + f]
_METAL_ISTFT_BACKWARD_TEMPLATE = """
int n_frames = params[0];
int out_len = params[1];
int f_idx = (int)thread_position_in_grid.x;
int n_idx = (int)thread_position_in_grid.y;
int b_idx = (int)thread_position_in_grid.z;
if (f_idx >= NFFT || n_idx >= n_frames) return;

int t = n_idx * HOP + f_idx;
float grad_val = 0.0f;

if (t < out_len) {
    grad_val = (float)grad_output[b_idx * out_len + t] * (float)win[f_idx] * (float)inv_envelope[t];
}

out[b_idx * n_frames * NFFT + n_idx * NFFT + f_idx] = (T)grad_val;
"""


# Minimum output bytes (B * n_frames * n_fft * 4) before using the tiled kernel.
# Below this threshold the autotuned simple kernel is faster or equivalent.
# Re-validated on M4 Max across 186 real-world consumer configs (20 projects,
# metalq-serialized): tiled wins 77% above 100 MB (avg 1.11x), only 14-44%
# below.  The advantage grows to 1.22x above 500 MB.  100 MB remains the
# optimal crossover point even after adding threadgroup autotuning to the
# simple kernel.
_TILED_FRAME_EXTRACT_BYTE_THRESHOLD = 100_000_000  # ~100 MB

# --- 7) Metal Kernel: Fused power spectrum ---
# Reads interleaved complex64 data (viewed as float32) and computes re²+im²
# in a single pass, avoiding the sqrt in mx.abs and eliminating intermediate
# buffers.  Grid: (total_complex_elements, 1, 1).
_METAL_POWER_SPECTRUM_TEMPLATE = """
uint i = thread_position_in_grid.x;
uint total = (uint)params[0];
if (i >= total) return;
float re = z_flat[2 * i];
float im = z_flat[2 * i + 1];
out[i] = re * re + im * im;
"""


_METAL_WARNED = False


def _warn_metal_unavailable(kernel_name: str, error: BaseException) -> None:
    """Warn once when a Metal kernel fails to compile.

    Every kernel compile site swallows the exception and latches a False
    sentinel, and the cache-event counters are no-ops unless
    SPEC_MLX_CACHE_STATS=1. A user whose Metal kernels fail therefore gets a
    slower, differently-rounded pure-MLX path silently and permanently. One
    warning is enough to make that diagnosable without becoming noise.
    """
    global _METAL_WARNED
    if _METAL_WARNED:
        return
    _METAL_WARNED = True
    warnings.warn(
        f"mlx-spectro: Metal kernel {kernel_name!r} failed to compile "
        f"({type(error).__name__}: {error}). Falling back to pure-MLX paths, "
        "which are slower and may round differently. Subsequent kernel "
        "failures will not be reported.",
        RuntimeWarning,
        stacklevel=2,
    )


_TRACED_AUTOTUNE_WARNED: set = set()
_TRACED_AUTOTUNE_WARNED_LOCK = threading.Lock()

# MLX raises from mx.eval when a trace is active. The message is the only
# signal it gives -- there is no public "am I being traced" predicate (mx.trace
# is the linear-algebra one), and the exception type has changed between MLX
# releases, so match on the text.
_TRACER_ERROR_MARKERS = (
    "during function transformations",
    "Attempting to eval an array during",
)


def _is_tracer_error(error: BaseException) -> bool:
    """True when `error` is MLX refusing an eval inside compile/vmap."""
    text = str(error)
    return any(marker in text for marker in _TRACER_ERROR_MARKERS)


def _warn_autotune_skipped_under_trace(
    kernel_name: str, n_fft: int, hop: int, default_tgx: int
) -> None:
    """Warn once per (kernel, n_fft, hop) that tuning was skipped.

    Autotuning times candidates with mx.eval, which MLX forbids inside
    mx.compile or vmap. Under a trace there is nothing to time, so the tuned
    value cannot be measured and must not be cached -- an untested entry would
    then be served to the eager path too. The default runs correctly; it is
    only unmeasured. Calling the transform once eagerly before compiling
    populates the cache and removes both the warning and the guess.
    """
    key = (str(kernel_name), int(n_fft), int(hop))
    with _TRACED_AUTOTUNE_WARNED_LOCK:
        if key in _TRACED_AUTOTUNE_WARNED:
            return
        _TRACED_AUTOTUNE_WARNED.add(key)
    warnings.warn(
        f"mlx-spectro: threadgroup autotuning for {kernel_name!r} "
        f"(n_fft={n_fft}, hop={hop}) was skipped because the call is inside "
        f"mx.compile or vmap, where timing runs are not possible. Using the "
        f"untuned default threadgroup.x={default_tgx}; results are correct "
        f"but may be slower. Call the transform once outside the compiled "
        f"function to tune and cache it.",
        RuntimeWarning,
        stacklevel=2,
    )


class _PowerSpectrumCache:
    """Singleton for the fused power-spectrum Metal kernel."""
    _lock = threading.Lock()
    _kernel: object = None

    @classmethod
    def get(cls):
        if cls._kernel is not None:
            return cls._kernel
        with cls._lock:
            if cls._kernel is not None:
                return cls._kernel
            try:
                cls._kernel = mx.fast.metal_kernel(
                    name="fused_power_spectrum",
                    input_names=["z_flat", "params"],
                    output_names=["out"],
                    source=_METAL_POWER_SPECTRUM_TEMPLATE,
                )
            except Exception as exc:
                cls._kernel = False
                _warn_metal_unavailable('fused_power_spectrum', exc)
            return cls._kernel


class _FrameExtractCache:
    """Singleton for the fused frame-extraction Metal kernels (simple + tiled)."""
    _lock = threading.Lock()
    _simple: object = None
    _tiled: object = None

    @classmethod
    def get_simple(cls):
        if cls._simple is not None:
            return cls._simple
        with cls._lock:
            if cls._simple is not None:
                return cls._simple
            try:
                cls._simple = mx.fast.metal_kernel(
                    name="fused_frame_extract",
                    input_names=["signal", "win", "params"],
                    output_names=["out"],
                    source=_METAL_FUSED_FRAME_EXTRACT_TEMPLATE,
                )
            except Exception as exc:
                cls._simple = False
                _warn_metal_unavailable('fused_frame_extract', exc)
            return cls._simple

    @classmethod
    def get_tiled(cls):
        if cls._tiled is not None:
            return cls._tiled
        with cls._lock:
            if cls._tiled is not None:
                return cls._tiled
            try:
                cls._tiled = mx.fast.metal_kernel(
                    name="tiled_frame_extract",
                    input_names=["signal", "win", "params"],
                    output_names=["out"],
                    source=_METAL_TILED_FRAME_EXTRACT_TEMPLATE,
                )
            except Exception as exc:
                cls._tiled = False
                _warn_metal_unavailable('tiled_frame_extract', exc)
            return cls._tiled

    @classmethod
    def get(cls):
        """Backward-compat: return the simple kernel."""
        return cls.get_simple()

    @classmethod
    def tile_params(cls, n_fft: int, hop_length: int) -> Optional[tuple]:
        """Compute tiling parameters that fit in 32 KB threadgroup memory.

        Returns (tile_frames, tg_x, tg_y, chunk_len) or None if tiling
        is not possible for this config.
        """
        max_shared_floats = 32768 // 4  # 8192 floats in 32 KB
        tile_frames = (max_shared_floats - n_fft) // hop_length + 1
        if tile_frames < 2:
            return None  # no reuse benefit with 1 frame per tile
        tg_x = min(256, n_fft)
        tg_y = tile_frames
        # Metal: max 1024 threads per threadgroup
        if tg_x * tg_y > 1024:
            tg_y = 1024 // tg_x
            tile_frames = tg_y
        if tile_frames < 2:
            return None
        chunk_len = (tile_frames - 1) * hop_length + n_fft
        return (tile_frames, tg_x, tg_y, chunk_len)


class _BackwardKernelCache:
    """Singleton cache for backward-pass Metal kernels."""
    _lock = threading.Lock()
    _stft_bwd: object = None
    _istft_bwd: object = None

    @classmethod
    def get_stft_backward(cls):
        if cls._stft_bwd is not None:
            return cls._stft_bwd
        with cls._lock:
            if cls._stft_bwd is not None:
                return cls._stft_bwd
            try:
                cls._stft_bwd = mx.fast.metal_kernel(
                    name="stft_backward",
                    input_names=["grad_frames", "win", "params"],
                    output_names=["out"],
                    source=_METAL_STFT_BACKWARD_TEMPLATE,
                )
            except Exception as exc:
                cls._stft_bwd = False
                _warn_metal_unavailable('stft_backward', exc)
            return cls._stft_bwd

    @classmethod
    def get_istft_backward(cls):
        if cls._istft_bwd is not None:
            return cls._istft_bwd
        with cls._lock:
            if cls._istft_bwd is not None:
                return cls._istft_bwd
            try:
                cls._istft_bwd = mx.fast.metal_kernel(
                    name="istft_backward",
                    input_names=["grad_output", "win", "inv_envelope", "params"],
                    output_names=["out"],
                    source=_METAL_ISTFT_BACKWARD_TEMPLATE,
                )
            except Exception as exc:
                cls._istft_bwd = False
                _warn_metal_unavailable('istft_backward', exc)
            return cls._istft_bwd


# Template-tuple tracking for params_cache.* debug events.
# Preserves backward compatibility with test assertions that check these counters.
_last_tmpl: Dict[str, tuple] = {}

def _record_tmpl_event(kernel_tag: str, tmpl: list) -> None:
    """Emit params_cache.hit / params_cache.miss based on template-tuple reuse."""
    key = tuple(tmpl)
    prev = _last_tmpl.get(kernel_tag)
    if prev == key:
        _record_cache_event("params_cache.hit", key=key, detail=kernel_tag)
    else:
        _record_cache_event("params_cache.miss", key=key, detail=kernel_tag)
        _last_tmpl[kernel_tag] = key


# ==============================================================================
# Kernel Cache Manager
# ==============================================================================

class _KernelCache:
    """Singleton to manage Metal kernel compilation and caching."""

    _lock = threading.Lock()

    _ola_kernel = None
    _ola_norm_kernel = None
    _envelope_kernel = None

    # Cache of autotuned threadgroup sizes:
    # key: (device_key, kernel_name, n_fft, hop) -> int threadgroup_x
    _tgx_cache: Dict[Tuple[str, str, int, int], int] = {}
    _tgx_cache_loaded: bool = False
    _tgx_cache_dirty: bool = False

    @classmethod
    def _max_entries(cls) -> int:
        raw = os.environ.get("SPEC_MLX_AUTOTUNE_MAX_ENTRIES", "").strip()
        try:
            v = int(raw) if raw else 500
        except Exception:
            v = 500
        return max(32, v)

    @classmethod
    def _trim_cache_locked(cls) -> None:
        # Keep cache bounded to avoid unbounded growth across many experiments.
        max_entries = cls._max_entries()
        extra = len(cls._tgx_cache) - max_entries
        if extra <= 0:
            return
        _record_cache_event("kernel_cache.tgx.evict", detail=f"count={int(extra)}")
        for k in list(cls._tgx_cache.keys())[:extra]:
            cls._tgx_cache.pop(k, None)

    @classmethod
    def _persist_enabled(cls) -> bool:
        return (
            os.environ.get("SPEC_MLX_AUTOTUNE_PERSIST", "0").lower()
            not in ("0", "false", "no", "off")
        )

    @classmethod
    def _load_tgx_cache_from_disk(cls) -> None:
        # Caller is expected to hold cls._lock.
        if cls._tgx_cache_loaded:
            return
        cls._tgx_cache_loaded = True

        if not cls._persist_enabled():
            _record_cache_event("kernel_cache.tgx.load.skipped_persist_off")
            return

        path = _default_cache_path()
        if not path.exists():
            _record_cache_event("kernel_cache.tgx.load.miss_file", detail=str(path))
            return

        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if payload.get("version") != 1:
                _record_cache_event("kernel_cache.tgx.load.version_mismatch")
                return
            raw = payload.get("tgx_cache", {})
            if not isinstance(raw, dict):
                _record_cache_event("kernel_cache.tgx.load.bad_payload")
                return

            for k_str, v in raw.items():
                decoded = _decode_key(k_str)
                if decoded is None:
                    continue
                if not isinstance(v, int):
                    continue
                cls._tgx_cache[decoded] = int(v)
            cls._trim_cache_locked()
            _record_cache_event("kernel_cache.tgx.load.ok", detail=f"entries={len(cls._tgx_cache)}")
        except Exception:
            # Cache corruption or permission errors should never break execution.
            _record_cache_event("kernel_cache.tgx.load.error")
            return

    @classmethod
    def _save_tgx_cache_to_disk(cls) -> None:
        # Caller is expected to hold cls._lock.
        if not cls._persist_enabled():
            _record_cache_event("kernel_cache.tgx.save.skipped_persist_off")
            return
        if not cls._tgx_cache_dirty:
            return

        path = _default_cache_path()
        try:
            obj = {
                "version": 1,
                "tgx_cache": {
                    _encode_key(d, k, n, h): int(v)
                    for (d, k, n, h), v in cls._tgx_cache.items()
                },
            }
            _atomic_write_json(path, obj)
            cls._tgx_cache_dirty = False
            _record_cache_event("kernel_cache.tgx.save.ok", detail=f"entries={len(cls._tgx_cache)}")
        except Exception:
            # I/O errors should not break execution.
            _record_cache_event("kernel_cache.tgx.save.error")
            return

    @classmethod
    def get_threadgroup_x(
        cls, device_key: str, kernel_name: str, n_fft: int, hop: int,
    ) -> Optional[int]:
        key = (device_key, kernel_name, int(n_fft), int(hop))
        # Fast path: once loaded, lock-free reads avoid per-call lock overhead
        # on hot steady-state inference paths.
        if cls._tgx_cache_loaded:
            val = cls._tgx_cache.get(key)
            _record_cache_event(
                "kernel_cache.tgx.hit" if val is not None else "kernel_cache.tgx.miss",
                key=key,
            )
            return val
        with cls._lock:
            cls._load_tgx_cache_from_disk()
            val = cls._tgx_cache.get(key)
            _record_cache_event(
                "kernel_cache.tgx.hit" if val is not None else "kernel_cache.tgx.miss",
                key=key,
            )
            return val

    @classmethod
    def set_threadgroup_x(
        cls, device_key: str, kernel_name: str,
        n_fft: int, hop: int, tgx: int,
    ) -> None:
        key = (device_key, kernel_name, int(n_fft), int(hop))
        with cls._lock:
            cls._load_tgx_cache_from_disk()
            cls._tgx_cache[key] = int(tgx)
            cls._trim_cache_locked()
            cls._tgx_cache_dirty = True
        _record_cache_event("kernel_cache.tgx.store", key=key)

    @classmethod
    def autotune_threadgroup_x(
        cls,
        *,
        kernel,
        kernel_name: str,
        n_fft: int,
        hop: int,
        grid: tuple,
        inputs: list,
        output_shape: tuple,
        output_dtype,
        template: list = None,
        default_tgx: int = 256,
        # UPDATED: Steps of 32 cover SIMD boundaries better than just powers of 2.
        # This checks 32, 64, 96, 128, 160, 192, 224, 256, 320, 384, 512, ...
        candidates: tuple = (
            32, 64, 96, 128, 160, 192, 224, 256,
            320, 384, 448, 512, 768, 1024
        ),
        warmup: int = 2,
        iters: int = 8,
    ) -> int:
        """Autotune threadgroup.x for a specific kernel + (n_fft, hop) on the current device.

        Runs only on first use; results are cached in-memory and can be persisted to disk.
        Controlled by SPEC_MLX_AUTOTUNE (set to 0/false to disable; falls back to default_tgx).
        Persistence controlled by SPEC_MLX_AUTOTUNE_PERSIST (default enabled).
        SPEC_MLX_TGX can force explicit tgx (global or per-kernel mapping).
        SPEC_MLX_AUTOTUNE_MAX_ENTRIES bounds persistent cache growth.
        """
        manual_tgx = _resolve_manual_tgx_override(kernel_name)
        if manual_tgx is not None:
            return int(manual_tgx)

        grid_x = int(grid[0]) if len(grid) > 0 else 0

        def _clamp_tgx_for_grid(tgx: int) -> int:
            tgx = int(tgx)
            if tgx <= 0:
                tgx = 32
            # Enforce Apple/Metal constraints and SIMD alignment.
            tgx = min(max(tgx, 32), 1024)
            tgx = (tgx // 32) * 32
            if tgx < 32:
                tgx = 32
            max_tgx = 1024
            if grid_x > 0:
                max_tgx = max(32, min(1024, int(grid_x)))
                max_tgx = (max_tgx // 32) * 32
                if max_tgx < 32:
                    max_tgx = 32
            return min(tgx, max_tgx)

        clamped_default_tgx = _clamp_tgx_for_grid(int(default_tgx))

        # Very short outputs are dominated by launch overhead; avoid persisting
        # tiny-shape tuning results into the global (n_fft, hop) cache.
        if grid_x > 0 and grid_x < int(default_tgx):
            _record_cache_event("kernel_cache.tgx.short_grid_default", detail=f"grid_x={grid_x}")
            return int(clamped_default_tgx)

        if not _SPEC_MLX_AUTOTUNE:
            return int(clamped_default_tgx)

        device_key = spec_mlx_device_key()
        cached = cls.get_threadgroup_x(device_key, kernel_name, n_fft, hop)
        if cached is not None:
            return int(_clamp_tgx_for_grid(int(cached)))

        # Helper: one timing run for a given tgx
        def _time_one(tgx: int) -> float:
            call_kwargs = dict(
                inputs=inputs,
                output_shapes=[output_shape],
                output_dtypes=[output_dtype],
                grid=grid,
                threadgroup=(int(tgx), 1, 1),
            )
            if template is not None:
                call_kwargs["template"] = template

            for _ in range(warmup):
                y = kernel(**call_kwargs)[0]
                mx.eval(y)

            mx.synchronize()
            t0 = time.perf_counter()
            for _ in range(iters):
                y = kernel(**call_kwargs)[0]
                mx.eval(y)
            mx.synchronize()
            t1 = time.perf_counter()
            return (t1 - t0) / max(iters, 1)

        benchmark_candidates = sorted(
            {
                _clamp_tgx_for_grid(int(tgx))
                for tgx in candidates
                if int(tgx) > 0
            }
        )
        benchmark_candidates = [tgx for tgx in benchmark_candidates if tgx >= 32]
        if not benchmark_candidates:
            benchmark_candidates = [int(clamped_default_tgx)]

        best_tgx = int(clamped_default_tgx)
        best_time = None

        # Benchmark candidate tg sizes; skip invalid ones gracefully.
        first_error: Exception | None = None
        traced = False
        for tgx in benchmark_candidates:
            try:
                dt = _time_one(tgx)
            except Exception as exc:
                if _is_tracer_error(exc):
                    # Inside mx.compile/vmap every candidate fails the same
                    # way, so stop rather than repeating it 14 times.
                    traced = True
                    first_error = exc
                    break
                if first_error is None:
                    first_error = exc
                continue

            if best_time is None or dt < best_time:
                best_time = dt
                best_tgx = tgx

        if traced:
            _warn_autotune_skipped_under_trace(
                kernel_name, int(n_fft), int(hop), int(clamped_default_tgx)
            )
            return int(clamped_default_tgx)

        if best_time is None:
            # Every candidate failed, so the kernel itself is broken for this
            # configuration -- not a tuning question. Caching the untested
            # default would hide that and let the real failure surface later
            # from an unrelated line, which is how a `#pragma unroll 0` build
            # error once read as a mysterious istft crash. Surface it here and
            # cache nothing.
            raise RuntimeError(
                f"{kernel_name}: no usable threadgroup size for n_fft={n_fft}, "
                f"hop={hop} -- every candidate of "
                f"{benchmark_candidates} failed to run. "
                f"First error: {first_error}"
            ) from first_error

        # Persist result.
        cls.set_threadgroup_x(device_key, kernel_name, n_fft, hop, best_tgx)
        with cls._lock:
            cls._save_tgx_cache_to_disk()
        return int(best_tgx)

    @classmethod
    def get_ola(cls, dtype=None):
        """Return the OLA Metal kernel (compile once, dtype-agnostic)."""
        if cls._ola_kernel is not None:
            _record_cache_event("kernel_cache.ola.hit")
            return cls._ola_kernel
        _record_cache_event("kernel_cache.ola.miss")
        with cls._lock:
            if cls._ola_kernel is not None:
                return cls._ola_kernel
            try:
                cls._ola_kernel = mx.fast.metal_kernel(
                    name="ola_windowed_optimized",
                    input_names=["frames", "window", "params"],
                    output_names=["out"],
                    source=_METAL_OLA_TEMPLATE,
                )
                _record_cache_event("kernel_cache.ola.compile_ok")
            except Exception as exc:
                cls._ola_kernel = False
                _warn_metal_unavailable('ola_windowed_optimized', exc)
                _record_cache_event("kernel_cache.ola.compile_fail")
            return cls._ola_kernel

    @classmethod
    def get_ola_norm(cls, dtype=None):
        """Return the OLA+norm Metal kernel (compile once, dtype-agnostic)."""
        if cls._ola_norm_kernel is not None:
            _record_cache_event("kernel_cache.ola_norm.hit")
            return cls._ola_norm_kernel
        _record_cache_event("kernel_cache.ola_norm.miss")
        with cls._lock:
            if cls._ola_norm_kernel is not None:
                return cls._ola_norm_kernel
            try:
                cls._ola_norm_kernel = mx.fast.metal_kernel(
                    name="ola_norm_windowed_div_envelope",
                    input_names=["frames", "window", "window_sq", "params"],
                    output_names=["out"],
                    source=_METAL_OLA_NORM_TEMPLATE,
                )
                _record_cache_event("kernel_cache.ola_norm.compile_ok")
            except Exception as exc:
                cls._ola_norm_kernel = False
                _warn_metal_unavailable('ola_norm_windowed_div_envelope', exc)
                _record_cache_event("kernel_cache.ola_norm.compile_fail")
            return cls._ola_norm_kernel

    @classmethod
    def get_envelope(cls, dtype=None):
        """Return the envelope Metal kernel (compile once, dtype-agnostic)."""
        if cls._envelope_kernel is not None:
            _record_cache_event("kernel_cache.envelope.hit")
            return cls._envelope_kernel
        _record_cache_event("kernel_cache.envelope.miss")
        with cls._lock:
            if cls._envelope_kernel is not None:
                return cls._envelope_kernel
            try:
                cls._envelope_kernel = mx.fast.metal_kernel(
                    name="ola_envelope",
                    input_names=["window_sq", "params"],
                    output_names=["out"],
                    source=_METAL_OLA_ENVELOPE_TEMPLATE,
                )
                _record_cache_event("kernel_cache.envelope.compile_ok")
            except Exception as exc:
                cls._envelope_kernel = False
                _warn_metal_unavailable('ola_envelope', exc)
                _record_cache_event("kernel_cache.envelope.compile_fail")
            return cls._envelope_kernel

    @classmethod
    def debug_snapshot(cls) -> dict:
        def _is_compiled(v):
            return v is not None and v is not False

        with cls._lock:
            return {
                "ola_kernel_compiled": _is_compiled(cls._ola_kernel),
                "ola_norm_kernel_compiled": _is_compiled(cls._ola_norm_kernel),
                "envelope_kernel_compiled": _is_compiled(cls._envelope_kernel),
                "tgx_entries": int(len(cls._tgx_cache)),
                "tgx_loaded": bool(cls._tgx_cache_loaded),
                "tgx_dirty": bool(cls._tgx_cache_dirty),
            }

def _run_metal_ola(
    frames: mx.array,
    window: mx.array,
    hop: int,
    out_len: int,
    *,
    require_metal: bool = False,
) -> mx.array:
    """Overlap-add using optimized branchless Metal kernel."""
    def _scatter_plan(nframe: int, frame: int, out_len_i: int) -> tuple[mx.array, mx.array]:
        out_len_i = int(out_len_i)
        frame_starts = mx.arange(int(nframe), dtype=mx.int32) * int(hop)
        sample_idx = mx.arange(int(frame), dtype=mx.int32)
        indices = frame_starts[:, None] + sample_idx[None, :]
        flat_indices = indices.reshape(-1)
        valid_mask = flat_indices < out_len_i
        if out_len_i <= 0:
            # Keep shapes consistent for degenerate requests.
            return mx.zeros_like(flat_indices), valid_mask
        clipped = mx.clip(flat_indices, 0, out_len_i - 1)
        return clipped, valid_mask

    def _run_fallback(frames_local: mx.array, window_local: mx.array, out_len_i: int) -> mx.array:
        B, nframe, frame = frames_local.shape
        clipped, valid_mask = _scatter_plan(int(nframe), int(frame), int(out_len_i))

        values = (frames_local * window_local[None, None, :]).reshape(int(B), -1)
        values = values * valid_mask.astype(values.dtype)[None, :]

        if int(out_len_i) <= 0:
            return mx.zeros((int(B), 0), dtype=frames_local.dtype)

        batch_offsets = (mx.arange(int(B), dtype=mx.int32) * int(out_len_i))[:, None]
        scatter_indices = (batch_offsets + clipped[None, :]).reshape(-1)

        # Accumulate in float32 regardless of input dtype. The Metal kernel this
        # stands in for keeps its accumulator in `float` (see
        # _METAL_OLA_TEMPLATE), so a half-precision accumulator here would make
        # the result depend on whether a kernel happened to compile.
        out = mx.zeros((int(B) * int(out_len_i),), dtype=mx.float32)
        out = out.at[scatter_indices].add(values.reshape(-1).astype(mx.float32))
        return out.reshape(int(B), int(out_len_i)).astype(frames_local.dtype)

    if frames.dtype != window.dtype:
        window = window.astype(frames.dtype)

    B, nframe, frame = frames.shape
    kernel = _KernelCache.get_ola()
    if kernel is False:
        _record_cache_event("backend.ola.fallback", detail="metal_unavailable")
        if require_metal:
            raise RuntimeError(
                "backend_policy='metal' requires Metal OLA kernel, but it is unavailable."
            )
        return _run_fallback(frames, window, int(out_len))
    frames = mx.contiguous(frames)
    window = mx.contiguous(window)

    params = mx.array([int(nframe), int(out_len)], dtype=mx.int32)
    unroll_k = _unroll_k(frame, hop)
    tmpl = [("T", frames.dtype), ("HOP", hop), ("FRAME", frame), ("UNROLL_K", unroll_k)]
    _record_tmpl_event("ola", tmpl)

    tgx = _KernelCache.autotune_threadgroup_x(
        kernel=kernel,
        kernel_name=f"ola_windowed_optimized_{frames.dtype}",
        n_fft=frame,
        hop=hop,
        grid=(out_len, B, 1),
        inputs=[frames, window, params],
        template=tmpl,
        output_shape=(B, out_len),
        output_dtype=frames.dtype,
        default_tgx=256,
    )

    outputs = kernel(
        inputs=[frames, window, params],
        template=tmpl,
        output_shapes=[(B, out_len)],
        output_dtypes=[frames.dtype],
        grid=(out_len, B, 1),
        threadgroup=(tgx, 1, 1),
        init_value=0,
    )
    _record_cache_event("backend.ola.metal")
    return outputs[0]

def _run_metal_ola_norm(
    frames: mx.array,
    window: mx.array,
    window_sq: mx.array,
    hop: int,
    out_len: int,
    *,
    require_metal: bool = False,
) -> mx.array:
    """Overlap-add with fused normalization (Torch-like masked divide).

    Note: any NOLA / envelope-min checks are handled outside the fused kernel.
    """
    def _compute_envelope(window_sq_local: mx.array, nframe: int, out_len_i: int) -> mx.array:
        frame = int(window_sq_local.shape[0])
        frame_starts = mx.arange(int(nframe), dtype=mx.int32) * int(hop)
        sample_idx = mx.arange(frame, dtype=mx.int32)
        indices = frame_starts[:, None] + sample_idx[None, :]
        flat_indices = indices.reshape(-1)
        valid_mask = flat_indices < int(out_len_i)
        if int(out_len_i) <= 0:
            return mx.zeros((0,), dtype=window_sq_local.dtype)
        clipped = mx.clip(flat_indices, 0, int(out_len_i) - 1)

        values = mx.tile(window_sq_local, (int(nframe),))
        values = values * valid_mask.astype(values.dtype)

        denom = mx.zeros((int(out_len_i),), dtype=values.dtype)
        denom = denom.at[clipped].add(values)
        return denom

    def _run_fallback(
        frames_local: mx.array,
        window_local: mx.array,
        window_sq_local: mx.array,
        nframe: int,
        out_len_i: int,
    ) -> mx.array:
        out_sum = _run_metal_ola(frames_local, window_local, int(hop), int(out_len_i))
        denom = _compute_envelope(window_sq_local, int(nframe), int(out_len_i))

        if out_sum.dtype != mx.float32:
            out_sum_f32 = out_sum.astype(mx.float32)
            denom_f32 = denom.astype(mx.float32)
            out_f32 = mx.where(
                mx.abs(denom_f32)[None, :] > 1.0e-11,
                out_sum_f32 / denom_f32[None, :],
                mx.zeros_like(out_sum_f32),
            )
            return out_f32.astype(out_sum.dtype)

        return mx.where(
            mx.abs(denom)[None, :] > 1.0e-11,
            out_sum / denom[None, :],
            mx.zeros_like(out_sum),
        )

    if frames.dtype != window.dtype:
        window = window.astype(frames.dtype)
    if frames.dtype != window_sq.dtype:
        window_sq = window_sq.astype(frames.dtype)

    B, nframe, frame = frames.shape
    kernel = _KernelCache.get_ola_norm()
    if kernel is False:
        _record_cache_event("backend.ola_norm.fallback", detail="metal_unavailable")
        if require_metal:
            raise RuntimeError(
                "backend_policy='metal' requires fused Metal OLA norm kernel, "
                "but it is unavailable."
            )
        return _run_fallback(frames, window, window_sq, int(nframe), int(out_len))

    frames = mx.contiguous(frames)
    window = mx.contiguous(window)
    window_sq = mx.contiguous(window_sq)

    params = mx.array([int(nframe), int(out_len)], dtype=mx.int32)
    unroll_k = _unroll_k(frame, hop)
    tmpl = [("T", frames.dtype), ("HOP", hop), ("FRAME", frame), ("UNROLL_K", unroll_k)]
    _record_tmpl_event("ola_norm", tmpl)

    tgx = _KernelCache.autotune_threadgroup_x(
        kernel=kernel,
        kernel_name=f"ola_norm_windowed_div_envelope_{frames.dtype}",
        n_fft=frame,
        hop=hop,
        grid=(out_len, B, 1),
        inputs=[frames, window, window_sq, params],
        template=tmpl,
        output_shape=(B, out_len),
        output_dtype=frames.dtype,
        default_tgx=256,
    )

    outputs = kernel(
        inputs=[frames, window, window_sq, params],
        template=tmpl,
        output_shapes=[(B, out_len)],
        output_dtypes=[frames.dtype],
        grid=(out_len, B, 1),
        threadgroup=(tgx, 1, 1),
        init_value=0,
    )
    _record_cache_event("backend.ola_norm.metal")
    return outputs[0]
# ==============================================================================
# Helpers & Transforms
# ==============================================================================

WindowLike = Union[str, mx.array, None]

def _window_cache_signature(
    *,
    provided_window: WindowLike,
    resolved_window: mx.array,
    window_fn: str,
    win_length: int,
    n_fft: int,
    periodic: bool,
) -> tuple:
    """Return a stable key component identifying window shape/content."""
    if isinstance(provided_window, mx.array):
        arr = np.ascontiguousarray(np.asarray(resolved_window, dtype=np.float32))
        digest = hashlib.blake2b(arr.tobytes(), digest_size=16).hexdigest()
        return ("array", int(arr.shape[0]), digest)
    return ("generated", str(window_fn), int(win_length), int(n_fft), bool(periodic))

# ==============================================================================
# Fused iSTFT safety (Torch-like NOLA check, cached)
# ==============================================================================

# Cached device key for OLA safety checks (expensive to compute, rarely changes)
# Bounded safety check cache: stores (ok, min_abs_val, checked_length) tuples.
# Keyed by (device_key, n_fft, hop, win_length, center, window_signature,
# n_frames, length_mode, length_key).
# We keep this bounded to avoid unbounded growth in long-running processes.

_OLA_SAFETY_CACHE_MAX = 256
_OLA_SAFETY_CACHE: "OrderedDict[tuple, tuple[bool, float, int]]" = OrderedDict()

_OLA_SAFETY_LOCK = threading.Lock()
_OLA_SAFETY_LENGTH_STRATEGY = (
    os.environ.get("SPEC_MLX_OLA_SAFETY_LENGTH_STRATEGY", "bucket")
    .strip().lower()
)
if _OLA_SAFETY_LENGTH_STRATEGY not in ("bucket", "exact"):
    _OLA_SAFETY_LENGTH_STRATEGY = "bucket"
try:
    _OLA_SAFETY_LENGTH_BUCKET = max(
        1, int(os.environ.get("SPEC_MLX_OLA_SAFETY_LENGTH_BUCKET", "2048"))
    )
except Exception:
    _OLA_SAFETY_LENGTH_BUCKET = 2048

def _ola_safety_cache_get(key: tuple) -> Optional[tuple[bool, float, int]]:
    with _OLA_SAFETY_LOCK:
        val = _OLA_SAFETY_CACHE.get(key)
        if val is None:
            _record_cache_event("ola_safety_cache.miss", key=key)
            return None
        # Refresh LRU order
        _OLA_SAFETY_CACHE.move_to_end(key)
        _record_cache_event("ola_safety_cache.hit", key=key)
        return val

def _ola_safety_cache_set(key: tuple, value: tuple[bool, float, int]) -> None:
    with _OLA_SAFETY_LOCK:
        _OLA_SAFETY_CACHE[key] = value
        _OLA_SAFETY_CACHE.move_to_end(key)
        _record_cache_event("ola_safety_cache.store", key=key)
        if len(_OLA_SAFETY_CACHE) > _OLA_SAFETY_CACHE_MAX:
            _OLA_SAFETY_CACHE.popitem(last=False)
            _record_cache_event("ola_safety_cache.evict")


def _resolve_ola_safety_length_key_and_check_length(
    length: Optional[int],
    *,
    safety: str,
) -> tuple[str, int, Optional[int], Optional[int]]:
    """Resolve cache key + effective check length for NOLA safety checks.

    Returns ``(length_mode, length_key, check_length, requested_length)``.
    ``length_key`` controls cache-key bucketing; ``check_length`` controls the
    actual envelope span that will be validated.
    """
    if length is None:
        return "none", -1, None, None

    requested = max(0, int(length))
    if safety != "auto" or _OLA_SAFETY_LENGTH_STRATEGY == "exact":
        return "exact", requested, requested, requested

    bucket = int(_OLA_SAFETY_LENGTH_BUCKET)
    bucketed = ((requested + bucket - 1) // bucket) * bucket if requested > 0 else 0
    # Keep the check length exact for Torch-compatible behavior. Bucket only the
    # cache key to reduce key cardinality.
    return "bucket", bucketed, requested, requested

def _ola_envelope_min_check_cached(
    transform: "SpectralTransform",
    *,
    n_frames: int,
    length: Optional[int],
    torch_like: bool,
    safety: str,
    require_metal: bool = False,
) -> None:
    """Torch-style envelope-min check (NOLA) with optimized caching."""
    safety = str(safety)
    if safety not in ("off", "auto", "always"):
        raise ValueError("safety must be one of {'off','auto','always'}")
    if safety == "off":
        return

    # Use cached device key instead of computing every time.
    (length_mode, length_key, check_length, requested_length) = (
        _resolve_ola_safety_length_key_and_check_length(
            length,
            safety=safety,
        )
    )
    
    cache_key = (
        spec_mlx_device_key(),      # ← Cached at module level
        transform.n_fft,
        transform.hop_length,
        transform.win_length,
        transform.center,
        transform._window_cache_sig,
        int(n_frames),
        length_mode,
        length_key,
    )

    # Fast path: check cache for 'auto' mode
    if safety == "auto":
        cached = _ola_safety_cache_get(cache_key)
        if cached is not None:
            ok, min_abs_val, cached_checked_length = cached

            # Monotonic reuse rules for exact Torch-compatible semantics:
            # - If cached check passed at Lc, any shorter Lr <= Lc also passes.
            # - If cached check failed at Lc, any longer Lr >= Lc also fails.
            reusable = True
            if requested_length is not None and cached_checked_length >= 0:
                if ok:
                    reusable = int(requested_length) <= int(cached_checked_length)
                else:
                    reusable = int(requested_length) >= int(cached_checked_length)

            if reusable:
                if not ok:
                    _report_nola_violation(
                        min_abs_val, torch_like, cached=True, warn_key=cache_key
                    )
                return

    # Compute envelope
    denom, _ = transform._get_ola_envelope(int(n_frames), require_metal=require_metal)

    if transform.center:
        pad = transform.n_fft // 2
        if check_length is None:
            denom = denom[pad:-pad]
        else:
            end = min(int(denom.shape[0]), pad + int(check_length))
            denom = denom[pad:end]
    elif check_length is not None:
        take = min(int(check_length), int(denom.shape[0]))
        denom = denom[:take]

    # Check minimum; guard empty windows to match torch-side behavior.
    if int(denom.shape[0]) == 0:
        min_abs_val = 0.0
    else:
        min_abs = mx.min(mx.abs(denom))
        mx.eval(min_abs)
        min_abs_val = float(min_abs.item())
    ok = (min_abs_val >= 1e-11)
    
    # Cache result
    if safety == "auto":
        checked_len_value = int(check_length) if check_length is not None else -1
        _ola_safety_cache_set(cache_key, (ok, min_abs_val, checked_len_value))
    
    if not ok:
        _report_nola_violation(
            min_abs_val, torch_like, cached=False, warn_key=cache_key
        )

_NOLA_REMEDY = (
    "Increase win_length, use a COLA-compliant window/hop, or pass "
    "safety='off' to skip this check."
)


def _nola_violation_message(min_abs_val: float, cached: bool) -> str:
    origin = "cached: " if cached else ""
    return (
        "istft: the window overlap-add envelope is degenerate "
        f"({origin}min={min_abs_val:.3e}). Output samples where the envelope is "
        "below 1e-11 are emitted as exact zeros, so the reconstruction will "
        f"contain silent gaps. {_NOLA_REMEDY}"
    )


_NOLA_WARNED: set = set()
_NOLA_WARNED_LOCK = threading.Lock()


def _report_nola_violation(
    min_abs_val: float,
    torch_like: bool,
    cached: bool,
    warn_key=None,
) -> None:
    """Surface a failed NOLA check.

    Previously this only raised when ``torch_like=True``, which is not the
    default -- so by default the library computed the envelope minimum,
    discovered the NOLA condition was violated, and returned anyway. The Metal
    kernel and the pure-MLX fallback both emit exact 0.0 wherever the envelope
    is below 1e-11, so a bad n_fft/hop/window combination silently punched
    holes in the reconstructed audio with no indication of any kind. Torch
    raises here. Now the default at least warns.
    """
    message = _nola_violation_message(min_abs_val, cached)
    if torch_like:
        raise RuntimeError(message)
    # Warn once per transform configuration. A degenerate envelope is a
    # property of (n_fft, hop, window, center, length), not of the call, and
    # center=False legitimately produces zero envelope at the edges -- warning
    # on every istft would train users to ignore it.
    if warn_key is not None:
        with _NOLA_WARNED_LOCK:
            if warn_key in _NOLA_WARNED:
                return
            _NOLA_WARNED.add(warn_key)
    warnings.warn(message, RuntimeWarning, stacklevel=3)


@mx.compile
def _torch_like_reflect_pad_1d_compiled(x: mx.array, pad: int) -> mx.array:
    """Compiled reflect-pad using pure MLX ops."""
    if pad <= 0:
        return x
    if x.shape[-1] <= pad:
        raise ValueError(
            f"torch-like reflect padding requires input_length > pad "
            f"(got length={x.shape[-1]}, pad={pad})"
        )
    left = x[..., 1 : pad + 1][..., ::-1]
    right = x[..., -pad - 1 : -1][..., ::-1]
    return mx.concatenate([left, x, right], axis=-1)


def _torch_like_reflect_pad_1d(x: mx.array, pad: int) -> mx.array:
    return _torch_like_reflect_pad_1d_compiled(x, pad)


def make_window(
    window: WindowLike,
    window_fn: str,
    win_length: int,
    n_fft: int,
    periodic: bool,
) -> mx.array:
    """Create or validate a 1D window with strict shape and type checks."""
    if isinstance(window, mx.array):
        # Optimization: Avoid unnecessary copy if already float32
        w = window if window.dtype == mx.float32 else window.astype(mx.float32)
        if w.ndim != 1:
            raise ValueError(f"window must be 1D, got shape {w.shape}")
        if w.shape[0] == n_fft:
            return w
        if w.shape[0] != win_length:
            raise ValueError(
                f"window length must be win_length ({win_length}) "
                f"or n_fft ({n_fft}), got {w.shape[0]}"
            )
        
        left = (n_fft - win_length) // 2
        right = (n_fft - win_length + 1) // 2
        return mx.pad(w, [(left, right)], mode="constant")

    if win_length <= 0:
        raise ValueError("win_length must be positive")

    denom = win_length if periodic else (win_length - 1 if win_length > 1 else 1)
    idx = mx.arange(win_length, dtype=mx.float32)

    if window_fn == "hann":
        w = 0.5 - 0.5 * mx.cos(2.0 * math.pi * idx / denom)
    elif window_fn == "hamming":
        w = 0.54 - 0.46 * mx.cos(2.0 * math.pi * idx / denom)
    elif window_fn == "blackman":
        theta = 2.0 * math.pi * idx / denom
        w = 0.42 - 0.5 * mx.cos(theta) + 0.08 * mx.cos(2.0 * theta)
    elif window_fn in ("rect", "boxcar", "ones"):
        w = mx.ones((win_length,), dtype=mx.float32)
    else:
        raise ValueError(f"Unknown window_fn: {window_fn}")

    if win_length < n_fft:
        left = (n_fft - win_length) // 2
        right = (n_fft - win_length + 1) // 2
        w = mx.pad(w, [(left, right)], mode="constant")
    elif win_length > n_fft:
        raise ValueError(f"win_length ({win_length}) must be <= n_fft ({n_fft})")

    return w

def resolve_fft_params(
    n_fft: int,
    hop_length: Optional[int],
    win_length: Optional[int],
    pad: int,
) -> tuple[int, int, int]:
    """Resolve effective FFT parameters.

    Returns (effective_n_fft, hop_length, win_length).
    """
    n_fft = int(n_fft)
    if n_fft <= 0:
        raise ValueError("n_fft must be positive")

    pad = int(pad)
    if pad < 0:
        raise ValueError("pad must be >= 0")

    if hop_length is None:
        hop_length = n_fft // 4
    hop_length = int(hop_length)
    if hop_length <= 0:
        raise ValueError("hop_length must be positive")

    # Match PyTorch semantics: `pad` is an *additive* number of samples padded on
    # both sides within each analysis frame. Effective FFT size grows by 2*pad.
    effective_n_fft = n_fft + 2 * pad

    # Match PyTorch default: if win_length is not provided, use n_fft.
    if win_length is None:
        win_length = n_fft
    win_length = int(win_length)
    
    if win_length <= 0:
        raise ValueError("win_length must be positive")
    if win_length > effective_n_fft:
        raise ValueError(
            f"win_length ({win_length}) must be <= "
            f"effective_n_fft ({effective_n_fft})"
        )

    return effective_n_fft, hop_length, win_length


def _hz_to_mel(freq: np.ndarray | float, *, mel_scale: str = "htk") -> np.ndarray:
    if mel_scale not in ("htk", "slaney"):
        raise ValueError('mel_scale must be one of {"htk", "slaney"}')

    f = np.asarray(freq, dtype=np.float64)
    if mel_scale == "htk":
        return 2595.0 * np.log10(1.0 + (f / 700.0))

    # Slaney mel scale.
    f_min = 0.0
    f_sp = 200.0 / 3.0
    mels = (f - f_min) / f_sp
    min_log_hz = 1000.0
    min_log_mel = (min_log_hz - f_min) / f_sp
    logstep = math.log(6.4) / 27.0
    log_t = f >= min_log_hz
    log_mels = min_log_mel + np.log(np.maximum(f, 1e-12) / min_log_hz) / logstep
    mels = np.where(log_t, log_mels, mels)
    return mels


def _mel_to_hz(mels: np.ndarray, *, mel_scale: str = "htk") -> np.ndarray:
    if mel_scale not in ("htk", "slaney"):
        raise ValueError('mel_scale must be one of {"htk", "slaney"}')

    m = np.asarray(mels, dtype=np.float64)
    if mel_scale == "htk":
        return 700.0 * (10.0 ** (m / 2595.0) - 1.0)

    # Slaney mel scale.
    f_min = 0.0
    f_sp = 200.0 / 3.0
    freqs = f_min + f_sp * m
    min_log_hz = 1000.0
    min_log_mel = (min_log_hz - f_min) / f_sp
    logstep = math.log(6.4) / 27.0
    log_t = m >= min_log_mel
    freqs = np.where(log_t, min_log_hz * np.exp(logstep * (m - min_log_mel)), freqs)
    return freqs


def melscale_fbanks(
    n_freqs: int,
    f_min: float,
    f_max: float,
    n_mels: int,
    sample_rate: int,
    *,
    norm: MelNorm = None,
    mel_scale: MelScale = "htk",
) -> mx.array:
    """Create triangular mel filter banks with torchaudio-compatible formulas.

    Returns shape ``[n_freqs, n_mels]`` so mel application is ``X @ fb`` where
    ``X`` is ``[..., n_freqs]``.
    """
    n_freqs = int(n_freqs)
    n_mels = int(n_mels)
    sample_rate = int(sample_rate)
    if n_freqs <= 0:
        raise ValueError("n_freqs must be > 0")
    if n_mels <= 0:
        raise ValueError("n_mels must be > 0")
    if sample_rate <= 0:
        raise ValueError("sample_rate must be > 0")
    if norm not in (None, "slaney"):
        raise ValueError('norm must be one of {None, "slaney"}')
    if mel_scale not in ("htk", "slaney"):
        raise ValueError('mel_scale must be one of {"htk", "slaney"}')

    all_freqs = np.linspace(0.0, sample_rate // 2, n_freqs, dtype=np.float64)
    m_min = float(_hz_to_mel(float(f_min), mel_scale=mel_scale))
    m_max = float(_hz_to_mel(float(f_max), mel_scale=mel_scale))
    m_pts = np.linspace(m_min, m_max, n_mels + 2, dtype=np.float64)
    f_pts = _mel_to_hz(m_pts, mel_scale=mel_scale)

    f_diff = f_pts[1:] - f_pts[:-1]  # [n_mels + 1]
    slopes = f_pts[None, :] - all_freqs[:, None]  # [n_freqs, n_mels + 2]
    down = (-slopes[:, :-2]) / np.maximum(f_diff[:-1][None, :], 1e-12)
    up = slopes[:, 2:] / np.maximum(f_diff[1:][None, :], 1e-12)
    fb = np.maximum(0.0, np.minimum(down, up)).astype(np.float32)  # [n_freqs, n_mels]

    if norm == "slaney":
        enorm = 2.0 / np.maximum(f_pts[2 : n_mels + 2] - f_pts[:n_mels], 1e-12)
        fb = fb * enorm[None, :].astype(np.float32)

    return mx.array(fb, dtype=mx.float32)


def amplitude_to_db(
    x: mx.array,
    *,
    stype: Literal["power", "magnitude"] = "power",
    top_db: Optional[float] = 80.0,
    amin: float = 1e-10,
    ref_value: float = 1.0,
    mode: Literal["torchaudio_compat", "per_example"] = "torchaudio_compat",
) -> mx.array:
    """Convert power/magnitude spectrogram to dB.

    ``mode="torchaudio_compat"`` replicates torchaudio's clipping behavior for
    packed batch tensors. ``mode="per_example"`` clips each leading example
    independently across time-frequency axes.
    """
    if stype not in ("power", "magnitude"):
        raise ValueError('stype must be one of {"power", "magnitude"}')
    if mode not in ("torchaudio_compat", "per_example"):
        raise ValueError('mode must be one of {"torchaudio_compat", "per_example"}')
    if top_db is not None and float(top_db) < 0:
        raise ValueError("top_db must be non-negative when set")
    multiplier = 10.0 if stype == "power" else 20.0
    amin_f = float(amin)
    db_multiplier = math.log10(max(amin_f, float(ref_value)))

    x_db = multiplier * mx.log10(mx.maximum(x, amin_f))
    x_db = x_db - (multiplier * db_multiplier)

    if top_db is None:
        return x_db

    shape = tuple(int(v) for v in x_db.shape)
    if mode == "per_example":
        if len(shape) <= 1:
            cutoff = mx.max(x_db) - float(top_db)
            return mx.maximum(x_db, cutoff)
        if len(shape) == 2:
            max_ref = mx.max(x_db, keepdims=True)
            return mx.maximum(x_db, max_ref - float(top_db))
        max_ref = mx.max(x_db, axis=(-2, -1), keepdims=True)
        return mx.maximum(x_db, max_ref - float(top_db))

    if len(shape) <= 1:
        cutoff = mx.max(x_db) - float(top_db)
        return mx.maximum(x_db, cutoff)
    if len(shape) == 2:
        x_view = x_db[None, None, :, :]
        max_ref = mx.max(x_view, axis=(-3, -2, -1), keepdims=True)
        x_view = mx.maximum(x_view, max_ref - float(top_db))
        return x_view[0, 0, :, :]
    if len(shape) == 3:
        x_view = x_db[None, :, :, :]
        max_ref = mx.max(x_view, axis=(-3, -2, -1), keepdims=True)
        x_view = mx.maximum(x_view, max_ref - float(top_db))
        return x_view[0, :, :, :]

    packed_channels = int(shape[-3])
    leading = int(np.prod(shape[:-3], dtype=np.int64))
    x_view = x_db.reshape(leading, packed_channels, shape[-2], shape[-1])
    max_ref = mx.max(x_view, axis=(-3, -2, -1), keepdims=True)
    x_view = mx.maximum(x_view, max_ref - float(top_db))
    return x_view.reshape(shape)


def dct_matrix(
    n_mfcc: int,
    n_mels: int,
    *,
    norm: Literal["ortho"] | None = "ortho",
) -> mx.array:
    """Create a DCT type-II matrix ``[n_mfcc, n_mels]``."""
    n_mfcc = int(n_mfcc)
    n_mels = int(n_mels)
    if n_mfcc <= 0:
        raise ValueError("n_mfcc must be > 0")
    if n_mels <= 0:
        raise ValueError("n_mels must be > 0")
    if n_mfcc > n_mels:
        raise ValueError("n_mfcc must be <= n_mels")
    if norm not in (None, "ortho"):
        raise ValueError('norm must be one of {None, "ortho"}')

    n = np.arange(float(n_mels), dtype=np.float64)
    k = np.arange(float(n_mfcc), dtype=np.float64)[:, None]
    dct = np.cos((math.pi / float(n_mels)) * (n + 0.5) * k).astype(np.float32)

    if norm is None:
        dct *= 2.0
    else:
        dct[0] *= 1.0 / math.sqrt(2.0)
        dct *= math.sqrt(2.0 / float(n_mels))

    return mx.array(dct, dtype=mx.float32)


@lru_cache(maxsize=128)
def _cached_mel_filterbank(
    n_freqs: int,
    f_min: float,
    f_max: float,
    n_mels: int,
    sample_rate: int,
    norm: MelNorm,
    mel_scale: MelScale,
) -> mx.array:
    return melscale_fbanks(
        n_freqs=int(n_freqs),
        f_min=float(f_min),
        f_max=float(f_max),
        n_mels=int(n_mels),
        sample_rate=int(sample_rate),
        norm=norm,
        mel_scale=mel_scale,
    )


@lru_cache(maxsize=128)
def _cached_dct_matrix(
    n_mfcc: int,
    n_mels: int,
    norm: Literal["ortho"] | None,
) -> mx.array:
    return dct_matrix(int(n_mfcc), int(n_mels), norm=norm)


@lru_cache(maxsize=128)
def _cached_lifter_weights(
    n_mfcc: int,
    lifter: int,
) -> mx.array:
    idx = mx.arange(1, int(n_mfcc) + 1, dtype=mx.float32)
    return (
        1.0 + (float(lifter) / 2.0) * mx.sin((math.pi / float(lifter)) * idx)
    ).astype(mx.float32)


def _apply_mel_filterbank(
    power: mx.array,
    *,
    mel_fb: mx.array,
    input_layout: Literal["bnf", "bfn"] = "bnf",
) -> mx.array:
    if input_layout == "bnf":
        power_bnf = power
    elif input_layout == "bfn":
        power_bnf = mx.transpose(power, (0, 2, 1))
    else:
        raise ValueError('input_layout must be one of {"bnf", "bfn"}')
    mel_bnm = mx.matmul(power_bnf, mel_fb)
    return mx.transpose(mel_bnm, (0, 2, 1)).astype(mx.float32)


def _apply_mfcc_projection(
    mel_bmn: mx.array,
    *,
    dct_mat_t: mx.array,
    lifter_weights: mx.array | None = None,
) -> mx.array:
    mfcc_bnm = mx.matmul(mx.transpose(mel_bmn, (0, 2, 1)), dct_mat_t)
    mfcc_bmn = mx.transpose(mfcc_bnm, (0, 2, 1)).astype(mx.float32)
    if lifter_weights is not None:
        mfcc_bmn = mfcc_bmn * lifter_weights[None, :, None]
    return mfcc_bmn


def _apply_log_scale(
    x: mx.array,
    *,
    log_amin: float,
    log_mode: LogMelMode,
    log_scale: float = 1.0,
) -> mx.array:
    amin = mx.array(float(log_amin), dtype=mx.float32)
    if log_mode == "add":
        return mx.log(x + amin).astype(mx.float32)
    if log_mode == "log1p":
        return mx.log1p(float(log_scale) * x).astype(mx.float32)
    return mx.log(mx.maximum(x, amin)).astype(mx.float32)


_ISTFT_BACKEND_POLICIES = ("auto", "mlx_fft", "metal", "torch_fallback")
_STFT_OUTPUT_LAYOUTS = ("bfn", "bnf")


def _resolve_backend_policy(
    backend_policy: Optional[str],
    *,
    default_policy: str = "auto",
) -> str:
    policy = default_policy if backend_policy is None else str(backend_policy)
    if policy not in _ISTFT_BACKEND_POLICIES:
        raise ValueError(
            "backend_policy must be one of "
            f"{_ISTFT_BACKEND_POLICIES}"
        )
    return policy


def _resolve_stft_output_layout(
    output_layout: Optional[str],
    *,
    default_layout: str = "bfn",
) -> str:
    layout = default_layout if output_layout is None else str(output_layout)
    if layout not in _STFT_OUTPUT_LAYOUTS:
        raise ValueError(
            "output_layout must be one of "
            f"{_STFT_OUTPUT_LAYOUTS}"
        )
    return layout


_DEFAULT_ISTFT_BACKEND_POLICY = "auto"

# ==============================================================================
# SpectralTransform
# ==============================================================================

@dataclass(frozen=True)
class _TransformKey:
    n_fft: int
    hop_length: int
    win_length: int
    window_fn: str
    onesided: bool
    periodic: bool
    center: bool
    center_pad_mode: str
    center_tail_pad: str
    normalized: bool
    istft_backend_policy: str

_MLX_OLA_FUSE_NORM = (
    os.environ.get("MLX_OLA_FUSE_NORM", "1").lower()
    not in ("0", "false", "no", "off")
)


def _trim_ola_output(
    out: mx.array,
    center: bool,
    n_fft: int,
    out_len: int,
    length_int: Optional[int],
    B: int,
) -> mx.array:
    """Trim/pad OLA output to requested length (shared by Metal and fallback paths)."""
    if center:
        pad = n_fft // 2
        if length_int is not None:
            target = length_int
            start = pad
            end = min(out_len, start + target)
            out = out[:, start:end]
            shortfall = target - int(out.shape[1])
            if shortfall > 0:
                out = mx.pad(out, [(0, 0), (0, shortfall)])
        else:
            out = out[:, pad:-pad] if out_len > 2 * pad else out[:, :0]
    elif length_int is not None:
        target = length_int
        if out_len >= target:
            out = out[:, :target]
        else:
            out = mx.pad(out, [(0, 0), (0, target - out_len)])
    return out


def _center_pad_widths(
    sig_len: int,
    n_fft: int,
    hop_length: int,
    center_tail_pad: CenterTailPad,
) -> tuple[int, int]:
    pad_left = n_fft // 2
    if center_tail_pad == "symmetric":
        return pad_left, pad_left
    if center_tail_pad != "minimal":
        raise ValueError(
            "center_tail_pad must be one of {'symmetric', 'minimal'}"
        )
    num_frames = max(1, int(math.ceil(sig_len / float(hop_length))))
    last_start = (num_frames - 1) * hop_length - pad_left
    pad_right = max(0, last_start + n_fft - sig_len)
    return pad_left, pad_right


def _apply_center_padding(
    x: mx.array,
    *,
    n_fft: int,
    hop_length: int,
    center_pad_mode: CenterPadMode,
    center_tail_pad: CenterTailPad,
) -> mx.array:
    pad_left, pad_right = _center_pad_widths(
        int(x.shape[1]), n_fft, hop_length, center_tail_pad
    )
    if center_pad_mode == "reflect":
        if pad_left != pad_right:
            raise ValueError(
                "center_pad_mode='reflect' requires center_tail_pad='symmetric'"
            )
        return _torch_like_reflect_pad_1d_compiled(x, pad_left)
    if center_pad_mode != "constant":
        raise ValueError(
            "center_pad_mode must be one of {'reflect', 'constant'}"
        )
    return mx.pad(x, [(0, 0), (pad_left, pad_right)], mode="constant")


def _place_rows(
    values: mx.array,
    start: int,
    width: int,
    out_len: int,
    B: int,
) -> mx.array:
    """Place ``values[:, :width]`` at column ``start`` of a zeroed ``(B, out_len)``.

    Deliberately uses ``mx.slice_update`` rather than ``arr.at[:, a:b].add(...)``.
    MLX before 0.32.0 mis-linearizes the 2-D dispatch grid in its Metal
    ``slice_update_op_impl`` kernel (``gid.y`` is missing the ``gsize.x * NWORK``
    factor), so a strided slice scatter-add aliases rows onto each other in a
    non-atomic read-modify-write. That silently corrupted this adjoint for any
    batch size greater than 1. ``mx.slice_update`` with an ``mx.array`` start
    takes the DynamicSliceUpdate path and is exact on every supported version.
    """
    base = mx.zeros((B, out_len), dtype=values.dtype)
    if width <= 0:
        return base
    return mx.slice_update(
        base,
        base[:, start:start + width] + values[:, :width],
        mx.array([start]),
        axes=(1,),
    )


def _unpad_cotangent(
    cotangent: mx.array,
    center: bool,
    n_fft: int,
    out_len: int,
    length_int: Optional[int],
    B: int,
) -> mx.array:
    """Adjoint of _trim_ola_output: un-trim cotangent back to full OLA space."""
    if center:
        pad = n_fft // 2
        if length_int is not None:
            width = min(length_int, out_len - pad, cotangent.shape[1])
        else:
            width = min(out_len - 2 * pad, cotangent.shape[1])
        return _place_rows(cotangent, pad, width, out_len, B)
    if length_int is not None:
        width = min(length_int, out_len, cotangent.shape[1])
        return _place_rows(cotangent, 0, width, out_len, B)
    if cotangent.shape[1] < out_len:
        return _place_rows(cotangent, 0, cotangent.shape[1], out_len, B)
    return cotangent


class SpectralTransform:
    """
    High-performance STFT/iSTFT engine for MLX.
    Uses fused kernels and cached configurations for maximum throughput.
    """
    __slots__ = (
        'n_fft', 'hop_length', 'win_length', 'window', 'window_fn',
        'onesided',
        '_window_sq', 'center', 'center_pad_mode', 'center_tail_pad',
        'normalized', 'periodic',
        'istft_backend_policy',
        '_window_cache_sig',
        '_norm_factor', '_inv_norm_factor',
        '_cache_key', 'ola_denom', 'ola_denom_inv',
        '_compiled_stft_fns', '_compiled_istft_fns', '_compiled_pair_nd_fns',
        '_torch_window_cache', '_window_runtime_cache',
    )

    def __init__(
        self,
        n_fft: int,
        hop_length: int,
        win_length: Optional[int] = None,
        window_fn: str = "hann",
        *,
        onesided: bool = True,
        window: WindowLike = None,
        periodic: bool = True,
        center: bool = True,
        center_pad_mode: CenterPadMode = "reflect",
        center_tail_pad: CenterTailPad = "symmetric",
        normalized: bool = False,
        istft_backend_policy: Optional[str] = None,
    ):
        self.n_fft = int(n_fft)
        self.hop_length = int(hop_length)
        self.win_length = int(win_length) if win_length is not None else self.n_fft
        
        if self.win_length > self.n_fft:
            raise ValueError(f"win_length ({self.win_length}) must be <= n_fft ({self.n_fft})")

        self.center = bool(center)
        self.center_pad_mode = str(center_pad_mode)
        self.center_tail_pad = str(center_tail_pad)
        self.normalized = bool(normalized)
        self.periodic = bool(periodic)
        self.window_fn = str(window_fn)
        self.onesided = bool(onesided)
        if self.center_pad_mode not in {"reflect", "constant"}:
            raise ValueError(
                "center_pad_mode must be one of {'reflect', 'constant'}"
            )
        if self.center_tail_pad not in {"symmetric", "minimal"}:
            raise ValueError(
                "center_tail_pad must be one of {'symmetric', 'minimal'}"
            )
        if self.center_pad_mode == "reflect" and self.center_tail_pad != "symmetric":
            raise ValueError(
                "center_pad_mode='reflect' requires center_tail_pad='symmetric'"
            )
        self.istft_backend_policy = _resolve_backend_policy(
            istft_backend_policy,
            default_policy=_DEFAULT_ISTFT_BACKEND_POLICY,
        )

        self.window = make_window(
            window=window,
            window_fn=self.window_fn,
            win_length=self.win_length,
            n_fft=self.n_fft,
            periodic=self.periodic,
        )
        self.window = mx.contiguous(self.window)
        self._window_cache_sig = _window_cache_signature(
            provided_window=window,
            resolved_window=self.window,
            window_fn=self.window_fn,
            win_length=self.win_length,
            n_fft=self.n_fft,
            periodic=self.periodic,
        )

        # Pre-computed normalization factors (avoid per-call sqrt)
        self._inv_norm_factor = 1.0 / math.sqrt(self.n_fft) if self.normalized else 1.0
        self._norm_factor = math.sqrt(self.n_fft) if self.normalized else 1.0

        # Pre-computed squared window for fused NOLA
        self._window_sq = mx.contiguous((self.window ** 2).astype(mx.float32))
        self._window_runtime_cache: Dict[str, Tuple[mx.array, mx.array]] = {
            str(self.window.dtype): (self.window, self._window_sq)
        }

        # Legacy caches
        self.ola_denom = None
        self.ola_denom_inv = None
        self._cache_key = None
        self._compiled_stft_fns = {}
        self._compiled_istft_fns = {}
        self._compiled_pair_nd_fns = {}
        self._torch_window_cache: Dict[str, Any] = {}

    def _window_pair_for_dtype(self, dtype: Any) -> Tuple[mx.array, mx.array]:
        key = str(dtype)
        cached = self._window_runtime_cache.get(key)
        if cached is not None:
            return cached

        window = self.window if self.window.dtype == dtype else self.window.astype(dtype)
        window_sq = (
            self._window_sq if self._window_sq.dtype == dtype
            else self._window_sq.astype(dtype)
        )
        window = mx.contiguous(window)
        window_sq = mx.contiguous(window_sq)
        pair = (window, window_sq)
        self._window_runtime_cache[key] = pair
        return pair

    def warmup(self, batch: int = 1, length: int = 4096) -> None:
        """Force compilation of kernels and execution paths."""
        x = mx.zeros((batch, length), dtype=mx.float32)
        Z = self.stft(x, output_layout="bnf")
        y = self.istft(Z, length=length, input_layout="bnf")
        mx.eval(Z, y)

    def prewarm_kernels(self, batch: int = 1, length: Optional[int] = None) -> None:
        """Precompile stft + fused and legacy istft kernels for this transform."""
        if length is None:
            length = max(int(self.n_fft) * 2, 4096)
        x = mx.zeros((int(batch), int(length)), dtype=mx.float32)
        Z = self.stft(x, output_layout="bnf")
        y_fused = self.istft(
            Z,
            length=int(length),
            torch_like=False,
            allow_fused=True,
            safety="off",
            input_layout="bnf",
        )
        y_legacy = self.istft(
            Z,
            length=int(length),
            torch_like=False,
            allow_fused=False,
            safety="off",
            input_layout="bnf",
        )
        mx.eval(Z, y_fused, y_legacy)

    def prewarm_compiled(
        self,
        *,
        batch: int = 1,
        length: Optional[int] = None,
        validate: bool = False,
        torch_like: bool = False,
        allow_fused: bool = True,
        safety: str = "off",
        backend_policy: Optional[str] = None,
    ) -> None:
        """Precompile cached compiled STFT/iSTFT callables for steady-shape loops."""
        if length is None:
            length = max(int(self.n_fft) * 2, 4096)
        x = mx.zeros((int(batch), int(length)), dtype=mx.float32)
        z = self.stft_compiled(x, output_layout="bnf")
        y = self.istft_compiled(
            z,
            length=int(length),
            validate=validate,
            torch_like=torch_like,
            allow_fused=allow_fused,
            safety=safety,
            long_mode_strategy="native",
            backend_policy=backend_policy,
            input_layout="bnf",
        )
        mx.eval(z, y)

    def get_compiled_stft(self, *, output_layout: str = "bfn"):
        """Return a cached compiled STFT callable for steady-shape workloads."""
        resolved_layout = _resolve_stft_output_layout(output_layout)
        cached = self._compiled_stft_fns.get(resolved_layout)
        if cached is not None:
            _record_cache_event("compiled_stft_cache.hit", key=resolved_layout)
            return cached
        _record_cache_event("compiled_stft_cache.miss", key=resolved_layout)

        @mx.compile
        def _compiled(x: mx.array) -> mx.array:
            return self.stft(x, output_layout=resolved_layout)

        self._compiled_stft_fns[resolved_layout] = _compiled
        return _compiled

    def get_compiled_istft(
        self,
        *,
        length: Optional[int] = None,
        validate: bool = False,
        torch_like: bool = False,
        allow_fused: bool = True,
        safety: str = "auto",
        long_mode_strategy: str = "native",
        backend_policy: Optional[str] = None,
        input_layout: str = "bfn",
    ):
        """Return a cached compiled iSTFT callable for fixed runtime options.

        For best throughput, reuse the returned callable with stable input shapes.
        """
        if long_mode_strategy != "native":
            raise ValueError(
                "Compiled iSTFT supports long_mode_strategy='native' only. "
                "Use eager istft for numpy_fallback/torch_fallback behavior."
            )
        resolved_backend = _resolve_backend_policy(
            backend_policy,
            default_policy=self.istft_backend_policy,
        )
        if resolved_backend == "torch_fallback":
            raise ValueError(
                "Compiled iSTFT does not support backend_policy='torch_fallback'. "
                "Use eager istft for torch fallback behavior."
            )
        resolved_input_layout = _resolve_stft_output_layout(input_layout)

        key = (
            int(length) if length is not None else -1,
            bool(validate),
            bool(torch_like),
            bool(allow_fused),
            str(safety),
            str(long_mode_strategy),
            str(resolved_backend),
            str(resolved_input_layout),
        )
        cached = self._compiled_istft_fns.get(key)
        if cached is not None:
            _record_cache_event("compiled_istft_cache.hit", key=key)
            return cached
        _record_cache_event("compiled_istft_cache.miss", key=key)

        @mx.compile
        def _compiled(z: mx.array) -> mx.array:
            return self.istft(
                z,
                length=length,
                validate=validate,
                torch_like=torch_like,
                allow_fused=allow_fused,
                safety=safety,
                long_mode_strategy=long_mode_strategy,
                backend_policy=resolved_backend,
                input_layout=resolved_input_layout,
            )

        self._compiled_istft_fns[key] = _compiled
        return _compiled

    def stft_compiled(self, x: mx.array, *, output_layout: str = "bfn") -> mx.array:
        """Execute compiled STFT using cached compiled graph."""
        return self.get_compiled_stft(output_layout=output_layout)(x)

    def istft_compiled(
        self,
        z: mx.array,
        *,
        length: Optional[int] = None,
        validate: bool = False,
        torch_like: bool = False,
        allow_fused: bool = True,
        safety: str = "auto",
        long_mode_strategy: str = "native",
        backend_policy: Optional[str] = None,
        input_layout: str = "bfn",
    ) -> mx.array:
        """Execute compiled iSTFT using cached compiled graph for fixed options."""
        fn = self.get_compiled_istft(
            length=length,
            validate=validate,
            torch_like=torch_like,
            allow_fused=allow_fused,
            safety=safety,
            long_mode_strategy=long_mode_strategy,
            backend_policy=backend_policy,
            input_layout=input_layout,
        )
        return fn(z)

    def compiled_pair(
        self,
        *,
        length: int,
        layout: str = "bfn",
        warmup_batch: Optional[int] = None,
    ) -> tuple:
        """Return ``(stft_fn, istft_fn)`` compiled for a fixed configuration.

        10–20% faster than the eager ``stft()``/``istft()`` methods in
        steady-state loops by eliminating per-call Python dispatch overhead.

        Args:
            length: Signal length in samples.  Fixed for this pair.
            layout: ``"bnf"`` (default, fastest) or ``"bfn"``.
            warmup_batch: If provided, run one warmup pass with this batch
                size so that kernel compilation and safety checks are paid
                upfront rather than on the first real call.

        Returns:
            ``(stft_fn, istft_fn)`` — call as ``z = stft_fn(x)``,
            ``y = istft_fn(z)``.

        Example::

            t = SpectralTransform(n_fft=1024, hop_length=256)
            stft, istft = t.compiled_pair(length=44100, warmup_batch=2)

            for chunk in stream:
                z = stft(chunk)
                z = process(z)
                y = istft(z)
                mx.eval(y)

        Inference only. The compiled callables wrap custom Metal kernels,
        which have no VJP, so ``mx.grad`` through them raises
        ``[Primitive::vjp] Not implemented for CustomKernel``. Use
        :meth:`differentiable_stft` / :meth:`differentiable_istft` when
        gradients must flow through the transform.
        """
        resolved_layout = _resolve_stft_output_layout(layout)

        # Prime the NOLA safety cache with one eager call so the compiled
        # path never hits an mx.eval barrier inside the safety check.
        warmup_len = int(length)
        warmup_b = int(warmup_batch) if warmup_batch is not None else 1
        x_warm = mx.zeros((warmup_b, warmup_len), dtype=mx.float32)
        z_warm = self.stft(x_warm, output_layout=resolved_layout)
        y_warm = self.istft(
            z_warm, length=warmup_len,
            input_layout=resolved_layout, safety="auto",
        )
        mx.eval(z_warm, y_warm)

        stft_fn = self.get_compiled_stft(output_layout=resolved_layout)
        istft_fn = self.get_compiled_istft(
            length=warmup_len,
            input_layout=resolved_layout,
            safety="auto",
        )

        # If warmup_batch was given, also prewarm the compiled graphs.
        if warmup_batch is not None:
            z_c = stft_fn(x_warm)
            y_c = istft_fn(z_c)
            mx.eval(z_c, y_c)

        return stft_fn, istft_fn

    def compiled_pair_nd(
        self,
        *,
        length: int,
        leading_shape: tuple[int, ...],
        layout: str = "bfn",
    ) -> tuple:
        """Return compiled STFT/iSTFT callables for fixed leading dimensions.

        This wraps the packed-batch STFT/iSTFT inside a compiled reshape so
        callers with stable multi-axis layouts (for example ``[B, C, T]``)
        can avoid paying Python reshape overhead on every call.
        """
        resolved_layout = _resolve_stft_output_layout(layout)
        leading = tuple(int(dim) for dim in leading_shape)
        if not leading:
            raise ValueError("leading_shape must contain at least one dimension")
        if any(dim <= 0 for dim in leading):
            raise ValueError("leading_shape dimensions must be > 0")

        key = (int(length), leading, str(resolved_layout))
        cached = self._compiled_pair_nd_fns.get(key)
        if cached is not None:
            _record_cache_event("compiled_pair_nd_cache.hit", key=key)
            return cached
        _record_cache_event("compiled_pair_nd_cache.miss", key=key)

        warmup_len = int(length)
        packed = int(math.prod(leading))
        # Prime the underlying caches and safety checks first.
        self.compiled_pair(length=warmup_len, layout=resolved_layout, warmup_batch=packed)

        x_warm = mx.zeros(leading + (warmup_len,), dtype=mx.float32)
        z_warm = self.stft(mx.reshape(x_warm, (packed, warmup_len)), output_layout=resolved_layout)
        mx.eval(z_warm)
        inner_spec_shape = tuple(int(dim) for dim in z_warm.shape[1:])
        output_audio_shape = leading + (warmup_len,)
        output_spec_shape = leading + inner_spec_shape

        @mx.compile
        def _stft_nd(x: mx.array) -> mx.array:
            x2 = mx.reshape(x, (packed, warmup_len))
            z = self.stft(x2, output_layout=resolved_layout)
            return mx.reshape(z, output_spec_shape)

        @mx.compile
        def _istft_nd(z: mx.array) -> mx.array:
            z2 = mx.reshape(z, (packed,) + inner_spec_shape)
            y = self.istft(z2, length=warmup_len, input_layout=resolved_layout, safety="auto")
            return mx.reshape(y, output_audio_shape)

        z_compiled = _stft_nd(x_warm)
        y_compiled = _istft_nd(z_compiled)
        mx.eval(z_compiled, y_compiled)

        self._compiled_pair_nd_fns[key] = (_stft_nd, _istft_nd)
        return self._compiled_pair_nd_fns[key]

    # ------------------------------------------------------------------
    # Differentiable STFT / iSTFT
    # ------------------------------------------------------------------

    def differentiable_stft(self, x: mx.array) -> mx.array:
        """STFT with gradient support.

        Returns spectrogram in **bnf** layout ``[B, N, F]``.

        Use this entry point instead of :meth:`stft` when you need
        ``mx.grad`` / ``mx.value_and_grad`` to flow through the transform.

        When Metal is available, uses a fused frame-extraction kernel for the
        forward pass and a dedicated Metal scatter-add kernel for the backward
        pass.  Falls back to pure MLX ops (``as_strided`` / FFT) on both
        paths when Metal is unavailable.

        .. note:: **Performance** — The backward pass is ~4-5x slower than
           the forward pass.  This is inherent: the ``rfft`` backward
           (which requires a full ``irfft``) dominates (~85% of backward
           time) and is handled by MLX's built-in autodiff.  The custom
           Metal scatter-add kernel adds only ~0.5 ms of overhead.
        """
        if x.ndim == 1:
            x = x[None, :]
        elif x.ndim != 2:
            raise ValueError(f"differentiable_stft expects 1D or 2D input, got {x.shape}")

        n_fft = self.n_fft
        hop_length = self.hop_length
        center = self.center
        center_pad_mode = self.center_pad_mode
        center_tail_pad = self.center_tail_pad
        window = self.window

        B, sig_len = x.shape

        # Try Metal backward kernel
        use_reflect_fast_path = (
            center and center_pad_mode == "reflect" and center_tail_pad == "symmetric"
        )
        bwd_kernel = _BackwardKernelCache.get_stft_backward() if use_reflect_fast_path else False

        if use_reflect_fast_path and bwd_kernel and bwd_kernel is not False and sig_len >= n_fft:
            # --- Metal path: fused frame extraction + Metal backward ---
            pad = n_fft // 2
            padded_len = sig_len + 2 * pad
            n_frames = (padded_len - n_fft) // hop_length + 1

            @mx.custom_function
            def _extract_frames_metal(x_inner: mx.array) -> mx.array:
                """Forward: Metal fused frame extraction (reflect-pad + window)."""
                B_i = x_inner.shape[0]
                sl_i = int(x_inner.shape[1])
                nf = (sl_i + 2 * pad - n_fft) // hop_length + 1
                fe_params = mx.array([sl_i, nf], dtype=mx.int32)
                x_c = mx.contiguous(x_inner)
                tmpl = [
                    ("T", x_c.dtype), ("NFFT", n_fft),
                    ("HOP", hop_length), ("PAD", pad),
                ]
                kernel = _FrameExtractCache.get_simple()
                outputs = kernel(
                    inputs=[x_c, window, fe_params],
                    template=tmpl,
                    output_shapes=[(B_i, nf, n_fft)],
                    output_dtypes=[x_c.dtype],
                    grid=(n_fft, nf, B_i),
                    threadgroup=(min(256, n_fft), 1, 1),
                )
                return outputs[0]  # [B, N, n_fft] — already windowed

            @_extract_frames_metal.vjp
            def _extract_frames_metal_vjp(primals, cotangent, output):
                x_p = primals
                B_i = x_p.shape[0]
                sl_i = int(x_p.shape[1])
                nf = int(output.shape[1])
                bwd_params = mx.array([sl_i, nf], dtype=mx.int32)
                cotangent_c = mx.contiguous(cotangent)
                tmpl = [
                    ("T", cotangent_c.dtype), ("NFFT", n_fft),
                    ("HOP", hop_length), ("PAD", pad),
                ]
                grid_bwd = (sl_i, B_i, 1)
                tgx = _KernelCache.autotune_threadgroup_x(
                    kernel=bwd_kernel,
                    kernel_name=f"stft_backward_{cotangent_c.dtype}",
                    n_fft=n_fft, hop=hop_length,
                    grid=grid_bwd,
                    inputs=[cotangent_c, window, bwd_params],
                    template=tmpl,
                    output_shape=(B_i, sl_i),
                    output_dtype=cotangent_c.dtype,
                    default_tgx=256,
                )
                grad_out = bwd_kernel(
                    inputs=[cotangent_c, window, bwd_params],
                    template=tmpl,
                    output_shapes=[(B_i, sl_i)],
                    output_dtypes=[cotangent_c.dtype],
                    grid=grid_bwd,
                    threadgroup=(tgx, 1, 1),
                )
                return grad_out[0]

            frames = _extract_frames_metal(x)
        else:
            # --- Pure MLX fallback path ---
            if center:
                x = _apply_center_padding(
                    x,
                    n_fft=n_fft,
                    hop_length=hop_length,
                    center_pad_mode=center_pad_mode,
                    center_tail_pad=center_tail_pad,
                )

            B, T_pad = x.shape
            if T_pad < n_fft:
                x = mx.pad(x, [(0, 0), (0, n_fft - T_pad)])
                T_pad = int(x.shape[1])

            n_frames = (T_pad - n_fft) // hop_length + 1
            frames = mx.as_strided(
                x,
                shape=(B, n_frames, n_fft),
                strides=(T_pad, hop_length, 1),
            )
            frames = frames * window[None, None, :]

        # --- FFT (natively differentiable) ---
        if self.onesided:
            spec = mx.fft.rfft(frames, axis=-1)
        else:
            spec = mx.fft.fft(frames, axis=-1)

        # --- normalization (differentiable) ---
        if self.normalized:
            spec = spec * self._inv_norm_factor

        return spec  # [B, N, F] (bnf layout)

    def differentiable_istft(
        self,
        z: mx.array,
        *,
        length: Optional[int] = None,
    ) -> mx.array:
        """iSTFT with gradient support.

        Expects spectrogram in **bnf** layout ``[B, N, F]``.
        Returns time-domain signal ``[B, T]``.

        Use this entry point instead of :meth:`istft` when you need
        ``mx.grad`` / ``mx.value_and_grad`` to flow through the transform.

        When Metal is available, uses the fused OLA+norm kernel for the
        forward pass and a dedicated Metal gather kernel for the backward
        pass.  Falls back to pure MLX ops on both paths when Metal is
        unavailable.

        .. note:: **Performance** — The backward pass cost is dominated by
           the ``irfft`` backward (a full ``rfft``), which is handled by
           MLX's built-in autodiff.  The custom Metal gather kernel adds
           only ~0.5 ms of overhead.
        """
        if z.ndim == 2:
            z = z[None, ...]
        elif z.ndim != 3:
            raise ValueError(
                f"differentiable_istft expects 2D or 3D input, got {z.shape}"
            )

        n_fft = self.n_fft
        hop_length = self.hop_length
        window = self.window
        window_sq = self._window_sq
        center = self.center
        center_tail_pad = self.center_tail_pad
        length_int = int(length) if length is not None else None
        if center and center_tail_pad == "minimal" and length_int is None:
            raise ValueError(
                "length is required when center_tail_pad='minimal' for differentiable_istft"
            )

        B, n_frames, freq_bins = z.shape
        n_frames_int = int(n_frames)
        out_len = hop_length * (n_frames_int - 1) + n_fft
        onesided_bins = int(n_fft // 2 + 1)
        twosided_bins = int(n_fft)
        if int(freq_bins) not in (onesided_bins, twosided_bins):
            raise ValueError(
                "differentiable_istft expects frequency bins in the last axis "
                f"with size {onesided_bins} (onesided) or {twosided_bins} "
                f"(dualsided); got {int(freq_bins)}"
            )
        is_onesided_input = (
            int(freq_bins) == onesided_bins
            and (onesided_bins != twosided_bins or self.onesided)
        )

        # --- Step 1: iFFT (natively differentiable) ---
        if is_onesided_input:
            time_frames = mx.fft.irfft(z, n=n_fft, axis=-1)  # [B, N, n_fft]
        else:
            time_frames = mx.fft.ifft(z, axis=-1).real  # [B, N, n_fft]

        # --- Step 2: normalization (differentiable) ---
        if self.normalized:
            time_frames = time_frames * self._norm_factor

        # Try Metal backward kernel
        bwd_kernel = _BackwardKernelCache.get_istft_backward()
        ola_norm_kernel = _KernelCache.get_ola_norm()
        use_metal = (
            bwd_kernel and bwd_kernel is not False
            and ola_norm_kernel and ola_norm_kernel is not False
        )

        if use_metal:
            # --- Metal path: fused OLA+norm forward + Metal gather backward ---

            # Pre-compute envelope (needed for backward kernel)
            envelope_kernel = _KernelCache.get_envelope()
            if envelope_kernel and envelope_kernel is not False:
                env_params = mx.array([n_frames_int, out_len], dtype=mx.int32)
                env_unroll_k = _unroll_k(n_fft, hop_length)
                env_tmpl = [("T", mx.float32), ("HOP", hop_length), ("FRAME", n_fft), ("UNROLL_K", env_unroll_k)]
                env_grid = (out_len, 1, 1)
                env_tgx = _KernelCache.autotune_threadgroup_x(
                    kernel=envelope_kernel,
                    kernel_name=f"ola_envelope_{mx.float32}",
                    n_fft=n_fft, hop=hop_length,
                    grid=env_grid,
                    inputs=[window_sq.astype(mx.float32), env_params],
                    template=env_tmpl,
                    output_shape=(out_len,),
                    output_dtype=mx.float32,
                    default_tgx=256,
                )
                env_outputs = envelope_kernel(
                    inputs=[window_sq.astype(mx.float32), env_params],
                    template=env_tmpl,
                    grid=env_grid,
                    threadgroup=(env_tgx, 1, 1),
                    output_shapes=[(out_len,)],
                    output_dtypes=[mx.float32],
                    init_value=0,
                )
                envelope = env_outputs[0]
            else:
                # Fallback envelope computation
                frame_starts = mx.arange(n_frames_int, dtype=mx.int32) * hop_length
                offsets = mx.arange(n_fft, dtype=mx.int32)
                indices = frame_starts[:, None] + offsets[None, :]
                flat_indices = indices.reshape(-1)
                flat_indices_safe = mx.clip(flat_indices, 0, out_len - 1)
                valid_mask = (flat_indices < out_len).astype(mx.float32)
                wsq_tiled = mx.tile(window_sq.astype(mx.float32), (n_frames_int,)) * valid_mask
                envelope = mx.zeros((out_len,), dtype=mx.float32)
                envelope = envelope.at[flat_indices_safe].add(wsq_tiled)

            # Precompute reciprocal envelope (avoids per-thread division in backward kernel)
            inv_envelope = mx.where(envelope > 1e-11, 1.0 / envelope, mx.zeros_like(envelope))

            @mx.custom_function
            def _ola_and_trim(frames_inner: mx.array) -> mx.array:
                """Forward: Metal OLA+norm + trim."""
                window_rt, window_sq_rt = self._window_pair_for_dtype(frames_inner.dtype)
                result = _run_metal_ola_norm(
                    frames_inner, window_rt, window_sq_rt,
                    hop_length, out_len,
                )
                return _trim_ola_output(result, center, n_fft, out_len, length_int, B)

            @_ola_and_trim.vjp
            def _ola_and_trim_vjp(primals, cotangent, output):
                # Un-trim: place cotangent back into full OLA space
                grad_ola = _unpad_cotangent(
                    cotangent, center, n_fft, out_len, length_int, B,
                )
                # Metal gather backward: grad_frames[b,n,f] = grad_ola[b, n*hop+f] * win[f] * inv_env[n*hop+f]
                bwd_params = mx.array([n_frames_int, out_len], dtype=mx.int32)
                grad_ola_c = mx.contiguous(grad_ola)
                tmpl = [("T", grad_ola_c.dtype), ("NFFT", n_fft), ("HOP", hop_length)]
                grad_frames = bwd_kernel(
                    inputs=[grad_ola_c, window, inv_envelope, bwd_params],
                    template=tmpl,
                    output_shapes=[(B, n_frames_int, n_fft)],
                    output_dtypes=[grad_ola_c.dtype],
                    grid=(n_fft, n_frames_int, B),
                    threadgroup=(min(256, n_fft), 1, 1),
                )
                return grad_frames[0]

            out = _ola_and_trim(time_frames)
        else:
            # --- Pure MLX fallback path ---
            windowed = time_frames * window.astype(time_frames.dtype)[None, None, :]

            frame_starts = mx.arange(n_frames_int, dtype=mx.int32) * hop_length
            offsets = mx.arange(n_fft, dtype=mx.int32)
            indices = frame_starts[:, None] + offsets[None, :]
            flat_indices = indices.reshape(-1)
            flat_indices_safe = mx.clip(flat_indices, 0, out_len - 1)
            valid_mask = (flat_indices < out_len).astype(windowed.dtype)

            flat_vals = windowed.reshape(B, -1) * valid_mask[None, :]
            batch_offsets = (mx.arange(B, dtype=mx.int32) * out_len)[:, None]
            batch_indices = (batch_offsets + flat_indices_safe[None, :]).reshape(-1)

            # float32 accumulator to match _METAL_OLA_NORM_TEMPLATE, which keeps
            # `acc` in `float` even for fp16/bf16 inputs.
            out_flat = mx.zeros((B * out_len,), dtype=mx.float32)
            out_flat = out_flat.at[batch_indices].add(flat_vals.reshape(-1).astype(mx.float32))
            out = out_flat.reshape(B, out_len).astype(windowed.dtype)

            wsq_tiled = mx.tile(window_sq.astype(mx.float32), (n_frames_int,)) * valid_mask.astype(mx.float32)
            envelope = mx.zeros((out_len,), dtype=mx.float32)
            envelope = envelope.at[flat_indices_safe].add(wsq_tiled)

            envelope_safe = mx.where(mx.abs(envelope) > 1e-11, envelope, mx.ones_like(envelope))
            env_mask = (mx.abs(envelope) > 1e-11).astype(out.dtype)
            out = (out / envelope_safe[None, :]) * env_mask[None, :]

            out = _trim_ola_output(out, center, n_fft, out_len, length_int, B)

        return out

    def _get_ola_envelope(
        self, n_frames: int, *, require_metal: bool = False,
    ) -> tuple[mx.array, mx.array]:
        """Legacy path envelope calculation (used only if fused norm is disabled)."""
        out_len = self.hop_length * (n_frames - 1) + self.n_fft
        key = (self.n_fft, self.hop_length, out_len, n_frames)
        
        # Re-add memoization check
        if (
            getattr(self, "_cache_key", None) == key
            and self.ola_denom is not None
            and self.ola_denom_inv is not None
        ):
            if require_metal and (_KernelCache.get_envelope() is False):
                raise RuntimeError(
                    "backend_policy='metal' requires Metal envelope kernel, but it is unavailable."
                )
            _record_cache_event("ola_envelope_cache.hit", key=key)
            return self.ola_denom, self.ola_denom_inv
        _record_cache_event("ola_envelope_cache.miss", key=key)

        _, window_sq = self._window_pair_for_dtype(mx.float32)

        kernel = _KernelCache.get_envelope()
        if kernel is False:
            _record_cache_event("backend.envelope.fallback", detail="metal_unavailable")
            if require_metal:
                raise RuntimeError(
                    "backend_policy='metal' requires Metal envelope kernel, but it is unavailable."
                )
            frame = int(window_sq.shape[0])
            frame_starts = mx.arange(int(n_frames), dtype=mx.int32) * int(self.hop_length)
            sample_idx = mx.arange(frame, dtype=mx.int32)
            indices = frame_starts[:, None] + sample_idx[None, :]
            flat_indices = indices.reshape(-1)
            valid_mask = flat_indices < int(out_len)
            clipped = mx.clip(flat_indices, 0, int(out_len) - 1)

            values = mx.tile(window_sq, (int(n_frames),))
            values = values * valid_mask.astype(values.dtype)
            denom = mx.zeros((int(out_len),), dtype=window_sq.dtype)
            denom = denom.at[clipped].add(values)

            if denom.dtype != mx.float32:
                denom = denom.astype(mx.float32)
            denom_inv = mx.where(mx.abs(denom) > 1.0e-11, 1.0 / denom, mx.zeros_like(denom))
            self.ola_denom = denom
            self.ola_denom_inv = denom_inv
            self._cache_key = key
            return denom, denom_inv
            
        params = mx.array([int(n_frames), int(out_len)], dtype=mx.int32)
        env_unroll_k = _unroll_k(self.n_fft, self.hop_length)
        tmpl = [
            ("T", window_sq.dtype), ("HOP", self.hop_length),
            ("FRAME", self.n_fft), ("UNROLL_K", env_unroll_k),
        ]
        _record_tmpl_event("envelope", tmpl)

        tgx = _KernelCache.autotune_threadgroup_x(
            kernel=kernel,
            kernel_name=f"ola_envelope_optimized_{window_sq.dtype}",
            n_fft=self.n_fft,
            hop=self.hop_length,
            grid=(out_len, 1, 1),
            inputs=[window_sq, params],
            template=tmpl,
            output_shape=(out_len,),
            output_dtype=window_sq.dtype,
            default_tgx=256,
        )

        outputs = kernel(
            inputs=[window_sq, params],
            template=tmpl,
            grid=(out_len, 1, 1),
            threadgroup=(tgx, 1, 1),
            output_shapes=[(out_len,)],
            output_dtypes=[window_sq.dtype],
            init_value=0,
        )
        _record_cache_event("backend.envelope.metal")

        denom = outputs[0]
        if denom.dtype != mx.float32:
            denom = denom.astype(mx.float32)
        # Match fused kernel semantics: masked divide when envelope is tiny.
        denom_inv = mx.where(mx.abs(denom) > 1.0e-11, 1.0 / denom, mx.zeros_like(denom))
        self.ola_denom = denom
        self.ola_denom_inv = denom_inv
        self._cache_key = key
        return denom, denom_inv

    def stft(self, x: mx.array, *, output_layout: str = "bfn") -> mx.array:
        """
        Forward STFT.
        Input: [T] or [B, T]
        Output: [B, F, N] (Complex, `output_layout="bfn"`), or
                [B, N, F] (Complex, `output_layout="bnf"`)
        """
        resolved_layout = _resolve_stft_output_layout(output_layout)
        if x.ndim == 1:
            x = x[None, :]
        elif x.ndim != 2:
            raise ValueError(f"stft expects 1D or 2D input, got {x.shape}")

        B, sig_len = x.shape

        # ── Fast path: fused frame extraction ────────────────────────
        # When center=True and the signal is long enough, a Metal kernel
        # combines reflect-pad + strided windowing, eliminating the
        # padded-signal intermediate buffer.
        #
        # Two kernel variants:
        #   Tiled  — uses threadgroup shared memory for ~NFFT/HOP data reuse.
        #            ~1.3× faster when bandwidth-bound (large B × sig_len).
        #   Simple — one thread per output element, no shared memory.
        #            Used for small workloads where dispatch latency dominates.
        use_reflect_fast_path = (
            self.center
            and self.center_pad_mode == "reflect"
            and self.center_tail_pad == "symmetric"
        )
        if use_reflect_fast_path and sig_len >= self.n_fft:
            pad = self.n_fft // 2
            padded_len = sig_len + 2 * pad
            n_frames = (padded_len - self.n_fft) // self.hop_length + 1
            out_bytes = B * n_frames * self.n_fft * 4

            # params buffer: dynamic lengths as runtime inputs (not template constants)
            # to avoid kernel recompilation for every unique audio length.
            fe_params = mx.array([int(sig_len), int(n_frames)], dtype=mx.int32)

            # Try tiled kernel for large workloads
            tiled_ok = False
            if out_bytes >= _TILED_FRAME_EXTRACT_BYTE_THRESHOLD:
                tiled_kernel = _FrameExtractCache.get_tiled()
                tp = _FrameExtractCache.tile_params(self.n_fft, self.hop_length)
                if tiled_kernel and tp is not None:
                    tile_frames, tg_x, tg_y, chunk_len = tp
                    x = mx.contiguous(x)
                    n_tile_groups = math.ceil(n_frames / tile_frames)
                    tmpl = [
                        ("T", x.dtype), ("NFFT", self.n_fft),
                        ("HOP", self.hop_length), ("PAD", pad),
                        ("TILE_FRAMES", tile_frames), ("TG_X", tg_x),
                        ("TG_Y", tg_y), ("CHUNK_LEN", chunk_len),
                    ]
                    outputs = tiled_kernel(
                        inputs=[x, self.window, fe_params],
                        template=tmpl,
                        output_shapes=[(B, n_frames, self.n_fft)],
                        output_dtypes=[x.dtype],
                        grid=(n_tile_groups * tg_x, tg_y, B),
                        threadgroup=(tg_x, tg_y, 1),
                    )
                    tiled_ok = True

            # Fall back to simple kernel
            if not tiled_ok:
                kernel = _FrameExtractCache.get_simple()
                if kernel and kernel is not False:
                    x = mx.contiguous(x)
                    tmpl = [
                        ("T", x.dtype), ("NFFT", self.n_fft),
                        ("HOP", self.hop_length), ("PAD", pad),
                    ]
                    fe_grid = (self.n_fft, n_frames, B)
                    fe_tgx = _KernelCache.autotune_threadgroup_x(
                        kernel=kernel,
                        kernel_name=f"fused_frame_extract_{x.dtype}",
                        n_fft=self.n_fft,
                        hop=self.hop_length,
                        grid=fe_grid,
                        inputs=[x, self.window, fe_params],
                        template=tmpl,
                        output_shape=(B, n_frames, self.n_fft),
                        output_dtype=x.dtype,
                        default_tgx=min(256, self.n_fft),
                    )
                    outputs = kernel(
                        inputs=[x, self.window, fe_params],
                        template=tmpl,
                        output_shapes=[(B, n_frames, self.n_fft)],
                        output_dtypes=[x.dtype],
                        grid=fe_grid,
                        threadgroup=(fe_tgx, 1, 1),
                    )
                else:
                    outputs = None

            if outputs is not None:
                if self.onesided:
                    spec = mx.fft.rfft(outputs[0], axis=-1)
                else:
                    spec = mx.fft.fft(outputs[0], axis=-1)
                if self.normalized:
                    spec = spec * self._inv_norm_factor
                if resolved_layout == "bnf":
                    return spec
                return spec.transpose(0, 2, 1)

        # ── Fallback path ────────────────────────────────────────────
        # Ensure contiguous memory before striding
        x = mx.contiguous(x)

        if self.center:
            x = _apply_center_padding(
                x,
                n_fft=self.n_fft,
                hop_length=self.hop_length,
                center_pad_mode=self.center_pad_mode,
                center_tail_pad=self.center_tail_pad,
            )

        B, T_pad = x.shape
        if T_pad < self.n_fft:
            need = self.n_fft - T_pad
            x = mx.pad(x, [(0, 0), (0, need)], mode="constant")
            B, T_pad = x.shape

        n_frames = (T_pad - self.n_fft) // self.hop_length + 1

        # Strided view (zero-copy)
        frames = mx.as_strided(
            x,
            shape=(B, n_frames, self.n_fft),
            strides=(T_pad, self.hop_length, 1),
        )

        # Apply window
        frames = frames * self.window

        # FFT (Real -> Complex)
        if self.onesided:
            spec = mx.fft.rfft(frames, axis=-1)
        else:
            spec = mx.fft.fft(frames, axis=-1)

        if self.normalized:
            spec = spec * self._inv_norm_factor

        # MLX rFFT emits [B, N, F]. Keep native layout for bnf, transpose for bfn.
        if resolved_layout == "bnf":
            return spec
        return spec.transpose(0, 2, 1)

    def istft(
        self,
        z: mx.array,
        length: Optional[int] = None,
        validate: bool = False,
        *,
        torch_like: bool = False,
        allow_fused: bool = True,
        safety: str = "auto",
        long_mode_strategy: str = "native",
        backend_policy: Optional[str] = None,
        input_layout: str = "bfn",
    ) -> mx.array:
        """
        Inverse STFT.
        Input: [B, F, N] (Complex, ``input_layout="bfn"``) or
               [B, N, F] (Complex, ``input_layout="bnf"``)
        Output: [B, T] (Real)

        long_mode_strategy:
          - "native": always use MLX FFT for iFFT (fastest path).
          - "numpy_fallback": **deprecated** — originally reduced cross-framework
            numerical drift, but MLX's irfft now matches NumPy/Torch within
            float32 noise.  Will be removed in a future release.
          - "torch_fallback": **deprecated** — same rationale as numpy_fallback.
        backend_policy:
          - "auto": use legacy routing rules from long_mode_strategy.
          - "mlx_fft": force MLX iFFT path (no NumPy/Torch fallback route).
          - "metal": same as mlx_fft, but require Metal OLA/envelope kernels.
          - "torch_fallback": force torch.istft path for this call.
        """
        if long_mode_strategy not in {"native", "numpy_fallback", "torch_fallback"}:
            raise ValueError(
                "long_mode_strategy must be one of "
                "{'native', 'numpy_fallback', 'torch_fallback'}"
            )
        if long_mode_strategy != "native":
            warnings.warn(
                f"long_mode_strategy='{long_mode_strategy}' is deprecated and will "
                "be removed in a future release. MLX's irfft now matches NumPy/Torch "
                "within float32 noise; use long_mode_strategy='native' instead.",
                DeprecationWarning,
                stacklevel=2,
            )
        resolved_backend = _resolve_backend_policy(
            backend_policy,
            default_policy=self.istft_backend_policy,
        )
        resolved_input_layout = _resolve_stft_output_layout(input_layout)
        if resolved_backend != "auto" and long_mode_strategy != "native":
            raise ValueError(
                "When backend_policy is not 'auto', long_mode_strategy must be 'native'."
            )
        _record_cache_event(f"backend_policy.call.{resolved_backend}")

        orig_2d_input = (z.ndim == 2)
        if orig_2d_input:
            z = z[None, ...]
        elif z.ndim != 3:
            raise ValueError(
                "istft expects a 2D/3D complex spectrogram in [F, N]/[B, F, N] "
                f"(input_layout='bfn') or [N, F]/[B, N, F] (input_layout='bnf'); got {z.shape}"
            )

        z_bfn = None
        z_bnf = None
        onesided_bins = int(self.n_fft // 2 + 1)
        twosided_bins = int(self.n_fft)
        if resolved_input_layout == "bfn":
            B, freq_bins, n_frames = z.shape
            if int(freq_bins) not in (onesided_bins, twosided_bins):
                raise ValueError(
                    "istft input_layout='bfn' expects frequency bins in axis=1 with "
                    f"size {onesided_bins} (onesided) or {twosided_bins} (dualsided); "
                    f"got axis=1 size {int(freq_bins)}. "
                    "If your input is [B, N, F], pass input_layout='bnf'."
                )
            z_bfn = z
        else:
            B, n_frames, freq_bins = z.shape
            if int(freq_bins) not in (onesided_bins, twosided_bins):
                raise ValueError(
                    "istft input_layout='bnf' expects frequency bins in axis=2 with "
                    f"size {onesided_bins} (onesided) or {twosided_bins} (dualsided); "
                    f"got axis=2 size {int(freq_bins)}. "
                    "If your input is [B, F, N], pass input_layout='bfn'."
                )
            z_bnf = z
        is_onesided_input = (
            int(freq_bins) == onesided_bins
            and (onesided_bins != twosided_bins or self.onesided)
        )

        if self.center:
            if self.center_tail_pad == "minimal":
                trimmed_length = self.hop_length * int(n_frames)
            else:
                trimmed_length = self.hop_length * (int(n_frames) - 1)
        else:
            trimmed_length = self.hop_length * (int(n_frames) - 1) + self.n_fft
        is_long_request = (length is not None) and (int(length) > int(trimmed_length))

        if resolved_backend == "torch_fallback":
            warnings.warn(
                "backend_policy='torch_fallback' is deprecated and will be removed "
                "in a future release. MLX's irfft now matches Torch within float32 "
                "noise; use backend_policy='auto' or 'mlx_fft' instead.",
                DeprecationWarning,
                stacklevel=2,
            )
            if z_bfn is None:
                z_bfn = z.transpose(0, 2, 1)
            out_torch = self._istft_torch_fallback(z_bfn, length=length)
            if out_torch is None:
                raise RuntimeError(
                    "backend_policy='torch_fallback' requested, but torch fallback is unavailable."
                )
            _record_cache_event("backend_policy.route.torch_fallback_forced")
            if orig_2d_input:
                out_torch = out_torch[0]
            return out_torch

        use_torch_fallback = (
            (resolved_backend == "auto")
            and
            bool(self.center)
            and (self.center_tail_pad == "symmetric")
            and bool(is_long_request)
            and (long_mode_strategy == "torch_fallback")
            and (int(self.hop_length) * 2 == int(self.n_fft))
        )
        if use_torch_fallback:
            if z_bfn is None:
                z_bfn = z.transpose(0, 2, 1)
            out_torch = self._istft_torch_fallback(z_bfn, length=length)
            if out_torch is not None:
                _record_cache_event("backend_policy.route.torch_fallback_auto")
                if orig_2d_input:
                    out_torch = out_torch[0]
                return out_torch

        # Keep native [B, N, F] layout for irfft whenever possible.
        if z_bnf is None:
            z_bnf = z.transpose(0, 2, 1)

        use_numpy_fallback = (
            (resolved_backend == "auto")
            and bool(self.center)
            and bool(is_long_request)
            and (long_mode_strategy == "numpy_fallback")
        )
        if use_numpy_fallback:
            _record_cache_event("backend_policy.route.numpy_fallback")
            try:
                z_np = np.asarray(z_bnf)
                # NumPy's IRFFT tracks torch.fft.irfft closely for these inputs and
                # avoids amplified tail drift in center+long reconstruction.
                if is_onesided_input:
                    time_frames_np = np.fft.irfft(
                        z_np, n=self.n_fft, axis=-1,
                    ).astype(np.float32, copy=False)
                else:
                    time_frames_np = np.fft.ifft(
                        z_np, axis=-1,
                    ).real.astype(np.float32, copy=False)
                time_frames = mx.array(time_frames_np, dtype=mx.float32)
            except Exception as err:
                warnings.warn(
                    "numpy irfft fallback failed; continuing with native MLX irfft path "
                    f"(fallback error: {err})",
                    RuntimeWarning,
                    stacklevel=2,
                )
                if is_onesided_input:
                    time_frames = mx.fft.irfft(z_bnf, n=self.n_fft, axis=-1)
                else:
                    time_frames = mx.fft.ifft(z_bnf, axis=-1).real
        else:
            # iFFT (Complex -> Real)
            if is_onesided_input:
                _record_cache_event("backend_policy.route.mlx_irfft")
                time_frames = mx.fft.irfft(z_bnf, n=self.n_fft, axis=-1)
            else:
                _record_cache_event("backend_policy.route.mlx_ifft")
                time_frames = mx.fft.ifft(z_bnf, axis=-1).real
        
        if self.normalized:
            time_frames = time_frames * self._norm_factor
        window_runtime, window_sq_runtime = self._window_pair_for_dtype(time_frames.dtype)

        out_len = self.hop_length * (n_frames - 1) + self.n_fft

        fuse_norm = _MLX_OLA_FUSE_NORM and allow_fused
        require_metal = (resolved_backend == "metal")

        # Optional Torch-style NOLA safety check (cached) even when fused.
        if fuse_norm:
            _ola_envelope_min_check_cached(
                self,
                n_frames=int(n_frames),
                length=length,
                torch_like=bool(torch_like),
                safety=safety,
                require_metal=require_metal,
            )

        if fuse_norm and not validate:
            out = _run_metal_ola_norm(
                time_frames,
                window_runtime,
                window_sq_runtime,
                self.hop_length,
                out_len,
                require_metal=require_metal,
            )
        else:
            out_sum = _run_metal_ola(
                time_frames,
                window_runtime,
                self.hop_length,
                out_len,
                require_metal=require_metal,
            )
            denom, denom_inv = self._get_ola_envelope(n_frames, require_metal=require_metal)

            # Torch-like math: masked divide by envelope (no epsilon clamp).
            if out_sum.dtype != mx.float32:
                out_sum = out_sum.astype(mx.float32)
            out_legacy = out_sum * denom_inv

            if validate:
                out_fused = _run_metal_ola_norm(
                    time_frames,
                    window_runtime,
                    window_sq_runtime,
                    self.hop_length,
                    out_len,
                    require_metal=require_metal,
                )
                mx.eval(out_fused, out_legacy)
                if not mx.allclose(out_fused, out_legacy, atol=1e-5):
                    diff = mx.max(mx.abs(out_fused - out_legacy))
                    mx.eval(diff)
                    raise RuntimeError(f"istft mismatch: max diff {float(diff.item()):.3e}")
                out = out_fused
            else:
                out = out_legacy
        # Trimming / Torch-like length handling
        if self.center and self.center_tail_pad == "minimal" and length is None:
            raise ValueError(
                "length is required when center_tail_pad='minimal' for istft"
            )
        if self.center:
            pad = self.n_fft // 2
            if length is None:
                out = out[:, pad:-pad] if int(out.shape[1]) > (2 * pad) else out[:, :0]
            else:
                start = pad
                target = int(length)
                end = min(int(out.shape[1]), start + target)
                out = out[:, start:end]
                shortfall = target - int(out.shape[1])
                if shortfall > 0:
                    out = mx.pad(out, [(0, 0), (0, shortfall)])
        elif length is not None:
            target = int(length)
            if int(out.shape[1]) >= target:
                out = out[:, :target]
            else:
                out = mx.pad(out, [(0, 0), (0, target - int(out.shape[1]))])

        if orig_2d_input:
            out = out[0]

        return out

    def _istft_torch_fallback(
        self, z_bfn: mx.array, *, length: Optional[int],
    ) -> Optional[mx.array]:
        """Run torch.istft for strict parity in selected long-mode cases."""
        if self.center and self.center_tail_pad != "symmetric":
            _record_cache_event("backend.torch_fallback.unsupported_center_tail_pad")
            return None
        try:
            import torch
        except Exception as err:
            _record_cache_event("backend.torch_fallback.import_error")
            warnings.warn(
                "torch fallback unavailable; continuing with native MLX iFFT path "
                f"(import error: {err})",
                RuntimeWarning,
                stacklevel=2,
            )
            return None

        try:
            spec_np = np.asarray(z_bfn)
            if spec_np.ndim != 3:
                raise ValueError(f"expected [B, F, N] spec for torch fallback, got {spec_np.shape}")

            device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
            spec_t = torch.from_numpy(spec_np)
            if spec_t.dtype != torch.complex64:
                spec_t = spec_t.to(dtype=torch.complex64)
            spec_t = spec_t.to(device=device)

            window_t = self._torch_window_cache.get(device.type)
            if window_t is None:
                window_np = np.asarray(self.window, dtype=np.float32)
                window_t = torch.from_numpy(window_np).to(device=device, dtype=torch.float32)
                self._torch_window_cache[device.type] = window_t

            freq_bins = int(spec_t.shape[1])
            onesided = freq_bins != int(self.n_fft)
            with warnings.catch_warnings():
                # Torch MPS may emit a noisy internal resize warning here that does not
                # affect correctness for this fallback path.
                warnings.filterwarnings(
                    "ignore",
                    message=(
                        r"An output with one or more elements was resized"
                        r" since it had shape \[\].*"
                    ),
                    category=UserWarning,
                )
                out_t = torch.istft(
                    spec_t,
                    n_fft=int(self.n_fft),
                    hop_length=int(self.hop_length),
                    win_length=int(self.win_length),
                    window=window_t,
                    center=bool(self.center),
                    normalized=bool(self.normalized),
                    onesided=bool(onesided),
                    return_complex=False,
                    length=(int(length) if length is not None else None),
                )
            _record_cache_event("backend.torch_fallback.success")
            return mx.array(out_t.detach().to("cpu").numpy(), dtype=mx.float32)
        except Exception as err:
            _record_cache_event("backend.torch_fallback.error")
            warnings.warn(
                "torch fallback failed; continuing with native MLX iFFT path "
                f"(fallback error: {err})",
                RuntimeWarning,
                stacklevel=2,
            )
            return None


class MelSpectrogramTransform:
    """Mel spectrogram frontend built on top of :class:`SpectralTransform`.

    Modes:
    - ``mlx_native``: per-example ``top_db`` clipping (batch-independent).
    - ``torchaudio_compat``: torchaudio-compatible packed-batch clipping.
    - ``default``: compatibility alias of ``mlx_native``.
    """

    __slots__ = (
        "sample_rate",
        "n_fft",
        "hop_length",
        "win_length",
        "n_mels",
        "f_min",
        "f_max",
        "power",
        "norm",
        "mel_scale",
        "mode",
        "top_db",
        "output_scale",
        "log_amin",
        "log_mode",
        "log_scale",
        "spectral",
        "mel_fb",
        "_compiled_fns",
    )

    def __init__(
        self,
        *,
        sample_rate: int = 24_000,
        n_fft: int = 2_048,
        hop_length: int = 240,
        win_length: Optional[int] = None,
        n_mels: int = 128,
        f_min: float = 0.0,
        f_max: Optional[float] = None,
        power: float = 2.0,
        norm: MelNorm = None,
        mel_scale: MelScale = "htk",
        top_db: Optional[float] = 80.0,
        output_scale: MelOutputScale = "db",
        log_amin: float = 1e-5,
        log_mode: LogMelMode = "clamp",
        log_scale: float = 1.0,
        mode: MelMode = "mlx_native",
        window_fn: str = "hann",
        periodic: bool = True,
        center: bool = True,
        center_pad_mode: CenterPadMode = "reflect",
        center_tail_pad: CenterTailPad = "symmetric",
        normalized: bool = False,
    ) -> None:
        self.sample_rate = int(sample_rate)
        self.n_fft = int(n_fft)
        self.hop_length = int(hop_length)
        self.win_length = int(win_length) if win_length is not None else int(n_fft)
        self.n_mels = int(n_mels)
        self.f_min = float(f_min)
        self.f_max = float(self.sample_rate // 2 if f_max is None else f_max)
        self.power = float(power)
        self.norm = norm
        self.mel_scale = mel_scale
        mode_name = str(mode)
        if mode_name == "default":
            mode_name = "mlx_native"
        self.mode = mode_name
        self.top_db = top_db
        self.output_scale = str(output_scale)
        self.log_amin = float(log_amin)
        self.log_mode = str(log_mode)
        self.log_scale = float(log_scale)
        if self.mode not in ("mlx_native", "torchaudio_compat"):
            raise ValueError('mode must be one of {"mlx_native", "torchaudio_compat", "default"}')
        if self.power <= 0:
            raise ValueError("power must be > 0")
        if self.output_scale not in ("linear", "log", "db"):
            raise ValueError('output_scale must be one of {"linear", "log", "db"}')
        if self.log_mode not in ("clamp", "add", "log1p"):
            raise ValueError('log_mode must be one of {"clamp", "add", "log1p"}')
        if self.log_amin <= 0.0:
            raise ValueError("log_amin must be > 0")
        if self.log_scale <= 0.0:
            raise ValueError("log_scale must be > 0")

        self.spectral = get_transform_mlx(
            n_fft=self.n_fft,
            hop_length=self.hop_length,
            win_length=self.win_length,
            window_fn=window_fn,
            periodic=periodic,
            center=center,
            normalized=normalized,
            window=None,
            center_pad_mode=center_pad_mode,
            center_tail_pad=center_tail_pad,
            istft_backend_policy=None,
        )
        self.mel_fb = _cached_mel_filterbank(
            n_freqs=(self.n_fft // 2 + 1),
            f_min=self.f_min,
            f_max=self.f_max,
            n_mels=self.n_mels,
            sample_rate=self.sample_rate,
            norm=self.norm,
            mel_scale=self.mel_scale,
        )
        self._compiled_fns = {}

    def _power_spectrogram_bnf(self, x: mx.array) -> mx.array:
        """Return power spectrogram in ``[B, N, F]`` layout (internal)."""
        spec_bnf = self.spectral.stft(x, output_layout="bnf")

        # Fast path for power=2: fused Metal kernel computes re²+im² in a
        # single pass, avoiding the sqrt in mx.abs and the intermediate
        # magnitude buffer.
        if self.power == 2.0:
            kernel = _PowerSpectrumCache.get()
            if kernel and kernel is not False:
                B, N, F = spec_bnf.shape
                total = int(B) * int(N) * int(F)
                z_flat = spec_bnf.view(mx.float32)
                params = mx.array([total], dtype=mx.int32)
                result = kernel(
                    inputs=[z_flat, params],
                    template=[],
                    grid=(total, 1, 1),
                    threadgroup=(min(256, total), 1, 1),
                    output_shapes=[(total,)],
                    output_dtypes=[mx.float32],
                )[0]
                return result.reshape(int(B), int(N), int(F))

        mag = mx.abs(spec_bnf)
        if self.power == 1.0:
            power = mag
        elif self.power == 2.0:
            power = mag * mag
        else:
            power = mag ** self.power
        return power.astype(mx.float32)

    def spectrogram(self, x: mx.array) -> mx.array:
        """Return power spectrogram in ``[B, F, N]`` layout."""
        return mx.transpose(self._power_spectrogram_bnf(x), (0, 2, 1))

    def _resolve_output_scale(
        self,
        *,
        output_scale: MelOutputScale | None,
        to_db: bool | None,
    ) -> MelOutputScale:
        if output_scale is not None and to_db is not None:
            raise ValueError("output_scale and to_db cannot both be set")
        if output_scale is not None:
            resolved = str(output_scale)
        elif to_db is not None:
            resolved = "db" if to_db else "linear"
        else:
            resolved = self.output_scale
        if resolved not in ("linear", "log", "db"):
            raise ValueError('resolved output_scale must be one of {"linear", "log", "db"}')
        return resolved

    def _apply_output_scale(self, mel_bmn: mx.array, *, output_scale: MelOutputScale) -> mx.array:
        if output_scale == "linear":
            return mel_bmn
        if output_scale == "log":
            return _apply_log_scale(
                mel_bmn,
                log_amin=self.log_amin,
                log_mode=self.log_mode,
                log_scale=self.log_scale,
            )
        db_mode: Literal["torchaudio_compat", "per_example"] = (
            "torchaudio_compat" if self.mode == "torchaudio_compat" else "per_example"
        )
        return amplitude_to_db(mel_bmn, stype="power", top_db=self.top_db, mode=db_mode)

    def mel_spectrogram(
        self,
        x: mx.array,
        *,
        output_scale: MelOutputScale | None = None,
        to_db: bool | None = None,
    ) -> mx.array:
        """Compute mel spectrogram, returning ``[B, n_mels, frames]``."""
        p_bnf = self._power_spectrogram_bnf(x)  # [B,N,F] — no redundant transposes
        mel_bmn = _apply_mel_filterbank(p_bnf, mel_fb=self.mel_fb, input_layout="bnf")
        resolved = self._resolve_output_scale(output_scale=output_scale, to_db=to_db)
        return self._apply_output_scale(mel_bmn, output_scale=resolved)

    def __call__(
        self,
        x: mx.array,
        *,
        output_scale: MelOutputScale | None = None,
        to_db: bool | None = None,
    ) -> mx.array:
        return self.mel_spectrogram(x, output_scale=output_scale, to_db=to_db)

    def get_compiled(
        self,
        *,
        output_scale: MelOutputScale | None = None,
        to_db: bool | None = None,
    ):
        """Return a cached compiled mel callable for a fixed output contract."""
        resolved = self._resolve_output_scale(output_scale=output_scale, to_db=to_db)
        cached = self._compiled_fns.get(resolved)
        if cached is not None:
            return cached

        @mx.compile
        def _compiled(x: mx.array) -> mx.array:
            return self.mel_spectrogram(x, output_scale=resolved)

        self._compiled_fns[resolved] = _compiled
        return _compiled


class LogMelSpectrogramTransform(MelSpectrogramTransform):
    """Convenience wrapper for natural-log mel frontends."""

    def __init__(
        self,
        *,
        log_amin: float = 1e-5,
        log_mode: LogMelMode = "clamp",
        log_scale: float = 1.0,
        **kwargs,
    ) -> None:
        super().__init__(
            output_scale="log",
            log_amin=log_amin,
            log_mode=log_mode,
            log_scale=log_scale,
            **kwargs,
        )

    def get_compiled(self):
        """Return a cached compiled callable for the fixed log-mel contract."""
        return super().get_compiled(output_scale="log")


class FilteredSpectrogramTransform:
    """Cached shared-STFT frontend for arbitrary frequency-domain filterbanks."""

    __slots__ = (
        "sample_rate",
        "n_fft",
        "hop_length",
        "win_length",
        "power",
        "output_scale",
        "top_db",
        "log_amin",
        "log_mode",
        "window_fn",
        "periodic",
        "center",
        "center_pad_mode",
        "center_tail_pad",
        "normalized",
        "filterbank",
        "filterbank_n_freqs",
        "spectral",
        "_compiled_fn",
    )

    def __init__(
        self,
        *,
        filterbank: mx.array | np.ndarray,
        sample_rate: int = 22_050,
        n_fft: int = 2_048,
        hop_length: int = 512,
        win_length: Optional[int] = None,
        power: float = 1.0,
        output_scale: FilteredOutputScale = "linear",
        top_db: float | None = None,
        log_amin: float = 1e-5,
        log_mode: LogMelMode = "clamp",
        window_fn: str = "hann",
        periodic: bool = True,
        center: bool = True,
        center_pad_mode: CenterPadMode = "reflect",
        center_tail_pad: CenterTailPad = "symmetric",
        normalized: bool = False,
    ) -> None:
        self.sample_rate = int(sample_rate)
        self.n_fft = int(n_fft)
        self.hop_length = int(hop_length)
        self.win_length = int(win_length) if win_length is not None else int(n_fft)
        self.power = float(power)
        self.output_scale = str(output_scale)
        self.top_db = top_db
        self.log_amin = float(log_amin)
        self.log_mode = str(log_mode)
        self.window_fn = str(window_fn)
        self.periodic = bool(periodic)
        self.center = bool(center)
        self.center_pad_mode = center_pad_mode
        self.center_tail_pad = center_tail_pad
        self.normalized = bool(normalized)
        self.filterbank = mx.array(filterbank, dtype=mx.float32)
        if self.power <= 0.0:
            raise ValueError("power must be > 0")
        if self.output_scale not in ("linear", "log", "db", "log10_plus_one"):
            raise ValueError(
                'output_scale must be one of {"linear", "log", "db", "log10_plus_one"}'
            )
        if self.log_mode not in ("clamp", "add", "log1p"):
            raise ValueError('log_mode must be one of {"clamp", "add", "log1p"}')
        if self.log_amin <= 0.0:
            raise ValueError("log_amin must be > 0")
        if self.filterbank.ndim != 2:
            raise ValueError(f"filterbank must be rank-2 [n_freqs, n_bands], got {self.filterbank.shape}")
        self.filterbank_n_freqs = int(self.filterbank.shape[0])
        if self.filterbank_n_freqs not in (self.n_fft // 2, self.n_fft // 2 + 1):
            raise ValueError(
                f"filterbank axis 0 must have size {self.n_fft // 2} or {self.n_fft // 2 + 1} "
                f"for n_fft={self.n_fft}, got {self.filterbank_n_freqs}"
            )
        self.spectral = get_transform_mlx(
            n_fft=self.n_fft,
            hop_length=self.hop_length,
            win_length=self.win_length,
            window_fn=self.window_fn,
            periodic=self.periodic,
            center=self.center,
            normalized=self.normalized,
            window=None,
            center_pad_mode=self.center_pad_mode,
            center_tail_pad=self.center_tail_pad,
            istft_backend_policy=None,
        )
        self._compiled_fn = None

    def _filtered_linear(self, x: mx.array) -> tuple[mx.array, bool]:
        x_b, squeezed = _ensure_audio_batch(x, fn_name="filtered_spectrogram")
        if (
            self.center
            and self.center_pad_mode == "reflect"
            and int(x_b.shape[1]) <= (self.n_fft // 2)
        ):
            mag_bfn, _ = _stft_magnitude(
                x_b,
                sample_rate=self.sample_rate,
                n_fft=self.n_fft,
                hop_length=self.hop_length,
                win_length=self.win_length,
                window_fn=self.window_fn,
                periodic=self.periodic,
                center=self.center,
                center_pad_mode=self.center_pad_mode,
                center_tail_pad=self.center_tail_pad,
            )
        else:
            spec = self.spectral.stft(x_b, output_layout="bfn")
            mag_bfn = mx.abs(spec).astype(mx.float32)
        if int(mag_bfn.shape[1]) != self.filterbank_n_freqs:
            mag_bfn = mag_bfn[:, : self.filterbank_n_freqs, :]
        if self.power == 1.0:
            spec_bfn = mag_bfn
        elif self.power == 2.0:
            spec_bfn = mag_bfn * mag_bfn
        else:
            spec_bfn = mag_bfn ** self.power
        filtered_bnt = mx.matmul(mx.transpose(spec_bfn, (0, 2, 1)), self.filterbank)
        filtered_btn = mx.transpose(filtered_bnt, (0, 2, 1)).astype(mx.float32)
        return filtered_btn, squeezed

    def _filtered_linear_at_starts(
        self,
        x: mx.array,
        *,
        frame_starts: mx.array | np.ndarray,
    ) -> tuple[mx.array, bool]:
        x_b, squeezed = _ensure_audio_batch(x, fn_name="filtered_spectrogram_at_starts")
        starts = mx.array(frame_starts, dtype=mx.int32)
        if starts.ndim != 1:
            raise ValueError(
                f"frame_starts must be rank-1 [n_frames], got {starts.shape}"
            )
        frames = _extract_windowed_frames_at_starts(
            x_b,
            frame_starts=starts,
            frame_length=self.n_fft,
            window=self.spectral.window,
        )
        spec = mx.fft.rfft(frames, axis=-1)
        if self.normalized:
            spec = spec * (1.0 / math.sqrt(self.n_fft))
        mag_bfn = mx.abs(spec).astype(mx.float32).transpose(0, 2, 1)
        if int(mag_bfn.shape[1]) != self.filterbank_n_freqs:
            mag_bfn = mag_bfn[:, : self.filterbank_n_freqs, :]
        if self.power == 1.0:
            spec_bfn = mag_bfn
        elif self.power == 2.0:
            spec_bfn = mag_bfn * mag_bfn
        else:
            spec_bfn = mag_bfn ** self.power
        filtered_bnt = mx.matmul(mx.transpose(spec_bfn, (0, 2, 1)), self.filterbank)
        filtered_btn = mx.transpose(filtered_bnt, (0, 2, 1)).astype(mx.float32)
        return filtered_btn, squeezed

    def _apply_output_scale(self, filtered_btn: mx.array) -> mx.array:
        if self.output_scale == "linear":
            return filtered_btn
        if self.output_scale == "log":
            return _apply_log_scale(
                filtered_btn,
                log_amin=self.log_amin,
                log_mode=self.log_mode,
            )
        if self.output_scale == "log10_plus_one":
            return mx.log10(filtered_btn + 1.0).astype(mx.float32)
        stype: Literal["power", "magnitude"] = "magnitude" if self.power == 1.0 else "power"
        return amplitude_to_db(
            filtered_btn,
            stype=stype,
            top_db=self.top_db,
            mode="per_example",
        ).astype(mx.float32)

    def filtered_spectrogram(self, x: mx.array) -> mx.array:
        filtered_btn, squeezed = self._filtered_linear(x)
        out = self._apply_output_scale(filtered_btn)
        return _restore_feature_batch(out, squeezed=squeezed)

    def filtered_spectrogram_at_starts(
        self,
        x: mx.array,
        *,
        frame_starts: mx.array | np.ndarray,
    ) -> mx.array:
        filtered_btn, squeezed = self._filtered_linear_at_starts(
            x,
            frame_starts=frame_starts,
        )
        out = self._apply_output_scale(filtered_btn)
        return _restore_feature_batch(out, squeezed=squeezed)

    def filtered_spectrogram_at_fps(
        self,
        x: mx.array,
        *,
        fps: float,
        sample_rate: Optional[int] = None,
        origin: str | int = "offline",
        end: FramingEnd = "normal",
    ) -> mx.array:
        x_b, _ = _ensure_audio_batch(x, fn_name="filtered_spectrogram_at_fps")
        starts = frame_starts_from_fps(
            int(x_b.shape[1]),
            frame_size=self.n_fft,
            fps=fps,
            sample_rate=self.sample_rate if sample_rate is None else sample_rate,
            origin=origin,
            end=end,
        )
        return self.filtered_spectrogram_at_starts(x, frame_starts=starts)

    def __call__(self, x: mx.array) -> mx.array:
        return self.filtered_spectrogram(x)

    def get_compiled(self):
        """Return a cached compiled filtered-spectrogram callable."""
        cached = self._compiled_fn
        if cached is not None:
            return cached

        @mx.compile
        def _compiled(x: mx.array) -> mx.array:
            return self.filtered_spectrogram(x)

        self._compiled_fn = _compiled
        return _compiled


def filtered_spectrogram(
    x: mx.array,
    *,
    filterbank: mx.array | np.ndarray,
    sample_rate: int = 22_050,
    n_fft: int = 2_048,
    hop_length: int = 512,
    win_length: Optional[int] = None,
    power: float = 1.0,
    output_scale: FilteredOutputScale = "linear",
    top_db: float | None = None,
    log_amin: float = 1e-5,
    log_mode: LogMelMode = "clamp",
    window_fn: str = "hann",
    periodic: bool = True,
    center: bool = True,
    center_pad_mode: CenterPadMode = "reflect",
    center_tail_pad: CenterTailPad = "symmetric",
    normalized: bool = False,
) -> mx.array:
    transform = FilteredSpectrogramTransform(
        filterbank=filterbank,
        sample_rate=sample_rate,
        n_fft=n_fft,
        hop_length=hop_length,
        win_length=win_length,
        power=power,
        output_scale=output_scale,
        top_db=top_db,
        log_amin=log_amin,
        log_mode=log_mode,
        window_fn=window_fn,
        periodic=periodic,
        center=center,
        center_pad_mode=center_pad_mode,
        center_tail_pad=center_tail_pad,
        normalized=normalized,
    )
    return transform(x)


def filtered_spectrogram_at_starts(
    x: mx.array,
    *,
    frame_starts: mx.array | np.ndarray,
    filterbank: mx.array | np.ndarray,
    sample_rate: int = 22_050,
    n_fft: int = 2_048,
    hop_length: int = 512,
    win_length: Optional[int] = None,
    power: float = 1.0,
    output_scale: FilteredOutputScale = "linear",
    top_db: float | None = None,
    log_amin: float = 1e-5,
    log_mode: LogMelMode = "clamp",
    window_fn: str = "hann",
    periodic: bool = True,
    center: bool = True,
    center_pad_mode: CenterPadMode = "reflect",
    center_tail_pad: CenterTailPad = "symmetric",
    normalized: bool = False,
) -> mx.array:
    transform = FilteredSpectrogramTransform(
        filterbank=filterbank,
        sample_rate=sample_rate,
        n_fft=n_fft,
        hop_length=hop_length,
        win_length=win_length,
        power=power,
        output_scale=output_scale,
        top_db=top_db,
        log_amin=log_amin,
        log_mode=log_mode,
        window_fn=window_fn,
        periodic=periodic,
        center=center,
        center_pad_mode=center_pad_mode,
        center_tail_pad=center_tail_pad,
        normalized=normalized,
    )
    return transform.filtered_spectrogram_at_starts(x, frame_starts=frame_starts)


def filtered_spectrogram_at_fps(
    x: mx.array,
    *,
    fps: float,
    filterbank: mx.array | np.ndarray,
    sample_rate: int = 22_050,
    n_fft: int = 2_048,
    hop_length: int = 512,
    win_length: Optional[int] = None,
    power: float = 1.0,
    output_scale: FilteredOutputScale = "linear",
    top_db: float | None = None,
    log_amin: float = 1e-5,
    log_mode: LogMelMode = "clamp",
    window_fn: str = "hann",
    periodic: bool = True,
    center: bool = True,
    center_pad_mode: CenterPadMode = "reflect",
    center_tail_pad: CenterTailPad = "symmetric",
    normalized: bool = False,
    origin: str | int = "offline",
    end: FramingEnd = "normal",
) -> mx.array:
    transform = FilteredSpectrogramTransform(
        filterbank=filterbank,
        sample_rate=sample_rate,
        n_fft=n_fft,
        hop_length=hop_length,
        win_length=win_length,
        power=power,
        output_scale=output_scale,
        top_db=top_db,
        log_amin=log_amin,
        log_mode=log_mode,
        window_fn=window_fn,
        periodic=periodic,
        center=center,
        center_pad_mode=center_pad_mode,
        center_tail_pad=center_tail_pad,
        normalized=normalized,
    )
    return transform.filtered_spectrogram_at_fps(
        x,
        fps=fps,
        sample_rate=sample_rate,
        origin=origin,
        end=end,
    )


def filtered_transform_from_filterbank(
    filterbank: mx.array | np.ndarray,
    *,
    sample_rate: int,
    frame_size: int,
    hop_size: int,
    output_scale: FilteredOutputScale = "log10_plus_one",
    log_amin: float = 1e-5,
    log_mode: LogMelMode = "clamp",
    center_tail_pad: CenterTailPad = "minimal",
) -> FilteredSpectrogramTransform:
    return FilteredSpectrogramTransform(
        filterbank=np.ascontiguousarray(filterbank, dtype=np.float32),
        sample_rate=sample_rate,
        n_fft=frame_size,
        hop_length=hop_size,
        win_length=frame_size,
        power=1.0,
        output_scale=output_scale,
        log_amin=log_amin,
        log_mode=log_mode,
        window_fn="hann",
        periodic=False,
        center=True,
        center_pad_mode="constant",
        center_tail_pad=center_tail_pad,
    )


@lru_cache(maxsize=16)
def cached_log_filterbank(
    frame_size: int,
    sample_rate: int,
    num_bands: int,
    fmin: float,
    fmax: float,
    norm_filters: bool,
) -> np.ndarray:
    filterbank = log_triangular_fbanks(
        frame_size // 2,
        sample_rate,
        num_bands,
        f_min=fmin,
        f_max=fmax,
        norm_filters=norm_filters,
        include_nyquist=False,
    )
    return np.ascontiguousarray(filterbank, dtype=np.float32)


@lru_cache(maxsize=16)
def cached_mel_filterbank(
    frame_size: int,
    sample_rate: int,
    num_bands: int,
    fmin: float,
    fmax: float,
    norm_filters: bool,
) -> np.ndarray:
    bin_frequencies = (
        np.arange(frame_size // 2, dtype=np.float32) * float(sample_rate) / float(frame_size)
    )
    filterbank = mel_filterbank(
        bin_frequencies,
        num_bands,
        fmin=fmin,
        fmax=fmax,
        norm_filters=norm_filters,
    )
    return np.ascontiguousarray(filterbank, dtype=np.float32)


@lru_cache(maxsize=16)
def cached_filtered_transform(
    frame_size: int,
    hop_size: int,
    sample_rate: int,
    num_bands: int,
    fmin: float,
    fmax: float,
    norm_filters: bool,
    output_scale: FilteredOutputScale,
    log_amin: float,
    log_mode: LogMelMode,
    center_tail_pad: CenterTailPad,
) -> FilteredSpectrogramTransform:
    return filtered_transform_from_filterbank(
        cached_log_filterbank(frame_size, sample_rate, num_bands, fmin, fmax, norm_filters),
        sample_rate=sample_rate,
        frame_size=frame_size,
        hop_size=hop_size,
        output_scale=output_scale,
        log_amin=log_amin,
        log_mode=log_mode,
        center_tail_pad=center_tail_pad,
    )


def _prepare_waveform_array(waveform: np.ndarray | mx.array) -> mx.array:
    if isinstance(waveform, mx.array):
        data = waveform
        if data.ndim > 1:
            data = mx.mean(data, axis=-1)
        if data.dtype != mx.float32:
            data = data.astype(mx.float32)
        return data
    else:
        data_np = np.asarray(waveform)
        if data_np.ndim > 1:
            data_np = data_np.mean(axis=-1)
        if np.issubdtype(data_np.dtype, np.integer):
            scale = np.float32(np.iinfo(data_np.dtype).max)
            data_np = data_np.astype(np.float32) / scale
        else:
            data_np = data_np.astype(np.float32, copy=False)
        data = mx.array(np.ascontiguousarray(data_np, dtype=np.float32))
    return data


def compute_filtered_spectrogram(
    waveform: np.ndarray | mx.array,
    *,
    frame_size: int,
    hop_size: int,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    num_bands: int,
    fmin: float = DEFAULT_FMIN,
    fmax: float = DEFAULT_FMAX,
    norm_filters: bool = True,
    output_scale: FilteredOutputScale = "linear",
    log_amin: float = 1e-5,
    log_mode: LogMelMode = "clamp",
    center_tail_pad: CenterTailPad = "minimal",
) -> FilteredSpectrogramResult:
    audio = _prepare_waveform_array(waveform)
    filterbank = cached_log_filterbank(frame_size, sample_rate, num_bands, fmin, fmax, norm_filters)
    transform = cached_filtered_transform(
        frame_size,
        hop_size,
        sample_rate,
        num_bands,
        fmin,
        fmax,
        norm_filters,
        output_scale,
        log_amin,
        log_mode,
        center_tail_pad,
    )
    spec = mx.transpose(transform(audio), (1, 0))
    mx.eval(spec)
    return FilteredSpectrogramResult(
        spectrogram=np.ascontiguousarray(spec, dtype=np.float32),
        filterbank=filterbank,
    )


def compute_filtered_spectrogram_mlx(
    waveform: np.ndarray | mx.array,
    *,
    frame_size: int,
    hop_size: int,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    num_bands: int,
    fmin: float = DEFAULT_FMIN,
    fmax: float = DEFAULT_FMAX,
    norm_filters: bool = True,
    output_scale: FilteredOutputScale = "linear",
    log_amin: float = 1e-5,
    log_mode: LogMelMode = "clamp",
    center_tail_pad: CenterTailPad = "minimal",
) -> tuple[mx.array, np.ndarray]:
    audio = _prepare_waveform_array(waveform)
    filterbank = cached_log_filterbank(frame_size, sample_rate, num_bands, fmin, fmax, norm_filters)
    transform = cached_filtered_transform(
        frame_size,
        hop_size,
        sample_rate,
        num_bands,
        fmin,
        fmax,
        norm_filters,
        output_scale,
        log_amin,
        log_mode,
        center_tail_pad,
    )
    spec = mx.transpose(transform.get_compiled()(audio), (1, 0))
    return spec, filterbank


def compute_filtered_spectrogram_at_starts(
    waveform: np.ndarray | mx.array,
    *,
    frame_size: int,
    frame_starts: np.ndarray,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    num_bands: int,
    fmin: float = DEFAULT_FMIN,
    fmax: float = DEFAULT_FMAX,
    norm_filters: bool = True,
    output_scale: FilteredOutputScale = "linear",
    log_amin: float = 1e-5,
    log_mode: LogMelMode = "clamp",
    center_tail_pad: CenterTailPad = "minimal",
) -> FilteredSpectrogramResult:
    audio = _prepare_waveform_array(waveform)
    filterbank = cached_log_filterbank(frame_size, sample_rate, num_bands, fmin, fmax, norm_filters)
    transform = filtered_transform_from_filterbank(
        filterbank,
        sample_rate=sample_rate,
        frame_size=frame_size,
        hop_size=1,
        output_scale=output_scale,
        log_amin=log_amin,
        log_mode=log_mode,
        center_tail_pad=center_tail_pad,
    )
    spec = mx.transpose(
        transform.filtered_spectrogram_at_starts(audio, frame_starts=frame_starts),
        (1, 0),
    )
    mx.eval(spec)
    return FilteredSpectrogramResult(
        spectrogram=np.ascontiguousarray(spec, dtype=np.float32),
        filterbank=filterbank,
    )


def compute_filtered_spectrogram_at_fps(
    waveform: np.ndarray | mx.array,
    *,
    frame_size: int,
    fps: float,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    num_bands: int,
    fmin: float = DEFAULT_FMIN,
    fmax: float = DEFAULT_FMAX,
    norm_filters: bool = True,
    output_scale: FilteredOutputScale = "linear",
    log_amin: float = 1e-5,
    log_mode: LogMelMode = "clamp",
    center_tail_pad: CenterTailPad = "minimal",
    origin: str | int = "offline",
    end: FramingEnd = "normal",
) -> FilteredSpectrogramResult:
    audio = _prepare_waveform_array(waveform)
    filterbank = cached_log_filterbank(frame_size, sample_rate, num_bands, fmin, fmax, norm_filters)
    spec = mx.transpose(
        filtered_spectrogram_at_fps(
            audio,
            fps=fps,
            filterbank=filterbank,
            sample_rate=sample_rate,
            n_fft=frame_size,
            hop_length=1,
            output_scale=output_scale,
            log_amin=log_amin,
            log_mode=log_mode,
            window_fn="hann",
            periodic=False,
            center=True,
            center_pad_mode="constant",
            center_tail_pad=center_tail_pad,
            origin=origin,
            end=end,
        ),
        (1, 0),
    )
    mx.eval(spec)
    return FilteredSpectrogramResult(
        spectrogram=np.ascontiguousarray(spec, dtype=np.float32),
        filterbank=filterbank,
    )


def compute_log_filtered_spectrogram(
    waveform: np.ndarray | mx.array,
    *,
    frame_size: int,
    hop_size: int,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    num_bands: int,
    fmin: float = DEFAULT_FMIN,
    fmax: float = DEFAULT_FMAX,
    norm_filters: bool = True,
    log_amin: float = 1e-5,
    log_mode: LogMelMode = "clamp",
    center_tail_pad: CenterTailPad = "minimal",
) -> FilteredSpectrogramResult:
    return compute_filtered_spectrogram(
        waveform,
        frame_size=frame_size,
        hop_size=hop_size,
        sample_rate=sample_rate,
        num_bands=num_bands,
        fmin=fmin,
        fmax=fmax,
        norm_filters=norm_filters,
        output_scale="log",
        log_amin=log_amin,
        log_mode=log_mode,
        center_tail_pad=center_tail_pad,
    )


def compute_mel_spectrogram(
    waveform: np.ndarray | mx.array,
    *,
    frame_size: int,
    hop_size: int,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    num_bands: int,
    fmin: float = DEFAULT_FMIN,
    fmax: float = DEFAULT_FMAX,
    norm_filters: bool = True,
    output_scale: FilteredOutputScale = "linear",
    log_amin: float = 1e-5,
    log_mode: LogMelMode = "clamp",
    center_tail_pad: CenterTailPad = "minimal",
) -> FilteredSpectrogramResult:
    audio = _prepare_waveform_array(waveform)
    filterbank = cached_mel_filterbank(
        frame_size,
        sample_rate,
        num_bands,
        fmin,
        fmax,
        norm_filters,
    )
    transform = filtered_transform_from_filterbank(
        filterbank,
        sample_rate=sample_rate,
        frame_size=frame_size,
        hop_size=hop_size,
        output_scale=output_scale,
        log_amin=log_amin,
        log_mode=log_mode,
        center_tail_pad=center_tail_pad,
    )
    spec = mx.transpose(transform(audio), (1, 0))
    mx.eval(spec)
    return FilteredSpectrogramResult(
        spectrogram=np.ascontiguousarray(spec, dtype=np.float32),
        filterbank=filterbank,
    )


def compute_mel_spectrogram_mlx(
    waveform: np.ndarray | mx.array,
    *,
    frame_size: int,
    hop_size: int,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    num_bands: int,
    fmin: float = DEFAULT_FMIN,
    fmax: float = DEFAULT_FMAX,
    norm_filters: bool = True,
    output_scale: FilteredOutputScale = "linear",
    log_amin: float = 1e-5,
    log_mode: LogMelMode = "clamp",
    center_tail_pad: CenterTailPad = "minimal",
) -> tuple[mx.array, np.ndarray]:
    audio = _prepare_waveform_array(waveform)
    filterbank = cached_mel_filterbank(
        frame_size,
        sample_rate,
        num_bands,
        fmin,
        fmax,
        norm_filters,
    )
    transform = filtered_transform_from_filterbank(
        filterbank,
        sample_rate=sample_rate,
        frame_size=frame_size,
        hop_size=hop_size,
        output_scale=output_scale,
        log_amin=log_amin,
        log_mode=log_mode,
        center_tail_pad=center_tail_pad,
    )
    spec = mx.transpose(transform.get_compiled()(audio), (1, 0))
    return spec, filterbank


_LOG10_E = np.float32(1.0 / np.log(10.0))

_LOG_FN_DISPATCH: dict[str, object] = {
    "log": np.log,
    "log10": np.log10,
}


def _resolve_log_fn_name(log_fn) -> str | None:
    if log_fn is None:
        return None
    if isinstance(log_fn, str):
        if log_fn not in _LOG_FN_DISPATCH:
            raise ValueError(f"Unsupported log_fn string: {log_fn!r} (expected 'log' or 'log10')")
        return log_fn
    if log_fn is np.log or getattr(log_fn, "__name__", None) == "log":
        return "log"
    if log_fn is np.log10 or getattr(log_fn, "__name__", None) == "log10":
        return "log10"
    raise ValueError(
        f"Unsupported log_fn: {log_fn!r}. Pass 'log', 'log10', np.log, np.log10, or None."
    )


def _logarithmic_spectrogram_mlx(
    spec: mx.array,
    *,
    mul: float | None,
    add: float | None,
    log_fn,
) -> mx.array:
    x = spec
    if mul is not None:
        x = x * float(mul)
    if add is not None:
        x = x + float(add)
    name = _resolve_log_fn_name(log_fn)
    if name is None:
        return x
    if name == "log":
        return mx.log(x)
    return mx.log(x) * _LOG10_E


def _repeat_pad_frames_mlx(
    frames: mx.array,
    pad_before: int,
    *,
    pad_after: int | None = None,
    axis: int = 0,
) -> mx.array:
    if pad_after is None:
        pad_after = pad_before
    if pad_before <= 0 and pad_after <= 0:
        return frames
    axis = int(axis)
    if axis < 0:
        axis += frames.ndim
    parts: list[mx.array] = []
    if pad_before > 0:
        head = mx.take(frames, mx.array([0], dtype=mx.int32), axis=axis)
        parts.append(mx.repeat(head, pad_before, axis=axis))
    parts.append(frames)
    if pad_after > 0:
        tail = mx.take(frames, mx.array([frames.shape[axis] - 1], dtype=mx.int32), axis=axis)
        parts.append(mx.repeat(tail, pad_after, axis=axis))
    return mx.concatenate(parts, axis=axis)


def madmom_multires_mel_stack_mlx(
    waveform: np.ndarray | mx.array,
    *,
    frame_sizes: tuple[int, ...],
    fps: float,
    num_bands: int,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    fmin: float = DEFAULT_FMIN,
    fmax: float = DEFAULT_FMAX,
    norm_filters: bool = True,
    output_scale: FilteredOutputScale = "linear",
    log_fn=np.log,
    mul: float | None = None,
    add: float | None = np.spacing(1),
    pad_frames: int = 0,
) -> mx.array:
    hop_size = int(round(hop_size_from_fps(fps, sample_rate)))
    blocks: list[mx.array] = []
    min_len: int | None = None
    for frame_size in frame_sizes:
        filt, _ = compute_mel_spectrogram_mlx(
            waveform,
            frame_size=frame_size,
            hop_size=hop_size,
            sample_rate=sample_rate,
            num_bands=num_bands,
            fmin=fmin,
            fmax=fmax,
            norm_filters=norm_filters,
            output_scale=output_scale,
        )
        block = _logarithmic_spectrogram_mlx(filt, mul=mul, add=add, log_fn=log_fn)
        min_len = block.shape[0] if min_len is None else min(min_len, int(block.shape[0]))
        blocks.append(block)
    assert min_len is not None
    trimmed = [block[:min_len] for block in blocks]
    stacked = mx.stack(trimmed, axis=2)
    return _repeat_pad_frames_mlx(stacked, pad_frames, axis=0) if pad_frames > 0 else stacked


def madmom_single_resolution_log_stack_mlx(
    waveform: np.ndarray | mx.array,
    *,
    frame_size: int,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    num_bands: int,
    fmin: float = DEFAULT_FMIN,
    fmax: float = DEFAULT_FMAX,
    norm_filters: bool = True,
    filterbank: Literal["log", "mel"] = "log",
    fps: float | None = None,
    hop_size: int | None = None,
    output_scale: FilteredOutputScale = "linear",
    log_fn=np.log10,
    mul: float | None = None,
    add: float | None = 1.0,
    pad_frames: int = 0,
    center_tail_pad: CenterTailPad = "minimal",
) -> mx.array:
    if hop_size is None:
        if fps is None:
            raise ValueError("either fps or hop_size must be provided")
        hop_size = int(round(hop_size_from_fps(fps, sample_rate)))
    if filterbank == "log":
        filt, _ = compute_filtered_spectrogram_mlx(
            waveform,
            frame_size=frame_size,
            hop_size=hop_size,
            sample_rate=sample_rate,
            num_bands=num_bands,
            fmin=fmin,
            fmax=fmax,
            norm_filters=norm_filters,
            output_scale=output_scale,
            center_tail_pad=center_tail_pad,
        )
    elif filterbank == "mel":
        filt, _ = compute_mel_spectrogram_mlx(
            waveform,
            frame_size=frame_size,
            hop_size=hop_size,
            sample_rate=sample_rate,
            num_bands=num_bands,
            fmin=fmin,
            fmax=fmax,
            norm_filters=norm_filters,
            output_scale=output_scale,
            center_tail_pad=center_tail_pad,
        )
    else:
        raise ValueError(f"Unsupported filterbank: {filterbank}")
    log_spec = _logarithmic_spectrogram_mlx(filt, mul=mul, add=add, log_fn=log_fn)
    return _repeat_pad_frames_mlx(log_spec, pad_frames, axis=0) if pad_frames > 0 else log_spec


def trim_to_shortest(
    blocks: list[np.ndarray] | tuple[np.ndarray, ...],
    *,
    axis: int = 0,
) -> list[np.ndarray]:
    arrays = [np.asarray(block) for block in blocks]
    if not arrays:
        return []
    min_len = min(int(array.shape[axis]) for array in arrays)
    trimmed = []
    for array in arrays:
        slices = [slice(None)] * array.ndim
        slices[axis] = slice(0, min_len)
        trimmed.append(
            np.ascontiguousarray(array[tuple(slices)], dtype=np.float32)
        )
    return trimmed


def repeat_pad_frames(
    frames: np.ndarray,
    pad_before: int,
    *,
    pad_after: int | None = None,
    axis: int = 0,
) -> np.ndarray:
    array = np.asarray(frames, dtype=np.float32)
    if pad_after is None:
        pad_after = pad_before
    if pad_before <= 0 and pad_after <= 0:
        return np.ascontiguousarray(array, dtype=np.float32)
    axis = int(axis)
    if axis < 0:
        axis += array.ndim
    if axis < 0 or axis >= array.ndim:
        raise ValueError(f"axis {axis} is out of bounds for shape {array.shape}")
    if array.shape[axis] == 0:
        raise ValueError("cannot pad an empty frame array")

    parts: list[np.ndarray] = []
    if pad_before > 0:
        head = np.take(array, [0], axis=axis)
        parts.append(np.repeat(head, pad_before, axis=axis))
    parts.append(array)
    if pad_after > 0:
        tail = np.take(array, [-1], axis=axis)
        parts.append(np.repeat(tail, pad_after, axis=axis))
    return np.ascontiguousarray(np.concatenate(parts, axis=axis), dtype=np.float32)


def stack_feature_blocks(
    blocks: list[np.ndarray] | tuple[np.ndarray, ...],
    *,
    layout: Literal["feature_stack", "channel_stack"] = "feature_stack",
) -> np.ndarray:
    trimmed = trim_to_shortest(blocks, axis=0)
    if not trimmed:
        raise ValueError("stack_feature_blocks requires at least one block")
    if layout == "feature_stack":
        return np.ascontiguousarray(np.hstack(trimmed), dtype=np.float32)
    if layout == "channel_stack":
        return np.ascontiguousarray(np.dstack(trimmed), dtype=np.float32)
    raise ValueError(f"Unsupported block layout: {layout}")


def positive_spectral_diff_numpy(
    spec: np.ndarray,
    *,
    diff_frames: int,
    diff_max_bins: int | None = None,
    positive_diffs: bool = True,
) -> np.ndarray:
    diff = np.zeros_like(spec, dtype=np.float32)
    if diff_max_bins is None:
        diff[diff_frames:] = spec[diff_frames:] - spec[:-diff_frames]
    else:
        padded = np.pad(
            spec[:-diff_frames],
            ((0, 0), (diff_max_bins // 2, diff_max_bins - 1 - diff_max_bins // 2)),
            mode="reflect",
        )
        windows = np.lib.stride_tricks.sliding_window_view(padded, diff_max_bins, axis=1)
        ref = windows.max(axis=-1)
        diff[diff_frames:] = spec[diff_frames:] - ref
    if positive_diffs:
        diff = np.maximum(diff, 0.0)
    return diff.astype(np.float32)


def _bands_per_resolution(
    frame_sizes: tuple[int, ...],
    num_bands: int | tuple[int, ...],
) -> tuple[int, ...]:
    if isinstance(num_bands, int):
        return tuple([num_bands] * len(frame_sizes))
    bands = tuple(int(value) for value in num_bands)
    if len(bands) != len(frame_sizes):
        raise ValueError("num_bands tuple must have the same length as frame_sizes")
    return bands


def madmom_multires_log_diff_features(
    waveform: np.ndarray | mx.array,
    *,
    frame_sizes: tuple[int, ...],
    fps: float,
    num_bands: int | tuple[int, ...],
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    fmin: float = DEFAULT_FMIN,
    fmax: float = DEFAULT_FMAX,
    norm_filters: bool = True,
    output_scale: FilteredOutputScale = "linear",
    log_fn=np.log10,
    mul: float | None = 1.0,
    add: float | None = 1.0,
    diff_ratio: float = 0.5,
    diff_max_bins: int | None = None,
    positive_diffs: bool = True,
) -> np.ndarray:
    hop_size = int(round(hop_size_from_fps(fps, sample_rate)))
    feature_blocks: list[np.ndarray] = []
    for frame_size, bands in zip(frame_sizes, _bands_per_resolution(frame_sizes, num_bands)):
        filt = compute_filtered_spectrogram(
            waveform,
            frame_size=frame_size,
            hop_size=hop_size,
            sample_rate=sample_rate,
            num_bands=bands,
            fmin=fmin,
            fmax=fmax,
            norm_filters=norm_filters,
            output_scale=output_scale,
        ).spectrogram
        log_spec = logarithmic_spectrogram(filt, mul=mul, add=add, log_fn=log_fn)
        diff = positive_spectral_diff(
            mx.array(log_spec, dtype=mx.float32),
            frame_size=frame_size,
            hop_size=hop_size,
            diff_ratio=diff_ratio,
            time_axis=0,
        )
        mx.eval(diff)
        diff_np = np.asarray(diff, dtype=np.float32)
        if diff_max_bins is not None or not positive_diffs:
            diff_np = positive_spectral_diff_numpy(
                log_spec,
                diff_frames=diff_frames_from_hann(
                    frame_size=frame_size,
                    hop_size=hop_size,
                    diff_ratio=diff_ratio,
                ),
                diff_max_bins=diff_max_bins,
                positive_diffs=positive_diffs,
            )
        feature_blocks.extend(
            (
                np.ascontiguousarray(log_spec, dtype=np.float32),
                np.ascontiguousarray(diff_np, dtype=np.float32),
            )
        )
    return stack_feature_blocks(feature_blocks, layout="feature_stack")


def madmom_multires_log_diff_features_mlx(
    waveform: np.ndarray | mx.array,
    *,
    frame_sizes: tuple[int, ...],
    fps: float,
    num_bands: int | tuple[int, ...],
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    fmin: float = DEFAULT_FMIN,
    fmax: float = DEFAULT_FMAX,
    norm_filters: bool = True,
    output_scale: FilteredOutputScale = "linear",
    log_fn=np.log10,
    mul: float | None = 1.0,
    add: float | None = 1.0,
    diff_ratio: float = 0.5,
    diff_max_bins: int | None = None,
    positive_diffs: bool = True,
) -> mx.array:
    hop_size = int(round(hop_size_from_fps(fps, sample_rate)))
    feature_blocks: list[mx.array] = []
    min_len: int | None = None
    for frame_size, bands in zip(frame_sizes, _bands_per_resolution(frame_sizes, num_bands)):
        filt, _ = compute_filtered_spectrogram_mlx(
            waveform,
            frame_size=frame_size,
            hop_size=hop_size,
            sample_rate=sample_rate,
            num_bands=bands,
            fmin=fmin,
            fmax=fmax,
            norm_filters=norm_filters,
            output_scale=output_scale,
        )
        log_spec = _logarithmic_spectrogram_mlx(filt, mul=mul, add=add, log_fn=log_fn)
        if diff_max_bins is None and positive_diffs:
            diff = positive_spectral_diff(
                log_spec,
                frame_size=frame_size,
                hop_size=hop_size,
                diff_ratio=diff_ratio,
                time_axis=0,
            )
        else:
            diff_np = positive_spectral_diff_numpy(
                np.asarray(log_spec, dtype=np.float32),
                diff_frames=diff_frames_from_hann(
                    frame_size=frame_size,
                    hop_size=hop_size,
                    diff_ratio=diff_ratio,
                ),
                diff_max_bins=diff_max_bins,
                positive_diffs=positive_diffs,
            )
            diff = mx.array(diff_np, dtype=mx.float32)
        min_len = log_spec.shape[0] if min_len is None else min(min_len, int(log_spec.shape[0]))
        feature_blocks.extend((log_spec, diff))
    if min_len is None:
        raise ValueError("madmom_multires_log_diff_features_mlx requires at least one frame size")
    return mx.concatenate([block[:min_len] for block in feature_blocks], axis=1)


def madmom_multires_mel_stack(
    waveform: np.ndarray | mx.array,
    *,
    frame_sizes: tuple[int, ...],
    fps: float,
    num_bands: int,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    fmin: float = DEFAULT_FMIN,
    fmax: float = DEFAULT_FMAX,
    norm_filters: bool = True,
    output_scale: FilteredOutputScale = "linear",
    log_fn=np.log,
    mul: float | None = None,
    add: float | None = np.spacing(1),
    pad_frames: int = 0,
) -> np.ndarray:
    hop_size = int(round(hop_size_from_fps(fps, sample_rate)))
    blocks = []
    for frame_size in frame_sizes:
        filt = compute_mel_spectrogram(
            waveform,
            frame_size=frame_size,
            hop_size=hop_size,
            sample_rate=sample_rate,
            num_bands=num_bands,
            fmin=fmin,
            fmax=fmax,
            norm_filters=norm_filters,
            output_scale=output_scale,
        ).spectrogram
        blocks.append(logarithmic_spectrogram(filt, mul=mul, add=add, log_fn=log_fn))
    stacked = stack_feature_blocks(blocks, layout="channel_stack")
    return repeat_pad_frames(stacked, pad_frames) if pad_frames > 0 else stacked


def madmom_single_resolution_log_stack(
    waveform: np.ndarray | mx.array,
    *,
    frame_size: int,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    num_bands: int,
    fmin: float = DEFAULT_FMIN,
    fmax: float = DEFAULT_FMAX,
    norm_filters: bool = True,
    filterbank: Literal["log", "mel"] = "log",
    fps: float | None = None,
    hop_size: int | None = None,
    output_scale: FilteredOutputScale = "linear",
    log_fn=np.log10,
    mul: float | None = None,
    add: float | None = 1.0,
    pad_frames: int = 0,
    center_tail_pad: CenterTailPad = "minimal",
    backend: Literal["transform", "stft_compat"] = "transform",
) -> np.ndarray:
    if hop_size is None:
        if fps is None:
            raise ValueError("either fps or hop_size must be provided")
        hop_size = int(round(hop_size_from_fps(fps, sample_rate)))
    if backend == "transform":
        if filterbank == "log":
            filt = compute_filtered_spectrogram(
                waveform,
                frame_size=frame_size,
                hop_size=hop_size,
                sample_rate=sample_rate,
                num_bands=num_bands,
                fmin=fmin,
                fmax=fmax,
                norm_filters=norm_filters,
                output_scale=output_scale,
                center_tail_pad=center_tail_pad,
            ).spectrogram
        elif filterbank == "mel":
            filt = compute_mel_spectrogram(
                waveform,
                frame_size=frame_size,
                hop_size=hop_size,
                sample_rate=sample_rate,
                num_bands=num_bands,
                fmin=fmin,
                fmax=fmax,
                norm_filters=norm_filters,
                output_scale=output_scale,
                center_tail_pad=center_tail_pad,
            ).spectrogram
        else:
            raise ValueError(f"Unsupported filterbank: {filterbank}")
    elif backend == "stft_compat":
        if fps is None:
            raise ValueError("fps is required for backend='stft_compat'")
        stft = stft_features_at_fps(
            waveform,
            frame_size=frame_size,
            fps=fps,
            sample_rate=sample_rate,
            origin="offline",
        )
        if filterbank == "log":
            fb = triangular_filterbank(
                stft.bin_frequencies,
                num_bands,
                fmin=fmin,
                fmax=fmax,
                norm_filters=norm_filters,
            )
        elif filterbank == "mel":
            fb = mel_filterbank(
                stft.bin_frequencies,
                num_bands,
                fmin=fmin,
                fmax=fmax,
                norm_filters=norm_filters,
            )
        else:
            raise ValueError(f"Unsupported filterbank: {filterbank}")
        filt = np.ascontiguousarray(stft.magnitude @ fb, dtype=np.float32)
    else:
        raise ValueError(f"Unsupported madmom log-stack backend: {backend}")

    log_spec = logarithmic_spectrogram(filt, mul=mul, add=add, log_fn=log_fn)
    return repeat_pad_frames(log_spec, pad_frames) if pad_frames > 0 else log_spec


def _prepare_waveform_numpy(waveform: np.ndarray | mx.array) -> np.ndarray:
    data = np.asarray(waveform)
    if data.ndim > 1:
        data = data.mean(axis=-1)
    if np.issubdtype(data.dtype, np.integer):
        scale = np.float32(np.iinfo(data.dtype).max)
        data = data.astype(np.float32) / scale
    else:
        data = data.astype(np.float32, copy=False)
    return np.ascontiguousarray(data, dtype=np.float32)


def frame_origin_from_mode(frame_size: int, origin: str | int) -> int:
    if origin in ("center", "offline"):
        return 0
    if origin in ("left", "past", "online"):
        return int((frame_size - 1) / 2)
    if origin in ("right", "future", "stream"):
        return int(-(frame_size / 2))
    return int(origin)


def num_frames_for_hop(
    num_samples: int,
    hop_size: float,
    *,
    end: FramingEnd = "normal",
) -> int:
    if end == "extend":
        return int(np.floor(num_samples / float(hop_size) + 1))
    if end == "normal":
        return int(np.ceil(num_samples / float(hop_size)))
    raise ValueError(f"Unsupported end-of-signal handling: {end}")


def _extract_frames_numpy(
    waveform: np.ndarray,
    *,
    frame_starts: np.ndarray,
    frame_size: int,
) -> np.ndarray:
    num_samples = len(waveform)
    offsets = np.arange(frame_size, dtype=np.int64)
    indices = frame_starts[:, None] + offsets[None, :]
    valid = (indices >= 0) & (indices < num_samples)
    safe = np.clip(indices, 0, num_samples - 1)
    frames = waveform[safe]
    frames[~valid] = 0.0
    return frames.astype(np.float32)


def stft_features_at_fps(
    waveform: np.ndarray | mx.array,
    *,
    frame_size: int,
    fps: float,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    circular_shift: bool = False,
    origin: str | int = "offline",
    end: FramingEnd = "normal",
) -> STFTFeatures:
    waveform_np = _prepare_waveform_numpy(waveform)
    hop_size = hop_size_from_fps(fps, sample_rate)
    origin_value = frame_origin_from_mode(frame_size, origin)
    n_frames = num_frames_for_hop(len(waveform_np), hop_size, end=end)
    ref_samples = (np.arange(n_frames, dtype=np.float64) * hop_size).astype(np.int64)
    frame_starts = ref_samples - (frame_size // 2) - int(origin_value)
    frames = _extract_frames_numpy(
        waveform_np, frame_starts=frame_starts, frame_size=frame_size,
    )
    if circular_shift:
        frames = np.roll(frames, -(frame_size // 2), axis=1)
    window = np.hanning(frame_size).astype(np.float32)
    stft = np.fft.rfft(frames * window[None, :], axis=1).astype(np.complex64)
    stft = stft[:, :-1]
    magnitude = np.abs(stft).astype(np.float32)
    phase = np.angle(stft).astype(np.float32)
    return STFTFeatures(
        stft=stft,
        magnitude=magnitude,
        phase=phase,
        bin_frequencies=(
            np.arange(stft.shape[1], dtype=np.float32) * float(sample_rate) / float(frame_size)
        ),
    )


def diff_frames_from_hann(
    *,
    frame_size: int,
    hop_size: float,
    diff_ratio: float = 0.5,
) -> int:
    frame_size = int(frame_size)
    hop_size = float(hop_size)
    diff_ratio = float(diff_ratio)
    if frame_size <= 0:
        raise ValueError("frame_size must be > 0")
    if hop_size <= 0:
        raise ValueError("hop_size must be > 0")
    if not (0.0 < diff_ratio <= 1.0):
        raise ValueError("diff_ratio must be in (0, 1]")
    window = np.hanning(frame_size)
    sample = int(np.argmax(window > diff_ratio * float(window.max())))
    diff_samples = len(window) / 2 - sample
    return int(max(1, round(diff_samples / hop_size)))


_spectral_diff_numpy = positive_spectral_diff_numpy


def phase_deviation(phase: np.ndarray) -> np.ndarray:
    pd = np.zeros_like(phase, dtype=np.float32)
    pd[2:] = phase[2:] - 2.0 * phase[1:-1] + phase[:-2]
    pd = np.mod(pd + np.pi, 2.0 * np.pi) - np.pi
    return np.mean(np.abs(pd), axis=1).astype(np.float32)


def weighted_phase_deviation(magnitude: np.ndarray, phase: np.ndarray) -> np.ndarray:
    pd = np.zeros_like(phase, dtype=np.float32)
    pd[2:] = phase[2:] - 2.0 * phase[1:-1] + phase[:-2]
    pd = np.mod(pd + np.pi, 2.0 * np.pi) - np.pi
    return np.mean(np.abs(pd) * magnitude, axis=1).astype(np.float32)


def normalized_weighted_phase_deviation(magnitude: np.ndarray, phase: np.ndarray) -> np.ndarray:
    norm = np.mean(magnitude, axis=1) + np.spacing(1)
    return weighted_phase_deviation(magnitude, phase) / norm


def local_group_delay(phase: np.ndarray) -> np.ndarray:
    unwrapped = np.unwrap(phase, axis=1)
    out = unwrapped.copy()
    out[:, :-1] -= out[:, 1:]
    out[:, -1] = 0.0
    return out.astype(np.float32)


def complex_domain_odf(magnitude: np.ndarray, phase: np.ndarray) -> np.ndarray:
    target_phase = np.zeros_like(phase, dtype=np.float32)
    target_phase[1:] = 2.0 * phase[1:] - phase[:-1]
    target = magnitude * np.exp(1j * target_phase)
    current = magnitude * np.exp(1j * phase)
    current[1:] -= target[:-1]
    return np.sum(np.abs(current), axis=1).astype(np.float32)


def rectified_complex_domain_odf(
    magnitude: np.ndarray,
    phase: np.ndarray,
    *,
    diff_frames: int,
) -> np.ndarray:
    target_phase = np.zeros_like(phase, dtype=np.float32)
    target_phase[1:] = 2.0 * phase[1:] - phase[:-1]
    target = magnitude * np.exp(1j * target_phase)
    current = magnitude * np.exp(1j * phase)
    current[1:] -= target[:-1]
    pos_diff = _spectral_diff_numpy(
        magnitude,
        diff_frames=diff_frames,
        positive_diffs=True,
    ).astype(bool)
    current *= pos_diff
    return np.sum(np.abs(current), axis=1).astype(np.float32)


def high_frequency_content_odf(magnitude: np.ndarray) -> np.ndarray:
    return np.mean(magnitude * np.arange(magnitude.shape[1], dtype=np.float32), axis=1).astype(
        np.float32
    )


def spectral_flux_odf(magnitude: np.ndarray, *, diff_frames: int) -> np.ndarray:
    diff = _spectral_diff_numpy(
        magnitude,
        diff_frames=diff_frames,
        positive_diffs=True,
    )
    return np.sum(diff, axis=1).astype(np.float32)


def superflux_odf(
    magnitude: np.ndarray,
    *,
    diff_frames: int,
    diff_max_bins: int = 3,
) -> np.ndarray:
    diff = _spectral_diff_numpy(
        magnitude,
        diff_frames=diff_frames,
        diff_max_bins=diff_max_bins,
        positive_diffs=True,
    )
    return np.sum(diff, axis=1).astype(np.float32)


def modified_kullback_leibler_odf(magnitude: np.ndarray, *, diff_frames: int) -> np.ndarray:
    mkl = np.zeros_like(magnitude, dtype=np.float32)
    mkl[diff_frames:] = magnitude[diff_frames:] / (magnitude[:-diff_frames] + np.spacing(1))
    return np.mean(np.log1p(mkl), axis=1).astype(np.float32)


def _maximum_filter_along_time(x: np.ndarray, size: int, origin: int = 0) -> np.ndarray:
    before = size // 2 + int(origin)
    after = size - 1 - before
    if before < 0 or after < 0:
        raise ValueError(f"invalid maximum-filter origin {origin} for size {size}")
    padded = np.pad(x, ((before, after), (0, 0)), mode="reflect")
    windows = np.lib.stride_tricks.sliding_window_view(padded, size, axis=0)
    return windows.max(axis=-1).astype(np.float32)


def _minimum_filter_along_frequency(x: np.ndarray, size: int) -> np.ndarray:
    before = size // 2
    after = size - 1 - before
    padded = np.pad(x, ((0, 0), (before, after)), mode="reflect")
    windows = np.lib.stride_tricks.sliding_window_view(padded, size, axis=1)
    return windows.min(axis=-1).astype(np.float32)


def complex_flux_odf(
    magnitude: np.ndarray,
    phase: np.ndarray,
    *,
    diff_frames: int,
    diff_max_bins: int = 3,
    temporal_filter: int = 3,
    temporal_origin: int = 0,
    filterbank: np.ndarray | None = None,
) -> np.ndarray:
    lgd = np.abs(local_group_delay(phase)) / np.pi
    if temporal_filter > 0:
        lgd = _maximum_filter_along_time(lgd, temporal_filter, origin=temporal_origin)
    if filterbank is not None:
        mask = np.zeros_like(magnitude, dtype=np.float32)
        num_bins = lgd.shape[1]
        for band in range(mask.shape[1]):
            corner_bins = np.nonzero(filterbank[:, band])[0]
            start = max(0, int(corner_bins[0]) - 1)
            stop = min(num_bins, int(corner_bins[-1]) + 2)
            mask[:, band] = np.amin(lgd[:, start:stop], axis=1)
    else:
        mask = _minimum_filter_along_frequency(lgd, 3)
    diff = _spectral_diff_numpy(
        magnitude,
        diff_frames=diff_frames,
        diff_max_bins=diff_max_bins,
        positive_diffs=True,
    )
    return np.sum(diff * mask, axis=1).astype(np.float32)


def _resolve_spectral_odf_preset(
    preset: Literal["madmom_offline", "madmom_online", "madmom_superflux"] | None,
    *,
    origin: str | int | None,
    end: FramingEnd | None,
) -> tuple[str | int, FramingEnd]:
    if preset is None or preset == "madmom_offline":
        default_origin: str | int = "offline"
        default_end: FramingEnd = "normal"
    elif preset == "madmom_online":
        default_origin = "online"
        default_end = "normal"
    elif preset == "madmom_superflux":
        default_origin = "offline"
        default_end = "normal"
    else:
        raise ValueError(f"Unsupported spectral ODF preset: {preset}")
    return (
        default_origin if origin is None else origin,
        default_end if end is None else end,
    )


def spectral_odf(
    waveform: np.ndarray | mx.array,
    *,
    onset_method: str,
    fps: float = 100.0,
    filterbank: str | None = "log",
    num_bands: int = 12,
    fmin: float = DEFAULT_FMIN,
    fmax: float = DEFAULT_FMAX,
    norm_filters: bool = False,
    log_fn=np.log10,
    mul: float = 1.0,
    add: float = 1.0,
    diff_ratio: float = 0.5,
    diff_max_bins: int | None = None,
    circular_shift: bool | None = None,
    temporal_filter: int = 3,
    temporal_origin: int = 0,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    origin: str | int | None = None,
    end: FramingEnd | None = None,
    preset: Literal["madmom_offline", "madmom_online", "madmom_superflux"] | None = None,
) -> np.ndarray:
    origin_value, end_value = _resolve_spectral_odf_preset(preset, origin=origin, end=end)
    if circular_shift is None:
        circular_shift = any(tag in onset_method for tag in ("phase", "complex"))

    hop_size = hop_size_from_fps(fps, sample_rate)
    # Hardcoded to match madmom's SpectrogramODF default (madmom.audio.spectrogram).
    frame_size = 2048

    if (
        onset_method == "superflux"
        and filterbank == "log"
        and log_fn is np.log10
        and mul == 1.0
        and add == 1.0
        and not circular_shift
    ):
        magnitude = compute_filtered_spectrogram_at_fps(
            waveform,
            frame_size=frame_size,
            fps=fps,
            sample_rate=sample_rate,
            num_bands=num_bands,
            fmin=fmin,
            fmax=fmax,
            norm_filters=norm_filters,
            output_scale="log10_plus_one",
            center_tail_pad="minimal",
            origin=origin_value,
            end=end_value,
        ).spectrogram
        diff_frames = diff_frames_from_hann(
            frame_size=frame_size,
            hop_size=hop_size,
            diff_ratio=diff_ratio,
        )
        return superflux_odf(
            magnitude,
            diff_frames=diff_frames,
            diff_max_bins=diff_max_bins or 3,
        )

    stft = stft_features_at_fps(
        waveform,
        frame_size=frame_size,
        fps=fps,
        sample_rate=sample_rate,
        circular_shift=bool(circular_shift),
        origin=origin_value,
        end=end_value,
    )
    magnitude = stft.magnitude
    applied_filterbank = None
    if filterbank is not None:
        if filterbank == "log":
            applied_filterbank = triangular_filterbank(
                stft.bin_frequencies,
                num_bands,
                fmin=fmin,
                fmax=fmax,
                norm_filters=norm_filters,
            )
        elif filterbank == "mel":
            applied_filterbank = mel_filterbank(
                stft.bin_frequencies,
                num_bands,
                fmin=fmin,
                fmax=fmax,
                norm_filters=norm_filters,
            )
        else:
            raise ValueError(f"Unsupported filterbank: {filterbank}")
        magnitude = magnitude @ applied_filterbank
    if log_fn is not None:
        magnitude = logarithmic_spectrogram(magnitude, mul=mul, add=add, log_fn=log_fn)
    diff_frames = diff_frames_from_hann(
        frame_size=frame_size,
        hop_size=hop_size,
        diff_ratio=diff_ratio,
    )

    if onset_method == "high_frequency_content":
        return high_frequency_content_odf(magnitude)
    if onset_method == "spectral_diff":
        diff = _spectral_diff_numpy(
            magnitude,
            diff_frames=diff_frames,
            positive_diffs=True,
        )
        return np.sum(diff**2, axis=1).astype(np.float32)
    if onset_method == "spectral_flux":
        return spectral_flux_odf(magnitude, diff_frames=diff_frames)
    if onset_method == "superflux":
        return superflux_odf(
            magnitude,
            diff_frames=diff_frames,
            diff_max_bins=diff_max_bins or 3,
        )
    if onset_method == "complex_flux":
        return complex_flux_odf(
            magnitude,
            stft.phase,
            diff_frames=diff_frames,
            diff_max_bins=diff_max_bins or 3,
            temporal_filter=temporal_filter,
            temporal_origin=temporal_origin,
            filterbank=applied_filterbank,
        )
    if onset_method == "modified_kullback_leibler":
        return modified_kullback_leibler_odf(magnitude, diff_frames=diff_frames)
    if onset_method == "phase_deviation":
        return phase_deviation(stft.phase)
    if onset_method == "weighted_phase_deviation":
        return weighted_phase_deviation(magnitude, stft.phase)
    if onset_method == "normalized_weighted_phase_deviation":
        return normalized_weighted_phase_deviation(magnitude, stft.phase).astype(np.float32)
    if onset_method == "complex_domain":
        if filterbank is not None:
            raise ValueError("complex-domain methods require unfiltered spectrograms")
        return complex_domain_odf(magnitude, stft.phase)
    if onset_method == "rectified_complex_domain":
        if filterbank is not None:
            raise ValueError("complex-domain methods require unfiltered spectrograms")
        return rectified_complex_domain_odf(magnitude, stft.phase, diff_frames=diff_frames)
    raise ValueError(f"Unsupported onset method: {onset_method}")


def positive_spectral_diff(
    x: mx.array,
    *,
    lag: int | None = None,
    frame_size: int | None = None,
    hop_size: int | None = None,
    diff_ratio: float = 0.5,
    time_axis: int = -1,
) -> mx.array:
    """Half-wave rectified spectral difference over the frame axis."""
    if x.ndim < 2:
        raise ValueError(f"positive_spectral_diff expects at least 2 dims, got {x.shape}")
    if lag is not None and (frame_size is not None or hop_size is not None):
        raise ValueError("pass either lag or frame_size/hop_size, not both")
    if lag is None:
        if frame_size is None or hop_size is None:
            lag = 1
        else:
            lag = diff_frames_from_hann(
                frame_size=int(frame_size),
                hop_size=hop_size,
                diff_ratio=diff_ratio,
            )
    lag = int(lag)
    if lag <= 0:
        raise ValueError("lag must be > 0")
    axis = int(time_axis)
    axis = axis if axis >= 0 else x.ndim + axis
    if axis < 0 or axis >= x.ndim:
        raise ValueError(f"time_axis {time_axis} is out of bounds for shape {x.shape}")
    moved = mx.moveaxis(x, axis, -1)
    diff = mx.zeros_like(moved)
    diff[..., lag:] = moved[..., lag:] - moved[..., :-lag]
    diff = mx.maximum(diff, 0.0).astype(mx.float32)
    return mx.moveaxis(diff, -1, axis)


def _resolve_sample_rate(sr, sample_rate, *, default):
    """Accept either spelling of the sample-rate keyword.

    The CQT entry points mirror librosa, which spells it `sr`, while every
    transform class in this package spells it `sample_rate`. Callers should not
    have to remember which side of that line a given function sits on.
    """
    if sample_rate is not None and sr is not None and int(sample_rate) != int(sr):
        raise TypeError(
            f"got conflicting sample rates: sr={sr}, sample_rate={sample_rate}"
        )
    if sample_rate is not None:
        return int(sample_rate)
    if sr is not None:
        return int(sr)
    return default


class HybridCQTTransform:
    """Hybrid CQT built from cached CQT bases plus shared STFT transforms."""

    __slots__ = (
        "sr",
        "hop_length",
        "fmin",
        "n_bins",
        "bins_per_octave",
        "filter_scale",
        "norm",
        "sparsity",
        "n_pseudo",
        "n_full",
        "n_octaves",
        "_pseudo_basis",
        "_pseudo_scale",
        "_pseudo_stft",
        "_pseudo_short_stft",
        "_octave_bases",
        "_octave_stfts",
        "_octave_short_stfts",
        "_scale_factors",
        "_compiled_fn",
    )

    def __init__(
        self,
        *,
        sr: int | None = None,
        hop_length: int = 512,
        fmin: float = 32.70319566257483,
        n_bins: int = 84,
        bins_per_octave: int = 12,
        filter_scale: float = 1.0,
        norm: float = 1.0,
        sparsity: float = 0.01,
        sample_rate: int | None = None,
    ) -> None:
        self.sr = _resolve_sample_rate(sr, sample_rate, default=22_050)
        self.hop_length = int(hop_length)
        self.fmin = float(fmin)
        self.n_bins = int(n_bins)
        self.bins_per_octave = int(bins_per_octave)
        self.filter_scale = float(filter_scale)
        self.norm = float(norm)
        self.sparsity = float(sparsity)
        if self.sr <= 0:
            raise ValueError("sr must be > 0")
        if self.hop_length <= 0:
            raise ValueError("hop_length must be > 0")
        if self.fmin <= 0.0:
            raise ValueError("fmin must be > 0")
        if self.n_bins <= 0:
            raise ValueError("n_bins must be > 0")
        if self.bins_per_octave <= 0:
            raise ValueError("bins_per_octave must be > 0")
        if self.filter_scale <= 0.0:
            raise ValueError("filter_scale must be > 0")
        if self.norm <= 0.0:
            raise ValueError("norm must be > 0")
        if not 0.0 <= self.sparsity < 1.0:
            raise ValueError("sparsity must lie in [0, 1)")

        plan = _cached_hybrid_cqt_plan(
            self.sr,
            self.hop_length,
            self.fmin,
            self.n_bins,
            self.bins_per_octave,
            self.filter_scale,
            self.norm,
            self.sparsity,
        )
        self.n_pseudo = int(plan["n_pseudo"])
        self.n_full = int(plan["n_full"])
        self.n_octaves = int(plan["n_octaves"])
        self._scale_factors = plan["scale_factors"]

        pseudo_plan = plan["pseudo"]
        if pseudo_plan is None:
            self._pseudo_basis = None
            self._pseudo_scale = None
            self._pseudo_stft = None
            self._pseudo_short_stft = None
        else:
            pseudo_nfft = int(pseudo_plan["n_fft"])
            self._pseudo_basis = pseudo_plan["basis"]
            self._pseudo_scale = float(pseudo_plan["scale"])
            self._pseudo_stft = get_transform_mlx(
                n_fft=pseudo_nfft,
                hop_length=self.hop_length,
                win_length=pseudo_nfft,
                window_fn="hann",
                periodic=True,
                center=True,
                normalized=False,
                window=None,
                center_pad_mode="reflect",
                center_tail_pad="symmetric",
                istft_backend_policy=None,
            )
            self._pseudo_short_stft = get_transform_mlx(
                n_fft=pseudo_nfft,
                hop_length=self.hop_length,
                win_length=pseudo_nfft,
                window_fn="hann",
                periodic=True,
                center=True,
                normalized=False,
                window=None,
                center_pad_mode="constant",
                center_tail_pad="symmetric",
                istft_backend_policy=None,
            )

        octave_bases: list[mx.array] = []
        octave_stfts: list[SpectralTransform] = []
        octave_short_stfts: list[SpectralTransform] = []
        for basis, octave_nfft, octave_hop in plan["octaves"]:
            octave_bases.append(basis)
            octave_stfts.append(
                get_transform_mlx(
                    n_fft=int(octave_nfft),
                    hop_length=int(octave_hop),
                    win_length=int(octave_nfft),
                    window_fn="hann",
                    periodic=True,
                    center=True,
                    normalized=False,
                    window=None,
                    center_pad_mode="reflect",
                    center_tail_pad="symmetric",
                    istft_backend_policy=None,
                )
            )
            octave_short_stfts.append(
                get_transform_mlx(
                    n_fft=int(octave_nfft),
                    hop_length=int(octave_hop),
                    win_length=int(octave_nfft),
                    window_fn="hann",
                    periodic=True,
                    center=True,
                    normalized=False,
                    window=None,
                    center_pad_mode="constant",
                    center_tail_pad="symmetric",
                    istft_backend_policy=None,
                )
            )
        self._octave_bases = tuple(octave_bases)
        self._octave_stfts = tuple(octave_stfts)
        self._octave_short_stfts = tuple(octave_short_stfts)
        self._compiled_fn = None

    def hybrid_cqt(self, x: mx.array) -> mx.array:
        x_b, squeezed = _ensure_audio_batch(x, fn_name="hybrid_cqt")
        results: list[mx.array] = []

        if self.n_full > 0:
            octave_results: list[mx.array] = []
            octave_audio = x_b
            for idx, stft in enumerate(self._octave_stfts):
                current_stft = self._octave_short_stfts[idx]
                if int(octave_audio.shape[1]) > (int(stft.n_fft) // 2):
                    current_stft = stft
                spec = current_stft.stft(octave_audio, output_layout="bfn")
                cqt_oct = mx.abs(mx.matmul(self._octave_bases[idx][None, :, :], spec)).astype(mx.float32)
                octave_results.append(cqt_oct)
                if idx < len(self._octave_stfts) - 1:
                    octave_audio = _downsample_2x_batched(octave_audio)
            min_frames = min(int(o.shape[2]) for o in octave_results)
            trimmed = [o[:, :, :min_frames] for o in octave_results]
            trimmed.reverse()
            results.append(mx.concatenate(trimmed, axis=1))

        if self.n_pseudo > 0:
            assert self._pseudo_basis is not None
            assert self._pseudo_scale is not None
            assert self._pseudo_stft is not None
            pseudo_stft = self._pseudo_short_stft
            if int(x_b.shape[1]) > (int(self._pseudo_stft.n_fft) // 2):
                pseudo_stft = self._pseudo_stft
            assert pseudo_stft is not None
            spec_mag = mx.abs(pseudo_stft.stft(x_b, output_layout="bfn")).astype(mx.float32)
            pseudo_cqt = (
                mx.matmul(self._pseudo_basis[None, :, :], spec_mag) / float(self._pseudo_scale)
            ).astype(mx.float32)
            results.append(pseudo_cqt)

        if not results:
            raise RuntimeError("HybridCQTTransform produced no octave results")
        cqt = mx.concatenate(results, axis=1)
        cqt = (cqt * self._scale_factors[None, :, None]).astype(mx.float32)
        return _restore_feature_batch(cqt, squeezed=squeezed)

    def __call__(self, x: mx.array) -> mx.array:
        return self.hybrid_cqt(x)

    def get_compiled(self):
        """Return a cached compiled hybrid-CQT callable for steady-shape loops."""
        cached = self._compiled_fn
        if cached is not None:
            return cached

        @mx.compile
        def _compiled(x: mx.array) -> mx.array:
            return self.hybrid_cqt(x)

        self._compiled_fn = _compiled
        return _compiled


@lru_cache(maxsize=64)
def _cached_hybrid_cqt_transform(
    sr: int,
    hop_length: int,
    fmin: float,
    n_bins: int,
    bins_per_octave: int,
    filter_scale: float,
    norm: float,
    sparsity: float,
) -> HybridCQTTransform:
    return HybridCQTTransform(
        sr=int(sr),
        hop_length=int(hop_length),
        fmin=float(fmin),
        n_bins=int(n_bins),
        bins_per_octave=int(bins_per_octave),
        filter_scale=float(filter_scale),
        norm=float(norm),
        sparsity=float(sparsity),
    )


def hybrid_cqt(
    x: mx.array,
    *,
    sr: int | None = None,
    hop_length: int = 512,
    fmin: float = 32.70319566257483,
    n_bins: int = 84,
    bins_per_octave: int = 12,
    filter_scale: float = 1.0,
    norm: float = 1.0,
    sparsity: float = 0.01,
    sample_rate: int | None = None,
) -> mx.array:
    """Compute a hybrid CQT magnitude spectrogram from audio.

    `sr` and `sample_rate` are accepted interchangeably.
    """
    transform = _cached_hybrid_cqt_transform(
        _resolve_sample_rate(sr, sample_rate, default=22_050),
        int(hop_length),
        float(fmin),
        int(n_bins),
        int(bins_per_octave),
        float(filter_scale),
        float(norm),
        float(sparsity),
    )
    return transform(x)


class MFCCTransform:
    """MFCC frontend built on top of :class:`MelSpectrogramTransform`."""

    __slots__ = (
        "sample_rate",
        "n_mfcc",
        "n_fft",
        "hop_length",
        "win_length",
        "n_mels",
        "f_min",
        "f_max",
        "norm",
        "mel_scale",
        "top_db",
        "window_fn",
        "center",
        "center_pad_mode",
        "center_tail_pad",
        "lifter",
        "dct_norm",
        "mel_transform",
        "dct_mat",
        "_dct_mat_t",
        "_lifter_weights",
        "_compiled_fn",
    )

    def __init__(
        self,
        *,
        sample_rate: int = 22_050,
        n_mfcc: int = 20,
        n_fft: int = 2_048,
        hop_length: int = 512,
        win_length: Optional[int] = None,
        n_mels: int = 128,
        f_min: float = 0.0,
        f_max: Optional[float] = None,
        norm: MelNorm = "slaney",
        mel_scale: MelScale = "slaney",
        top_db: Optional[float] = 80.0,
        window_fn: str = "hann",
        center: bool = True,
        center_pad_mode: CenterPadMode = "reflect",
        center_tail_pad: CenterTailPad = "symmetric",
        lifter: int = 0,
        dct_norm: Literal["ortho"] | None = "ortho",
    ) -> None:
        self.sample_rate = int(sample_rate)
        self.n_mfcc = int(n_mfcc)
        self.n_fft = int(n_fft)
        self.hop_length = int(hop_length)
        self.win_length = int(win_length) if win_length is not None else int(n_fft)
        self.n_mels = int(n_mels)
        self.f_min = float(f_min)
        self.f_max = float(self.sample_rate // 2 if f_max is None else f_max)
        self.norm = norm
        self.mel_scale = mel_scale
        self.top_db = top_db
        self.window_fn = str(window_fn)
        self.center = bool(center)
        self.center_pad_mode = center_pad_mode
        self.center_tail_pad = center_tail_pad
        self.lifter = int(lifter)
        self.dct_norm = dct_norm

        if self.n_mfcc <= 0:
            raise ValueError("n_mfcc must be > 0")
        if self.n_mels <= 0:
            raise ValueError("n_mels must be > 0")
        if self.n_mfcc > self.n_mels:
            raise ValueError("n_mfcc must be <= n_mels")
        if self.lifter < 0:
            raise ValueError("lifter must be >= 0")
        if self.dct_norm not in (None, "ortho"):
            raise ValueError('dct_norm must be one of {None, "ortho"}')

        self.mel_transform = MelSpectrogramTransform(
            sample_rate=self.sample_rate,
            n_fft=self.n_fft,
            hop_length=self.hop_length,
            win_length=self.win_length,
            n_mels=self.n_mels,
            f_min=self.f_min,
            f_max=self.f_max,
            power=2.0,
            norm=self.norm,
            mel_scale=self.mel_scale,
            top_db=self.top_db,
            mode="mlx_native",
            window_fn=self.window_fn,
            periodic=True,
            center=self.center,
            center_pad_mode=self.center_pad_mode,
            center_tail_pad=self.center_tail_pad,
            normalized=False,
        )
        self.dct_mat = _cached_dct_matrix(self.n_mfcc, self.n_mels, self.dct_norm)
        self._dct_mat_t = _cached_dct_matrix_t(self.n_mfcc, self.n_mels, self.dct_norm)
        if self.lifter > 0:
            self._lifter_weights = _cached_lifter_weights(self.n_mfcc, self.lifter)
        else:
            self._lifter_weights = None
        self._compiled_fn = None

    def mfcc(self, x: mx.array) -> mx.array:
        """Compute MFCCs, returning ``[B, n_mfcc, frames]`` or ``[n_mfcc, frames]``."""
        squeezed = x.ndim == 1
        if squeezed:
            x = x[None, :]
        elif x.ndim != 2:
            raise ValueError(f"mfcc expects 1D or 2D input, got {x.shape}")

        mel_bmn = self.mel_transform.mel_spectrogram(x, to_db=True)
        mfcc_bmn = _apply_mfcc_projection(
            mel_bmn,
            dct_mat_t=self._dct_mat_t,
            lifter_weights=self._lifter_weights,
        )
        if squeezed:
            mfcc_bmn = mfcc_bmn.squeeze(0)
        return mfcc_bmn

    def __call__(self, x: mx.array) -> mx.array:
        return self.mfcc(x)

    def get_compiled(self):
        """Return a cached compiled MFCC callable for fixed-shape hot loops."""
        cached = self._compiled_fn
        if cached is not None:
            return cached

        @mx.compile
        def _compiled(x: mx.array) -> mx.array:
            return self.mfcc(x)

        self._compiled_fn = _compiled
        return _compiled


def mfcc(
    x: mx.array,
    *,
    sample_rate: int = 22_050,
    n_mfcc: int = 20,
    n_fft: int = 2_048,
    hop_length: int = 512,
    win_length: Optional[int] = None,
    n_mels: int = 128,
    f_min: float = 0.0,
    f_max: Optional[float] = None,
    norm: MelNorm = "slaney",
    mel_scale: MelScale = "slaney",
    top_db: Optional[float] = 80.0,
    window_fn: str = "hann",
    center: bool = True,
    center_pad_mode: CenterPadMode = "reflect",
    center_tail_pad: CenterTailPad = "symmetric",
    lifter: int = 0,
    dct_norm: Literal["ortho"] | None = "ortho",
) -> mx.array:
    """Compute MFCCs from raw audio.

    Returns ``[n_mfcc, frames]`` for 1-D input or ``[B, n_mfcc, frames]`` for
    batched input.
    """
    transform = MFCCTransform(
        sample_rate=sample_rate,
        n_mfcc=n_mfcc,
        n_fft=n_fft,
        hop_length=hop_length,
        win_length=win_length,
        n_mels=n_mels,
        f_min=f_min,
        f_max=f_max,
        norm=norm,
        mel_scale=mel_scale,
        top_db=top_db,
        window_fn=window_fn,
        center=center,
        center_pad_mode=center_pad_mode,
        center_tail_pad=center_tail_pad,
        lifter=lifter,
        dct_norm=dct_norm,
    )
    return transform(x)


# ==============================================================================
# Spectral Feature Descriptors
# ==============================================================================

_SPECTRAL_FEATURE_NAMES = (
    "chroma_stft",
    "spectral_centroid",
    "spectral_bandwidth",
    "spectral_rolloff",
    "spectral_contrast",
    "mfcc",
)


@lru_cache(maxsize=128)
def _cached_chroma_filterbank(
    sample_rate: int,
    n_fft: int,
    n_chroma: int,
    tuning: float,
) -> mx.array:
    return _chroma_filterbank(
        sample_rate=int(sample_rate),
        n_fft=int(n_fft),
        n_chroma=int(n_chroma),
        tuning=float(tuning),
    )


def _ensure_audio_batch(x: mx.array, *, fn_name: str) -> tuple[mx.array, bool]:
    if x.ndim == 1:
        return x[None, :], True
    if x.ndim != 2:
        raise ValueError(f"{fn_name} expects 1D or 2D input, got {x.shape}")
    return x, False


def hop_size_from_fps(fps: float, sample_rate: int = 44_100) -> float:
    return float(sample_rate) / float(fps)


def fft_frequencies(num_fft_bins: int, sample_rate: int) -> np.ndarray:
    """Centre frequency of each rfft bin, madmom argument order.

    Note the two differences from ``librosa.fft_frequencies(sr=, n_fft=)``:
    the arguments are in the opposite order, and the first one is the **number
    of bins** (``n_fft // 2 + 1``), not ``n_fft``. This matches madmom, and
    :func:`mel_filterbank` and the filtered-spectrogram helpers expect it.
    """
    # Catch `fft_frequencies(sr, n_fft)` written from librosa habit. Left alone
    # it returns a plausible-looking array of entirely the wrong length, which
    # then flows silently into a filterbank of the wrong shape -- no exception,
    # just wrong numbers. The tell is that FFT sizes are powers of two and
    # audio sample rates essentially never are.
    looks_swapped = sample_rate < 1000 or (
        num_fft_bins >= 4000
        and 0 < sample_rate <= 65536
        and sample_rate & (sample_rate - 1) == 0
    )
    if looks_swapped:
        raise ValueError(
            f"fft_frequencies(num_fft_bins={num_fft_bins}, "
            f"sample_rate={sample_rate}): the arguments look swapped. This "
            "takes (num_fft_bins, sample_rate) -- the opposite order from "
            "librosa, and a bin count rather than n_fft. For n_fft="
            f"{sample_rate} at {num_fft_bins} Hz, call "
            f"fft_frequencies({sample_rate // 2 + 1}, {num_fft_bins})."
        )
    return np.fft.rfftfreq((num_fft_bins - 1) * 2, d=1.0 / sample_rate).astype(np.float32)


def log_frequencies(
    bands_per_octave: int,
    fmin: float,
    fmax: float,
    fref: float = DEFAULT_FREF,
) -> np.ndarray:
    left = np.floor(np.log2(float(fmin) / fref) * bands_per_octave)
    right = np.ceil(np.log2(float(fmax) / fref) * bands_per_octave)
    freqs = fref * 2.0 ** (np.arange(left, right) / float(bands_per_octave))
    freqs = freqs[np.searchsorted(freqs, fmin) :]
    freqs = freqs[: np.searchsorted(freqs, fmax, side="right")]
    return freqs.astype(np.float32)


def frequencies_to_bins(
    frequencies: np.ndarray,
    bin_frequencies: np.ndarray,
    *,
    unique_bins: bool = True,
) -> np.ndarray:
    indices = np.searchsorted(bin_frequencies, frequencies)
    indices = np.clip(indices, 1, len(bin_frequencies) - 1)
    left = bin_frequencies[indices - 1]
    right = bin_frequencies[indices]
    indices -= frequencies - left < right - frequencies
    if unique_bins:
        indices = np.unique(indices)
    return indices.astype(np.int64)


def _triangular_filterbank_from_bins(
    bins: np.ndarray,
    num_bins: int,
    *,
    norm_filters: bool,
) -> np.ndarray:
    filters: list[np.ndarray] = []
    for start, center, stop in zip(bins[:-2], bins[1:-1], bins[2:]):
        start_i = int(start)
        center_i = int(center)
        stop_i = int(stop)
        if stop_i - start_i < 2:
            center_i = start_i
            stop_i = start_i + 1
        filt = np.zeros(num_bins, dtype=np.float32)
        if center_i > start_i:
            filt[start_i:center_i] = np.linspace(
                0.0,
                1.0,
                center_i - start_i,
                endpoint=False,
            )
        filt[center_i:stop_i] = np.linspace(
            1.0,
            0.0,
            stop_i - center_i,
            endpoint=False,
        )
        if norm_filters:
            total = filt.sum()
            if total > 0:
                filt /= total
        filters.append(filt)
    return np.stack(filters, axis=1)


def triangular_filterbank(
    bin_frequencies: np.ndarray,
    num_bands: int,
    *,
    fmin: float = DEFAULT_FMIN,
    fmax: float = DEFAULT_FMAX,
    fref: float = DEFAULT_FREF,
    norm_filters: bool = True,
) -> np.ndarray:
    centers = log_frequencies(num_bands, fmin, fmax, fref=fref)
    bins = frequencies_to_bins(centers, bin_frequencies, unique_bins=True)
    return _triangular_filterbank_from_bins(
        bins,
        len(bin_frequencies),
        norm_filters=norm_filters,
    )


def mel_filterbank(
    bin_frequencies: np.ndarray,
    num_bands: int,
    *,
    fmin: float,
    fmax: float,
    norm_filters: bool = True,
) -> np.ndarray:
    mel_edges = np.linspace(
        _hz_to_mel(np.array([fmin]))[0],
        _hz_to_mel(np.array([fmax]))[0],
        num_bands + 2,
    )
    hz_edges = _mel_to_hz(mel_edges)
    bins = frequencies_to_bins(hz_edges, bin_frequencies, unique_bins=False)
    return _triangular_filterbank_from_bins(
        bins,
        len(bin_frequencies),
        norm_filters=norm_filters,
    )


def mel_filterbank_librosa(
    sr: int,
    n_fft: int,
    n_mels: int,
    *,
    fmin: float = 0.0,
    fmax: float | None = None,
    htk: bool = False,
    norm: str | None = "slaney",
) -> np.ndarray:
    """Mel filterbank matching librosa.filters.mel exactly.

    Every default here matches ``librosa.filters.mel``, so passing defaults on
    both sides gives the same filterbank (verified to 1e-9). Uses continuous
    frequency interpolation (not bin-aligned) and supports ``norm='slaney'``
    (divide by bandwidth), librosa's default. Returns ``[n_fft//2+1, n_mels]``,
    transposed from librosa's ``[n_mels, n_fft//2+1]``, to match this package's
    convention.

    Not interchangeable with :func:`mel_filterbank`, which follows madmom:
    area-normalized triangles peaking at 1.0 against these Slaney-normalized
    ones peaking near 0.01, a difference of roughly 80x -- about 19 dB -- in
    everything downstream. Pick the one matching the implementation you are
    reproducing.

    Reference: librosa.filters.mel
    """
    if fmax is None:
        fmax = float(sr) / 2.0

    if htk:

        def hz2mel(f):
            return 2595.0 * np.log10(1.0 + np.asarray(f, dtype=np.float64) / 700.0)

        def mel2hz(m):
            return 700.0 * (10.0 ** (np.asarray(m, dtype=np.float64) / 2595.0) - 1.0)

    else:

        def hz2mel(f):
            return _hz_to_mel(np.asarray(f, dtype=np.float64), mel_scale="slaney")

        def mel2hz(m):
            return _mel_to_hz(np.asarray(m, dtype=np.float64), mel_scale="slaney")

    mel_f = mel2hz(np.linspace(hz2mel(fmin), hz2mel(fmax), n_mels + 2))
    fft_freqs = np.fft.rfftfreq(n_fft, d=1.0 / sr)

    fdiff = np.diff(mel_f)
    ramps = np.subtract.outer(mel_f, fft_freqs)

    weights = np.zeros((n_mels, len(fft_freqs)), dtype=np.float64)
    for i in range(n_mels):
        lower = -ramps[i] / fdiff[i]
        upper = ramps[i + 2] / fdiff[i + 1]
        weights[i] = np.maximum(0.0, np.minimum(lower, upper))

    if norm == "slaney":
        enorm = 2.0 / (mel_f[2 : n_mels + 2] - mel_f[:n_mels])
        weights *= enorm[:, np.newaxis]

    return weights.astype(np.float32).T  # [n_fft//2+1, n_mels]


def rectangular_filterbank(
    bin_frequencies: np.ndarray,
    crossover_frequencies: tuple[float, ...] | list[float],
    *,
    fmin: float = DEFAULT_FMIN,
    fmax: float = DEFAULT_FMAX,
    norm_filters: bool = True,
    unique_filters: bool = True,
) -> np.ndarray:
    corner_frequencies = np.r_[fmin, np.asarray(crossover_frequencies), fmax]
    corner_bins = frequencies_to_bins(
        corner_frequencies,
        bin_frequencies,
        unique_bins=unique_filters,
    )
    filterbank = np.zeros((len(bin_frequencies), len(corner_bins) - 1), dtype=np.float32)
    for index in range(len(corner_bins) - 1):
        filterbank[corner_bins[index] : corner_bins[index + 1], index] = 1.0
    if norm_filters:
        band_sum = np.sum(filterbank, axis=0)
        band_sum[band_sum == 0] = 1.0
        filterbank /= band_sum
    return filterbank


def logarithmic_spectrogram(
    spec: np.ndarray,
    *,
    mul: float = 1.0,
    add: float = 1.0,
    log_fn=np.log10,
) -> np.ndarray:
    out = np.asarray(spec, dtype=np.float32).copy()
    if mul is not None:
        out *= np.float32(mul)
    if add is not None:
        out += np.float32(add)
    if log_fn is not None:
        out = log_fn(out).astype(np.float32)
    return out


def frame_starts_from_fps(
    num_samples: int,
    *,
    frame_size: int,
    fps: float,
    sample_rate: int = 44_100,
    origin: str | int = "offline",
    end: FramingEnd = "normal",
) -> np.ndarray:
    hop_size = hop_size_from_fps(fps, sample_rate)
    origin_value = frame_origin_from_mode(frame_size, origin)
    num_frames = num_frames_for_hop(num_samples, hop_size, end=end)
    reference_samples = (
        np.arange(num_frames, dtype=np.float64) * float(hop_size)
    ).astype(np.int64)
    frame_starts = reference_samples - (frame_size // 2) - int(origin_value)
    return np.ascontiguousarray(frame_starts, dtype=np.int32)


def _extract_windowed_frames_at_starts(
    x_b: mx.array,
    *,
    frame_starts: mx.array,
    frame_length: int,
    window: mx.array,
) -> mx.array:
    if frame_starts.ndim != 1:
        raise ValueError(f"frame_starts must be rank-1 [n_frames], got {frame_starts.shape}")
    if frame_length <= 0:
        raise ValueError("frame_length must be > 0")
    bsz, signal_length = x_b.shape
    num_frames = int(frame_starts.shape[0])
    if signal_length == 0:
        frames = mx.zeros((bsz, num_frames, frame_length), dtype=x_b.dtype)
        return frames * window.reshape(1, 1, frame_length)

    offsets = mx.arange(frame_length, dtype=mx.int32)[None, :]
    indices = frame_starts[:, None] + offsets
    valid = (indices >= 0) & (indices < signal_length)
    safe_indices = mx.clip(indices, 0, signal_length - 1)
    gathered = mx.take(x_b, safe_indices.reshape(-1), axis=1).reshape(
        bsz,
        num_frames,
        frame_length,
    )
    masked = gathered * valid[None, :, :].astype(x_b.dtype)
    return masked * window.reshape(1, 1, frame_length)


def _restore_feature_batch(x: mx.array, *, squeezed: bool) -> mx.array:
    return x[0] if squeezed else x


def _fft_frequencies(sample_rate: int, n_fft: int) -> mx.array:
    sample_rate = int(sample_rate)
    n_fft = int(n_fft)
    if sample_rate <= 0:
        raise ValueError("sample_rate must be > 0")
    if n_fft <= 0:
        raise ValueError("n_fft must be > 0")
    freqs = np.fft.rfftfreq(n=n_fft, d=1.0 / float(sample_rate)).astype(np.float32)
    return mx.array(freqs, dtype=mx.float32)


def _fft_bin_frequencies(
    sample_rate: int,
    n_freqs: int,
    *,
    include_nyquist: bool,
) -> np.ndarray:
    sample_rate = int(sample_rate)
    n_freqs = int(n_freqs)
    if sample_rate <= 0:
        raise ValueError("sample_rate must be > 0")
    if n_freqs <= 1:
        raise ValueError("n_freqs must be > 1")
    if include_nyquist:
        n_fft = (n_freqs - 1) * 2
        return np.fft.rfftfreq(n=n_fft, d=1.0 / float(sample_rate)).astype(np.float32)
    n_fft = n_freqs * 2
    return np.fft.fftfreq(n_fft, d=1.0 / float(sample_rate))[:n_freqs].astype(np.float32)


def log_triangular_fbanks(
    n_freqs: int,
    sample_rate: int,
    bands_per_octave: int,
    *,
    f_min: float,
    f_max: float,
    f_ref: float | None = 440.0,
    norm_filters: bool = True,
    unique_bins: bool = True,
    include_nyquist: bool = False,
) -> mx.array:
    n_freqs = int(n_freqs)
    sample_rate = int(sample_rate)
    bands_per_octave = int(bands_per_octave)
    f_min = float(f_min)
    f_max = float(f_max)
    if sample_rate <= 0:
        raise ValueError("sample_rate must be > 0")
    if n_freqs <= 1:
        raise ValueError("n_freqs must be > 1")
    if bands_per_octave <= 0:
        raise ValueError("bands_per_octave must be > 0")
    if f_min <= 0.0:
        raise ValueError("f_min must be > 0")
    if f_max <= f_min:
        raise ValueError("f_max must be > f_min")
    if f_ref is not None:
        f_ref = float(f_ref)
        if f_ref <= 0.0:
            raise ValueError("f_ref must be > 0")

    bin_frequencies = _fft_bin_frequencies(
        sample_rate,
        n_freqs,
        include_nyquist=bool(include_nyquist),
    )
    if f_ref is None:
        num_octaves = np.log2(f_max / f_min)
        num_bands = int(np.round(bands_per_octave * num_octaves))
        centers = f_min * 2.0 ** (np.arange(num_bands + 2) / float(bands_per_octave))
    else:
        left = np.floor(np.log2(f_min / f_ref) * bands_per_octave)
        right = np.ceil(np.log2(f_max / f_ref) * bands_per_octave)
        centers = f_ref * 2.0 ** (np.arange(left, right) / float(bands_per_octave))
        centers = centers[np.searchsorted(centers, f_min):]
        centers = centers[: np.searchsorted(centers, f_max, side="right")]
    if centers.size < 3:
        raise ValueError("log_triangular_fbanks requires at least three center frequencies")

    indices = bin_frequencies.searchsorted(centers)
    indices = np.clip(indices, 1, len(bin_frequencies) - 1)
    left_bins = bin_frequencies[indices - 1]
    right_bins = bin_frequencies[indices]
    indices -= centers - left_bins < right_bins - centers
    if unique_bins:
        indices = np.unique(indices)
    if indices.size < 3:
        raise ValueError("not enough distinct FFT bins to build log triangular filterbank")

    filters: list[np.ndarray] = []
    for start, center, stop in zip(indices[:-2], indices[1:-1], indices[2:]):
        start_i = int(start)
        center_i = int(center)
        stop_i = int(stop)
        if stop_i - start_i < 2:
            center_i = start_i
            stop_i = start_i + 1
        center_rel = center_i - start_i
        stop_rel = stop_i - start_i
        filt = np.zeros(stop_rel, dtype=np.float32)
        if center_rel > 0:
            filt[:center_rel] = np.linspace(0.0, 1.0, center_rel, endpoint=False)
        filt[center_rel:] = np.linspace(1.0, 0.0, stop_rel - center_rel, endpoint=False)
        if norm_filters:
            total = float(np.sum(filt))
            if total > 0.0:
                filt /= total
        band = np.zeros(n_freqs, dtype=np.float32)
        band[start_i:stop_i] = filt
        filters.append(band)
    if not filters:
        raise ValueError("log_triangular_fbanks produced no filters")
    return mx.array(np.stack(filters, axis=1), dtype=mx.float32)


@lru_cache(maxsize=128)
def _cached_fft_frequencies(sample_rate: int, n_fft: int) -> mx.array:
    return _fft_frequencies(int(sample_rate), int(n_fft))


@lru_cache(maxsize=128)
def _cached_spectral_contrast_bands(
    sample_rate: int,
    n_fft: int,
    n_bands: int,
    fmin: float,
) -> tuple[tuple[int, int], ...]:
    freq_np = np.linspace(0.0, float(sample_rate) / 2.0, int(n_fft // 2 + 1), dtype=np.float32)
    octa = np.zeros(int(n_bands) + 2, dtype=np.float32)
    octa[1:] = float(fmin) * (2.0 ** np.arange(0, int(n_bands) + 1))
    if np.any(octa[:-1] >= 0.5 * float(sample_rate)):
        raise ValueError("Frequency band exceeds Nyquist. Reduce either fmin or n_bands.")

    bands: list[tuple[int, int]] = []
    for k, (f_low, f_high) in enumerate(zip(octa[:-1], octa[1:])):
        start = int(np.searchsorted(freq_np, f_low, side="left"))
        end = int(np.searchsorted(freq_np, f_high, side="right"))
        if end <= start:
            end = min(start + 1, int(freq_np.shape[0]))
        if k > 0:
            start = max(start - 1, 0)
        if k == int(n_bands):
            end = int(freq_np.shape[0])
        elif end - start > 1:
            end -= 1
        bands.append((start, end))
    return tuple(bands)


@lru_cache(maxsize=128)
def _cached_dct_matrix_t(
    n_mfcc: int,
    n_mels: int,
    norm: Literal["ortho"] | None,
) -> mx.array:
    return mx.transpose(_cached_dct_matrix(int(n_mfcc), int(n_mels), norm), (1, 0))


def _cqt_frequencies(
    n_bins: int,
    *,
    fmin: float,
    bins_per_octave: int,
) -> np.ndarray:
    n_bins = int(n_bins)
    fmin = float(fmin)
    bins_per_octave = int(bins_per_octave)
    if n_bins <= 0:
        raise ValueError("n_bins must be > 0")
    if fmin <= 0.0:
        raise ValueError("fmin must be > 0")
    if bins_per_octave <= 0:
        raise ValueError("bins_per_octave must be > 0")
    return fmin * (2.0 ** (np.arange(n_bins, dtype=np.float64) / float(bins_per_octave)))


def _relative_bandwidth(freqs: np.ndarray) -> np.ndarray:
    freqs = np.asarray(freqs, dtype=np.float64)
    if freqs.ndim != 1 or freqs.size == 0:
        raise ValueError("freqs must be a non-empty 1-D array")
    if freqs.size == 1:
        return np.ones((1,), dtype=np.float64)
    ratio = float(freqs[1] / freqs[0])
    alpha = (ratio * ratio - 1.0) / (ratio * ratio + 1.0)
    return np.full(freqs.shape, alpha, dtype=np.float64)


def _wavelet_lengths(
    *,
    freqs: np.ndarray,
    sr: float,
    filter_scale: float,
    alpha: np.ndarray,
    gamma: float = 0.0,
) -> np.ndarray:
    freqs = np.asarray(freqs, dtype=np.float64)
    alpha = np.asarray(alpha, dtype=np.float64)
    if freqs.shape != alpha.shape:
        raise ValueError("freqs and alpha must have matching shape")
    if np.any(freqs <= 0.0):
        raise ValueError("freqs must be strictly positive")
    if np.any(alpha <= 0.0):
        raise ValueError("alpha must be strictly positive")
    gamma_term = float(gamma) / alpha
    q = float(filter_scale) / alpha
    return q * float(sr) / (freqs + gamma_term)


def _build_cqt_fft_basis(
    *,
    sr: float,
    freqs: np.ndarray,
    filter_scale: float,
    norm: float,
    sparsity: float,
    alpha: np.ndarray,
    gamma: float = 0.0,
    hop_length: int | None = None,
) -> tuple[np.ndarray, int, np.ndarray]:
    lengths = _wavelet_lengths(
        freqs=np.asarray(freqs, dtype=np.float64),
        sr=float(sr),
        filter_scale=float(filter_scale),
        alpha=np.asarray(alpha, dtype=np.float64),
        gamma=float(gamma),
    )

    filt_list: list[np.ndarray] = []
    for ilen, freq in zip(lengths, freqs):
        length_i = int(np.round(float(ilen)))
        t = np.arange(-length_i // 2, length_i // 2, dtype=np.float64)
        sig = np.exp(1j * 2.0 * np.pi * float(freq) / float(sr) * t)
        sig = sig * np.hanning(len(sig))
        if float(norm) == 1.0:
            sig = sig / (np.sum(np.abs(sig)) + 1e-20)
        filt_list.append(sig)

    max_len = float(np.max(lengths))
    n_fft = int(2.0 ** np.ceil(np.log2(max_len)))
    if hop_length is not None:
        n_fft = max(n_fft, int(2.0 ** (1 + np.ceil(np.log2(int(hop_length))))))

    basis = np.zeros((len(freqs), n_fft), dtype=np.complex128)
    for idx, filt in enumerate(filt_list):
        pad_total = n_fft - len(filt)
        pad_left = pad_total // 2
        basis[idx, pad_left:pad_left + len(filt)] = filt
    basis *= lengths[:, None] / float(n_fft)

    fft_basis = np.fft.fft(basis, n=n_fft, axis=1)[:, : n_fft // 2 + 1]
    if float(sparsity) > 0.0:
        mags = np.abs(fft_basis)
        for row in range(mags.shape[0]):
            thresh = float(np.quantile(mags[row], float(sparsity)))
            fft_basis[row, mags[row] <= thresh] = 0.0

    return fft_basis.astype(np.complex64), int(n_fft), lengths


@lru_cache(maxsize=64)
def _cached_halfband_kernel() -> mx.array:
    num_taps = 63
    cutoff = 0.5
    beta = 8.0
    n = np.arange(num_taps, dtype=np.float64) - (num_taps - 1) / 2.0
    ideal = cutoff * np.sinc(cutoff * n)
    radius = (num_taps - 1) / 2.0
    window_arg = np.sqrt(np.maximum(0.0, 1.0 - (n / radius) ** 2))
    window = np.i0(beta * window_arg) / np.i0(beta)
    kernel = (ideal * window).astype(np.float64)
    kernel /= np.sum(kernel)
    kernel = kernel.astype(np.float32)
    return mx.array(kernel, dtype=mx.float32)[None, :, None]


def _downsample_2x_batched(x: mx.array) -> mx.array:
    squeezed = x.ndim == 1
    if squeezed:
        x = x[None, :]
    elif x.ndim != 2:
        raise ValueError(f"_downsample_2x_batched expects 1D or 2D input, got {x.shape}")

    kernel = _cached_halfband_kernel()
    x_pad = _pad_waveform(x, pad=31, mode="reflect")
    out = mx.conv1d(x_pad[:, :, None], kernel, stride=2)
    out = out[:, :, 0] * float(np.sqrt(2.0))
    return out[0] if squeezed else out


@lru_cache(maxsize=32)
def _cached_hybrid_cqt_plan(
    sr: int,
    hop_length: int,
    fmin: float,
    n_bins: int,
    bins_per_octave: int,
    filter_scale: float,
    norm: float,
    sparsity: float,
) -> dict[str, Any]:
    freqs = np.asarray(
        _cqt_frequencies(int(n_bins), fmin=float(fmin), bins_per_octave=int(bins_per_octave)),
        dtype=np.float64,
    )
    alpha = _relative_bandwidth(freqs)
    lengths = _wavelet_lengths(
        freqs=freqs,
        sr=float(sr),
        filter_scale=float(filter_scale),
        alpha=alpha,
    )

    pseudo_mask = 2.0 ** np.ceil(np.log2(lengths)) < 2.0 * float(hop_length)
    n_pseudo = int(np.sum(pseudo_mask))
    n_full = int(n_bins) - n_pseudo
    n_octaves = int(np.ceil(n_full / float(bins_per_octave))) if n_full > 0 else 0

    pseudo_plan = None
    if n_pseudo > 0:
        pseudo_freqs = freqs[pseudo_mask]
        pseudo_alpha = alpha[pseudo_mask]
        pseudo_fft_basis, pseudo_nfft, _ = _build_cqt_fft_basis(
            sr=float(sr),
            freqs=pseudo_freqs,
            filter_scale=float(filter_scale),
            norm=float(norm),
            sparsity=float(sparsity),
            alpha=pseudo_alpha,
            hop_length=int(hop_length),
        )
        pseudo_plan = {
            "n_fft": int(pseudo_nfft),
            "basis": mx.array(np.abs(np.asarray(pseudo_fft_basis)).astype(np.float32), dtype=mx.float32),
            "scale": float(np.sqrt(float(pseudo_nfft))),
        }

    octave_plans: list[tuple[mx.array, int, int]] = []
    full_freqs = freqs[:n_full]
    full_alpha = alpha[:n_full]
    octave_sr = float(sr)
    octave_hop = int(hop_length)
    for octave_idx in range(n_octaves):
        n_filt = int(bins_per_octave)
        if octave_idx == 0:
            sl = slice(-n_filt, None)
        else:
            sl = slice(-n_filt * (octave_idx + 1), -n_filt * octave_idx)
        octave_freqs = full_freqs[sl]
        octave_alpha = full_alpha[sl]
        octave_fft_basis, octave_nfft, _ = _build_cqt_fft_basis(
            sr=octave_sr,
            freqs=octave_freqs,
            filter_scale=float(filter_scale),
            norm=float(norm),
            sparsity=float(sparsity),
            alpha=octave_alpha,
            gamma=0.0,
        )
        octave_fft_basis = np.asarray(octave_fft_basis) * np.sqrt(float(sr) / octave_sr)
        octave_plans.append(
            (
                mx.array(octave_fft_basis.astype(np.complex64), dtype=mx.complex64),
                int(octave_nfft),
                int(octave_hop),
            )
        )
        octave_sr /= 2.0
        octave_hop = max(1, octave_hop // 2)

    return {
        "n_pseudo": int(n_pseudo),
        "n_full": int(n_full),
        "n_octaves": int(n_octaves),
        "pseudo": pseudo_plan,
        "octaves": tuple(octave_plans),
        "scale_factors": mx.array((1.0 / np.sqrt(lengths)).astype(np.float32), dtype=mx.float32),
    }


# ---------------------------------------------------------------------------
# nnaudio CQT2010v2 kernel generation
# ---------------------------------------------------------------------------


def nnaudio_cqt_kernels(
    *,
    sr: int = 22050,
    fmin: float = 27.5,
    n_bins: int = 309,
    bins_per_octave: int = 36,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Generate CQT kernels matching the nnaudio CQT2010v2 algorithm.

    Reproduces the exact time-domain kernel construction used by
    `nnAudio.features.cqt.CQT2010v2 <https://github.com/KinWaiCheuk/nnAudio>`_
    (as used in Spotify's basic-pitch ICASSP 2022 model). The algorithm:

    1. Compute Q factor and adjusted ``fmin`` for the top octave
    2. Build windowed complex sinusoid kernels (periodic Hann, L1-normalized)
    3. Compute ``sqrt(lengths)`` normalization for all bins
    4. Generate FIR lowpass filter for octave downsampling

    All four output arrays are bit-identical to those extracted from the
    original basic-pitch ONNX model.

    Parameters
    ----------
    sr : int
        Audio sample rate (default 22050).
    fmin : float
        Lowest CQT frequency in Hz (default 27.5, A0).
    n_bins : int
        Total number of CQT frequency bins (default 309).
    bins_per_octave : int
        Number of bins per octave (default 36, i.e. 3 per semitone).

    Returns
    -------
    kernel_real : np.ndarray, shape ``(n_filters, n_fft)``
        Real part of the time-domain CQT convolution kernels.
    kernel_imag : np.ndarray, shape ``(n_filters, n_fft)``
        Imaginary part of the time-domain CQT convolution kernels.
    sqrt_lengths : np.ndarray, shape ``(n_bins,)``
        Per-bin normalization factors (``sqrt(ceil(Q * sr / freq))``).
    lowpass : np.ndarray, shape ``(256,)``
        FIR lowpass filter for octave-by-octave downsampling.
    """
    sr = int(sr)
    fmin = float(fmin)
    n_bins = int(n_bins)
    bins_per_octave = int(bins_per_octave)

    Q = 1.0 / (2 ** (1 / bins_per_octave) - 1)
    n_octaves = int(np.ceil(n_bins / bins_per_octave))
    n_filters = min(bins_per_octave, n_bins)

    # Adjusted fmin for the top octave (nnaudio CQT2010v2.build logic)
    fmin_t = fmin * 2 ** (n_octaves - 1)
    remainder = n_bins % bins_per_octave
    if remainder == 0:
        fmax_t = fmin_t * 2 ** ((bins_per_octave - 1) / bins_per_octave)
    else:
        fmax_t = fmin_t * 2 ** ((remainder - 1) / bins_per_octave)
    fmin_t = fmax_t / 2 ** (1 - 1 / bins_per_octave)

    # Kernel length (next power of 2 of longest filter)
    n_fft = 2 ** int(np.ceil(np.log2(np.ceil(Q * sr / fmin_t))))

    # Time-domain kernels: periodic Hann window, L1-normalized
    freqs_kernel = fmin_t * 2.0 ** (np.arange(n_filters) / bins_per_octave)
    kernel = np.zeros((n_filters, n_fft), dtype=np.complex64)

    for k in range(n_filters):
        freq = freqs_kernel[k]
        _l = int(np.ceil(Q * sr / freq))
        start = int(np.ceil(n_fft / 2.0 - _l / 2.0)) - int(_l % 2)

        # Periodic Hann window
        n = np.arange(_l, dtype=np.float64)
        win = 0.5 - 0.5 * np.cos(2 * np.pi * n / _l)

        sig = (
            win
            * np.exp(np.r_[-_l // 2 : _l // 2] * 1j * 2 * np.pi * freq / sr)
            / _l
        )
        sig = sig / np.linalg.norm(sig, 1)  # L1 normalization
        kernel[k, start : start + _l] = sig

    kernel_real = kernel.real.astype(np.float32)
    kernel_imag = kernel.imag.astype(np.float32)

    # sqrt(lengths) for librosa-style normalization across all bins
    freqs_all = fmin * 2.0 ** (np.arange(n_bins) / bins_per_octave)
    sqrt_lengths = np.sqrt(np.ceil(Q * sr / freqs_all)).astype(np.float32)

    # FIR lowpass filter for octave downsampling (frequency-sampling design)
    lowpass = _nnaudio_lowpass_filter(256, 0.001)

    return kernel_real, kernel_imag, sqrt_lengths, lowpass


def _nnaudio_lowpass_filter(
    numtaps: int,
    transition_bandwidth: float,
) -> np.ndarray:
    """FIR lowpass filter matching nnaudio's ``create_lowpass_filter``.

    Uses frequency-sampling design (equivalent to ``scipy.signal.firwin2``)
    with a Hamming window. The filter has unity gain below the passband edge
    and zero gain above the stopband edge.

    Parameters
    ----------
    numtaps : int
        Filter length.
    transition_bandwidth : float
        Fractional width of the transition band around the 0.5 cutoff.

    Returns
    -------
    np.ndarray, shape ``(numtaps,)``
        FIR filter coefficients, float32.
    """
    passband_max = 0.5 / (1 + transition_bandwidth)
    stopband_min = 0.5 * (1 + transition_bandwidth)
    freq = [0.0, passband_max, stopband_min, 1.0]
    gain = [1.0, 1.0, 0.0, 0.0]

    # Frequency-sampling design (firwin2 algorithm)
    nfreqs = 1 + 2 ** int(np.ceil(np.log2(numtaps)))
    x = np.linspace(0.0, 1.0, nfreqs)
    fx = np.interp(x, freq, gain)

    # Phase shift so first numtaps of IRFFT give the filter coefficients
    shift = np.exp(-(numtaps - 1) / 2.0 * 1j * np.pi * x)
    out_full = np.fft.irfft(fx * shift)

    # Hamming window and truncate
    out = out_full[:numtaps] * np.hamming(numtaps)

    return out.astype(np.float32)


def _pad_waveform(
    x: mx.array,
    *,
    pad: int,
    mode: str,
) -> mx.array:
    if pad <= 0:
        return x
    if mode == "reflect":
        if int(x.shape[1]) <= pad:
            return mx.pad(x, [(0, 0), (pad, pad)], mode="edge")
        return _torch_like_reflect_pad_1d(x, pad)
    return mx.pad(x, [(0, 0), (pad, pad)], mode=mode)


def _frame_signal(
    x: mx.array,
    *,
    frame_length: int,
    hop_length: int,
    center: bool,
    pad_mode: str,
) -> tuple[mx.array, bool]:
    x, squeezed = _ensure_audio_batch(x, fn_name="frame_signal")
    frame_length = int(frame_length)
    hop_length = int(hop_length)
    if frame_length <= 0:
        raise ValueError("frame_length must be > 0")
    if hop_length <= 0:
        raise ValueError("hop_length must be > 0")

    x = mx.contiguous(x)
    if center:
        x = _pad_waveform(
            x,
            pad=frame_length // 2,
            mode=str(pad_mode),
        )

    batch, length = x.shape
    if length < frame_length:
        x = mx.pad(x, [(0, 0), (0, frame_length - int(length))], mode="constant")
        length = int(x.shape[1])

    n_frames = 1 + (int(length) - frame_length) // hop_length
    frames = mx.as_strided(
        x,
        shape=(int(batch), int(n_frames), frame_length),
        strides=(int(length), hop_length, 1),
    )
    return mx.contiguous(frames), squeezed


def _stft_magnitude(
    x: mx.array,
    *,
    sample_rate: int,
    n_fft: int,
    hop_length: int,
    win_length: Optional[int],
    window_fn: str,
    periodic: bool,
    center: bool,
    center_pad_mode: CenterPadMode,
    center_tail_pad: CenterTailPad,
) -> tuple[mx.array, bool]:
    x, squeezed = _ensure_audio_batch(x, fn_name="stft_magnitude")
    effective_center_pad_mode = center_pad_mode
    n_fft = int(n_fft)
    hop_length = int(hop_length)
    win_length = int(win_length) if win_length is not None else int(n_fft)
    if (
        center
        and center_pad_mode == "reflect"
        and int(x.shape[1]) <= (n_fft // 2)
    ):
        effective_center_pad_mode = "constant"
    tr = get_transform_mlx(
        n_fft=n_fft,
        hop_length=hop_length,
        win_length=win_length,
        window_fn=str(window_fn),
        periodic=bool(periodic),
        center=bool(center),
        normalized=False,
        window=None,
        center_pad_mode=effective_center_pad_mode,
        center_tail_pad=center_tail_pad,
        istft_backend_policy=None,
    )
    spec = tr.stft(x, output_layout="bfn")
    mag = mx.abs(spec).astype(mx.float32)
    return mag, squeezed


def _normalize(
    x: mx.array,
    *,
    norm: float | None,
    axis: int,
) -> mx.array:
    if norm is None:
        return x
    value = float(norm)
    abs_x = mx.abs(x)
    if math.isinf(value):
        if value > 0:
            denom = mx.max(abs_x, axis=axis, keepdims=True)
        else:
            denom = mx.min(abs_x, axis=axis, keepdims=True)
    else:
        if value <= 0:
            raise ValueError("norm must be positive, +/-inf, or None")
        denom = mx.sum(abs_x ** value, axis=axis, keepdims=True) ** (1.0 / value)
    return x / mx.maximum(denom, 1e-10)


def _chroma_filterbank(
    sample_rate: int,
    n_fft: int,
    *,
    n_chroma: int = 12,
    tuning: float = 0.0,
) -> mx.array:
    sample_rate = int(sample_rate)
    n_fft = int(n_fft)
    n_chroma = int(n_chroma)
    if sample_rate <= 0:
        raise ValueError("sample_rate must be > 0")
    if n_fft <= 0:
        raise ValueError("n_fft must be > 0")
    if n_chroma <= 0:
        raise ValueError("n_chroma must be > 0")

    frequencies = np.linspace(0.0, float(sample_rate), int(n_fft), endpoint=False)[1:]
    A440 = 440.0 * (2.0 ** (float(tuning) / float(n_chroma)))
    frqbins = float(n_chroma) * np.log2(frequencies / (A440 / 16.0))
    frqbins = np.concatenate(([frqbins[0] - 1.5 * float(n_chroma)], frqbins))
    binwidthbins = np.concatenate((np.maximum(frqbins[1:] - frqbins[:-1], 1.0), [1.0]))

    D = np.subtract.outer(frqbins, np.arange(0, n_chroma, dtype=np.float64)).T
    n_chroma2 = np.round(float(n_chroma) / 2.0)
    D = np.remainder(D + n_chroma2 + 10.0 * float(n_chroma), float(n_chroma)) - n_chroma2

    wts = np.exp(-0.5 * (2.0 * D / np.tile(binwidthbins, (n_chroma, 1))) ** 2)
    norms = np.sqrt(np.sum(wts * wts, axis=0, keepdims=True))
    wts = wts / np.maximum(norms, 1e-16)
    wts *= np.tile(
        np.exp(-0.5 * (((frqbins / float(n_chroma) - 5.0) / 2.0) ** 2)),
        (n_chroma, 1),
    )
    wts = np.roll(wts, -3 * (n_chroma // 12), axis=0)
    wts = np.ascontiguousarray(wts[:, : int(1 + n_fft / 2)], dtype=np.float32)
    return mx.array(wts, dtype=mx.float32)


def _normalize_spectral_feature_names(
    include: tuple[str, ...] | list[str] | None,
) -> tuple[str, ...]:
    if include is None:
        return _SPECTRAL_FEATURE_NAMES
    names: list[str] = []
    for raw_name in include:
        name = str(raw_name)
        if name not in _SPECTRAL_FEATURE_NAMES:
            valid = ", ".join(_SPECTRAL_FEATURE_NAMES)
            raise ValueError(f"Unknown spectral feature {name!r}. Expected one of: {valid}")
        if name not in names:
            names.append(name)
    if not names:
        raise ValueError("include must request at least one spectral feature")
    return tuple(names)


def _spectral_centroid_from_mag(
    mag: mx.array,
    *,
    freqs: mx.array,
) -> mx.array:
    denom = mx.maximum(mx.sum(mag, axis=1, keepdims=True), 1e-10)
    return (mx.sum(mag * freqs[None, :, None], axis=1, keepdims=True) / denom).astype(mx.float32)


def _spectral_bandwidth_from_mag(
    mag: mx.array,
    *,
    freqs: mx.array,
    p: float,
    centroid: mx.array | None = None,
) -> mx.array:
    p = float(p)
    if p <= 0:
        raise ValueError("p must be > 0")
    if centroid is None:
        centroid = _spectral_centroid_from_mag(mag, freqs=freqs)
    denom = mx.maximum(mx.sum(mag, axis=1, keepdims=True), 1e-10)
    deviation = mx.abs(freqs[None, :, None] - centroid) ** p
    return ((mx.sum(mag * deviation, axis=1, keepdims=True) / denom) ** (1.0 / p)).astype(mx.float32)


def _spectral_rolloff_from_mag(
    mag: mx.array,
    *,
    freqs: mx.array,
    roll_percent: float,
) -> mx.array:
    roll_percent = float(roll_percent)
    if not 0.0 < roll_percent < 1.0:
        raise ValueError("roll_percent must lie in the range (0, 1)")
    total_energy = mx.cumsum(mag, axis=1)
    threshold = roll_percent * total_energy[:, -1:, :]
    idx = mx.argmax((total_energy >= threshold).astype(mx.int32), axis=1)
    roll = mx.take(freqs, idx.reshape(-1)).reshape(idx.shape)
    return roll[:, None, :].astype(mx.float32)


def _spectral_contrast_from_mag(
    mag: mx.array,
    *,
    sample_rate: int,
    n_fft: int,
    n_bands: int,
    fmin: float,
    quantile: float,
    band_ranges: tuple[tuple[int, int], ...] | None = None,
) -> mx.array:
    if int(n_bands) < 1:
        raise ValueError("n_bands must be a positive integer")
    if not 0.0 < float(quantile) < 1.0:
        raise ValueError("quantile must lie in the range (0, 1)")
    if float(fmin) <= 0.0:
        raise ValueError("fmin must be a positive number")

    if band_ranges is None:
        band_ranges = _cached_spectral_contrast_bands(
            int(sample_rate),
            int(n_fft),
            int(n_bands),
            float(fmin),
        )

    valleys = []
    peaks = []
    for start, end in band_ranges:
        sub_band = mag[:, start:end, :]
        band_bins = int(sub_band.shape[1])
        idx = max(int(np.rint(float(quantile) * band_bins)), 1)
        sorted_band = mx.sort(sub_band, axis=1)
        valleys.append(mx.mean(sorted_band[:, :idx, :], axis=1))
        peaks.append(mx.mean(sorted_band[:, -idx:, :], axis=1))

    valley = mx.stack(valleys, axis=1).astype(mx.float32)
    peak = mx.stack(peaks, axis=1).astype(mx.float32)
    amin = mx.array(1e-10, dtype=mx.float32)
    peak_db = 10.0 * mx.log10(mx.maximum(peak, amin))
    valley_db = 10.0 * mx.log10(mx.maximum(valley, amin))
    return (peak_db - valley_db).astype(mx.float32)


def _chroma_stft_from_power(
    power: mx.array,
    *,
    chroma_fb: mx.array,
    norm: float | None,
) -> mx.array:
    chroma_bnc = mx.matmul(mx.transpose(power, (0, 2, 1)), mx.transpose(chroma_fb, (1, 0)))
    chroma_bcn = mx.transpose(chroma_bnc, (0, 2, 1)).astype(mx.float32)
    return _normalize(chroma_bcn, norm=norm, axis=-2)


def _mfcc_from_power(
    power: mx.array,
    *,
    mel_fb: mx.array,
    dct_mat_t: mx.array,
    top_db: float | None = 80.0,
    lifter_weights: mx.array | None = None,
) -> mx.array:
    mel_bmn = _apply_mel_filterbank(power, mel_fb=mel_fb, input_layout="bfn")
    mel_bmn = amplitude_to_db(mel_bmn, stype="power", top_db=top_db, mode="per_example")
    return _apply_mfcc_projection(
        mel_bmn,
        dct_mat_t=dct_mat_t,
        lifter_weights=lifter_weights,
    )


def _spectral_feature_values_from_mag(
    mag: mx.array,
    *,
    include: tuple[str, ...],
    sample_rate: int,
    n_fft: int,
    n_chroma: int = 12,
    chroma_norm: float | None = 2,
    tuning: float = 0.0,
    bandwidth_p: float = 2.0,
    roll_percent: float = 0.85,
    n_bands: int = 6,
    contrast_fmin: float = 200.0,
    contrast_quantile: float = 0.02,
    n_mfcc: int = 20,
    n_mels: int = 128,
    f_min: float = 0.0,
    f_max: float | None = None,
    mel_norm: MelNorm = "slaney",
    mel_scale: MelScale = "slaney",
    top_db: float | None = 80.0,
    lifter: int = 0,
    dct_norm: Literal["ortho"] | None = "ortho",
) -> tuple[mx.array, ...]:
    requested = _normalize_spectral_feature_names(include)
    if lifter < 0:
        raise ValueError("lifter must be >= 0")
    freqs: mx.array | None = None
    centroid: mx.array | None = None
    power: mx.array | None = None
    chroma_fb: mx.array | None = None
    mel_fb: mx.array | None = None
    dct_mat_t: mx.array | None = None
    lifter_weights: mx.array | None = None
    results: list[mx.array] = []
    for name in requested:
        if name == "chroma_stft":
            if power is None:
                power = mag * mag
            if chroma_fb is None:
                chroma_fb = _cached_chroma_filterbank(sample_rate, n_fft, n_chroma, tuning)
            results.append(
                _chroma_stft_from_power(
                    power,
                    chroma_fb=chroma_fb,
                    norm=chroma_norm,
                )
            )
            continue
        if name == "mfcc":
            if power is None:
                power = mag * mag
            if mel_fb is None:
                f_max_resolved = float(sample_rate // 2 if f_max is None else f_max)
                mel_fb = _cached_mel_filterbank(
                    int(mag.shape[1]),
                    float(f_min),
                    f_max_resolved,
                    int(n_mels),
                    int(sample_rate),
                    mel_norm,
                    mel_scale,
                )
            if dct_mat_t is None:
                dct_mat_t = _cached_dct_matrix_t(int(n_mfcc), int(n_mels), dct_norm)
            if lifter > 0 and lifter_weights is None:
                lifter_weights = _cached_lifter_weights(int(n_mfcc), int(lifter))
            results.append(
                _mfcc_from_power(
                    power,
                    mel_fb=mel_fb,
                    dct_mat_t=dct_mat_t,
                    top_db=top_db,
                    lifter_weights=lifter_weights,
                )
            )
            continue

        if freqs is None:
            freqs = _cached_fft_frequencies(sample_rate, n_fft)
        if name == "spectral_centroid":
            if centroid is None:
                centroid = _spectral_centroid_from_mag(mag, freqs=freqs)
            results.append(centroid)
        elif name == "spectral_bandwidth":
            if centroid is None:
                centroid = _spectral_centroid_from_mag(mag, freqs=freqs)
            results.append(
                _spectral_bandwidth_from_mag(
                    mag,
                    freqs=freqs,
                    p=bandwidth_p,
                    centroid=centroid,
                )
            )
        elif name == "spectral_rolloff":
            results.append(
                _spectral_rolloff_from_mag(
                    mag,
                    freqs=freqs,
                    roll_percent=roll_percent,
                )
            )
        elif name == "spectral_contrast":
            results.append(
                _spectral_contrast_from_mag(
                    mag,
                    sample_rate=sample_rate,
                    n_fft=n_fft,
                    n_bands=n_bands,
                    fmin=contrast_fmin,
                    quantile=contrast_quantile,
                )
            )
        else:
            raise ValueError(f"Unhandled spectral feature {name!r}")
    return tuple(results)


def _spectral_feature_values(
    x: mx.array,
    *,
    include: tuple[str, ...],
    sample_rate: int = 22_050,
    n_fft: int = 2_048,
    hop_length: int = 512,
    win_length: int | None = None,
    window_fn: str = "hann",
    center: bool = True,
    center_pad_mode: str = "reflect",
    center_tail_pad: str = "symmetric",
    n_chroma: int = 12,
    chroma_norm: float | None = 2,
    tuning: float = 0.0,
    bandwidth_p: float = 2.0,
    roll_percent: float = 0.85,
    n_bands: int = 6,
    contrast_fmin: float = 200.0,
    contrast_quantile: float = 0.02,
    n_mfcc: int = 20,
    n_mels: int = 128,
    f_min: float = 0.0,
    f_max: float | None = None,
    mel_norm: MelNorm = "slaney",
    mel_scale: MelScale = "slaney",
    top_db: float | None = 80.0,
    lifter: int = 0,
    dct_norm: Literal["ortho"] | None = "ortho",
) -> tuple[tuple[mx.array, ...], bool]:
    requested = _normalize_spectral_feature_names(include)
    mag, squeezed = _stft_magnitude(
        x,
        sample_rate=sample_rate,
        n_fft=n_fft,
        hop_length=hop_length,
        win_length=win_length,
        window_fn=window_fn,
        periodic=True,
        center=center,
        center_pad_mode=center_pad_mode,
        center_tail_pad=center_tail_pad,
    )
    values = _spectral_feature_values_from_mag(
        mag,
        include=requested,
        sample_rate=sample_rate,
        n_fft=n_fft,
        n_chroma=n_chroma,
        chroma_norm=chroma_norm,
        tuning=tuning,
        bandwidth_p=bandwidth_p,
        roll_percent=roll_percent,
        n_bands=n_bands,
        contrast_fmin=contrast_fmin,
        contrast_quantile=contrast_quantile,
        n_mfcc=n_mfcc,
        n_mels=n_mels,
        f_min=f_min,
        f_max=f_max,
        mel_norm=mel_norm,
        mel_scale=mel_scale,
        top_db=top_db,
        lifter=lifter,
        dct_norm=dct_norm,
    )
    return values, squeezed


def chroma_stft(
    x: mx.array,
    *,
    sample_rate: int = 22_050,
    n_fft: int = 2_048,
    hop_length: int = 512,
    win_length: int | None = None,
    n_chroma: int = 12,
    norm: float | None = 2,
    window_fn: str = "hann",
    center: bool = True,
    center_pad_mode: str = "reflect",
    center_tail_pad: str = "symmetric",
    tuning: float = 0.0,
) -> mx.array:
    """Compute chromagram from audio via STFT."""
    (chroma_bcn,), squeezed = _spectral_feature_values(
        x,
        include=("chroma_stft",),
        sample_rate=sample_rate,
        n_fft=n_fft,
        hop_length=hop_length,
        win_length=win_length,
        window_fn=window_fn,
        center=center,
        center_pad_mode=center_pad_mode,
        center_tail_pad=center_tail_pad,
        n_chroma=n_chroma,
        chroma_norm=norm,
        tuning=tuning,
    )
    return _restore_feature_batch(chroma_bcn, squeezed=squeezed)


def spectral_features(
    x: mx.array,
    *,
    include: tuple[str, ...] | list[str] | None = None,
    sample_rate: int = 22_050,
    n_fft: int = 2_048,
    hop_length: int = 512,
    win_length: int | None = None,
    window_fn: str = "hann",
    center: bool = True,
    center_pad_mode: str = "reflect",
    center_tail_pad: str = "symmetric",
    n_chroma: int = 12,
    chroma_norm: float | None = 2,
    tuning: float = 0.0,
    bandwidth_p: float = 2.0,
    roll_percent: float = 0.85,
    n_bands: int = 6,
    contrast_fmin: float = 200.0,
    contrast_quantile: float = 0.02,
    n_mfcc: int = 20,
    n_mels: int = 128,
    f_min: float = 0.0,
    f_max: float | None = None,
    mel_norm: MelNorm = "slaney",
    mel_scale: MelScale = "slaney",
    top_db: float | None = 80.0,
    lifter: int = 0,
    dct_norm: Literal["ortho"] | None = "ortho",
) -> dict[str, mx.array]:
    """Compute several STFT-derived descriptors from one shared magnitude pass."""
    requested = _normalize_spectral_feature_names(include)
    values, squeezed = _spectral_feature_values(
        x,
        include=requested,
        sample_rate=sample_rate,
        n_fft=n_fft,
        hop_length=hop_length,
        win_length=win_length,
        window_fn=window_fn,
        center=center,
        center_pad_mode=center_pad_mode,
        center_tail_pad=center_tail_pad,
        n_chroma=n_chroma,
        chroma_norm=chroma_norm,
        tuning=tuning,
        bandwidth_p=bandwidth_p,
        roll_percent=roll_percent,
        n_bands=n_bands,
        contrast_fmin=contrast_fmin,
        contrast_quantile=contrast_quantile,
        n_mfcc=n_mfcc,
        n_mels=n_mels,
        f_min=f_min,
        f_max=f_max,
        mel_norm=mel_norm,
        mel_scale=mel_scale,
        top_db=top_db,
        lifter=lifter,
        dct_norm=dct_norm,
    )
    return OrderedDict(
        (name, _restore_feature_batch(value, squeezed=squeezed))
        for name, value in zip(requested, values)
    )


class SpectralFeatureTransform:
    """Cached shared-STFT extractor for repeated spectral descriptor workloads."""

    __slots__ = (
        "include",
        "sample_rate",
        "n_fft",
        "hop_length",
        "win_length",
        "window_fn",
        "center",
        "center_pad_mode",
        "center_tail_pad",
        "n_chroma",
        "chroma_norm",
        "tuning",
        "bandwidth_p",
        "roll_percent",
        "n_bands",
        "contrast_fmin",
        "contrast_quantile",
        "n_mfcc",
        "n_mels",
        "f_min",
        "f_max",
        "mel_norm",
        "mel_scale",
        "top_db",
        "lifter",
        "dct_norm",
        "spectral",
        "freqs",
        "chroma_fb",
        "mel_fb",
        "dct_mat",
        "_dct_mat_t",
        "_lifter_weights",
        "_short_spectral",
        "_contrast_bands",
        "_compiled_fn",
        "_compiled_values_fn",
    )

    def __init__(
        self,
        *,
        include: tuple[str, ...] | list[str] | None = None,
        sample_rate: int = 22_050,
        n_fft: int = 2_048,
        hop_length: int = 512,
        win_length: int | None = None,
        window_fn: str = "hann",
        center: bool = True,
        center_pad_mode: str = "reflect",
        center_tail_pad: str = "symmetric",
        n_chroma: int = 12,
        chroma_norm: float | None = 2,
        tuning: float = 0.0,
        bandwidth_p: float = 2.0,
        roll_percent: float = 0.85,
        n_bands: int = 6,
        contrast_fmin: float = 200.0,
        contrast_quantile: float = 0.02,
        n_mfcc: int = 20,
        n_mels: int = 128,
        f_min: float = 0.0,
        f_max: float | None = None,
        mel_norm: MelNorm = "slaney",
        mel_scale: MelScale = "slaney",
        top_db: float | None = 80.0,
        lifter: int = 0,
        dct_norm: Literal["ortho"] | None = "ortho",
    ) -> None:
        self.include = _normalize_spectral_feature_names(include)
        self.sample_rate = int(sample_rate)
        self.n_fft = int(n_fft)
        self.hop_length = int(hop_length)
        self.win_length = int(win_length) if win_length is not None else int(n_fft)
        self.window_fn = str(window_fn)
        self.center = bool(center)
        self.center_pad_mode = str(center_pad_mode)
        self.center_tail_pad = str(center_tail_pad)
        self.n_chroma = int(n_chroma)
        self.chroma_norm = chroma_norm
        self.tuning = float(tuning)
        self.bandwidth_p = float(bandwidth_p)
        self.roll_percent = float(roll_percent)
        self.n_bands = int(n_bands)
        self.contrast_fmin = float(contrast_fmin)
        self.contrast_quantile = float(contrast_quantile)
        self.n_mfcc = int(n_mfcc)
        self.n_mels = int(n_mels)
        self.f_min = float(f_min)
        self.f_max = float(self.sample_rate // 2 if f_max is None else f_max)
        self.mel_norm = mel_norm
        self.mel_scale = mel_scale
        self.top_db = top_db
        self.lifter = int(lifter)
        self.dct_norm = dct_norm
        if self.bandwidth_p <= 0:
            raise ValueError("bandwidth_p must be > 0")
        if not 0.0 < self.roll_percent < 1.0:
            raise ValueError("roll_percent must lie in the range (0, 1)")
        if self.n_bands < 1:
            raise ValueError("n_bands must be a positive integer")
        if not 0.0 < self.contrast_quantile < 1.0:
            raise ValueError("contrast_quantile must lie in the range (0, 1)")
        if self.contrast_fmin <= 0.0:
            raise ValueError("contrast_fmin must be a positive number")
        if self.n_mfcc <= 0:
            raise ValueError("n_mfcc must be > 0")
        if self.n_mels <= 0:
            raise ValueError("n_mels must be > 0")
        if self.n_mfcc > self.n_mels:
            raise ValueError("n_mfcc must be <= n_mels")
        if self.lifter < 0:
            raise ValueError("lifter must be >= 0")
        if self.dct_norm not in (None, "ortho"):
            raise ValueError('dct_norm must be one of {None, "ortho"}')

        self.spectral = get_transform_mlx(
            n_fft=self.n_fft,
            hop_length=self.hop_length,
            win_length=self.win_length,
            window_fn=self.window_fn,
            periodic=True,
            center=self.center,
            normalized=False,
            window=None,
            center_pad_mode=self.center_pad_mode,
            center_tail_pad=self.center_tail_pad,
            istft_backend_policy=None,
        )
        self._short_spectral = None
        if self.center and self.center_pad_mode == "reflect":
            self._short_spectral = get_transform_mlx(
                n_fft=self.n_fft,
                hop_length=self.hop_length,
                win_length=self.win_length,
                window_fn=self.window_fn,
                periodic=True,
                center=self.center,
                normalized=False,
                window=None,
                center_pad_mode="constant",
                center_tail_pad=self.center_tail_pad,
                istft_backend_policy=None,
            )
        self.freqs = _cached_fft_frequencies(self.sample_rate, self.n_fft)
        self._contrast_bands = None
        self.chroma_fb = None
        self.mel_fb = None
        self.dct_mat = None
        self._dct_mat_t = None
        self._lifter_weights = None
        self._compiled_fn = None
        self._compiled_values_fn = None

        if "chroma_stft" in self.include:
            self.chroma_fb = _cached_chroma_filterbank(
                self.sample_rate,
                self.n_fft,
                self.n_chroma,
                self.tuning,
            )
        if "mfcc" in self.include:
            self.mel_fb = _cached_mel_filterbank(
                self.n_fft // 2 + 1,
                self.f_min,
                self.f_max,
                self.n_mels,
                self.sample_rate,
                self.mel_norm,
                self.mel_scale,
            )
            self.dct_mat = _cached_dct_matrix(self.n_mfcc, self.n_mels, self.dct_norm)
            self._dct_mat_t = _cached_dct_matrix_t(self.n_mfcc, self.n_mels, self.dct_norm)
            if self.lifter > 0:
                self._lifter_weights = _cached_lifter_weights(self.n_mfcc, self.lifter)
        if "spectral_contrast" in self.include:
            self._contrast_bands = _cached_spectral_contrast_bands(
                self.sample_rate,
                self.n_fft,
                self.n_bands,
                self.contrast_fmin,
            )

    def extract(self, x: mx.array) -> OrderedDict[str, mx.array]:
        """Compute the configured feature set from a single shared STFT pass."""
        x_b, squeezed = _ensure_audio_batch(x, fn_name="spectral_features")
        effective_center_pad_mode = self.center_pad_mode
        if (
            self.center
            and self.center_pad_mode == "reflect"
            and int(x_b.shape[1]) <= (self.n_fft // 2)
        ):
            effective_center_pad_mode = "constant"
        stft_transform = self.spectral
        if effective_center_pad_mode != self.center_pad_mode and self._short_spectral is not None:
            stft_transform = self._short_spectral
        spec = stft_transform.stft(x_b, output_layout="bfn")
        mag = mx.abs(spec).astype(mx.float32)
        power = None
        centroid = None
        out: OrderedDict[str, mx.array] = OrderedDict()
        for name in self.include:
            if name == "spectral_centroid":
                if centroid is None:
                    centroid = _spectral_centroid_from_mag(mag, freqs=self.freqs)
                value = centroid
            elif name == "spectral_bandwidth":
                if centroid is None:
                    centroid = _spectral_centroid_from_mag(mag, freqs=self.freqs)
                value = _spectral_bandwidth_from_mag(
                    mag,
                    freqs=self.freqs,
                    p=self.bandwidth_p,
                    centroid=centroid,
                )
            elif name == "spectral_rolloff":
                value = _spectral_rolloff_from_mag(
                    mag,
                    freqs=self.freqs,
                    roll_percent=self.roll_percent,
                )
            elif name == "spectral_contrast":
                value = _spectral_contrast_from_mag(
                    mag,
                    sample_rate=self.sample_rate,
                    n_fft=self.n_fft,
                    n_bands=self.n_bands,
                    fmin=self.contrast_fmin,
                    quantile=self.contrast_quantile,
                    band_ranges=self._contrast_bands,
                )
            elif name == "chroma_stft":
                if power is None:
                    power = mag * mag
                value = _chroma_stft_from_power(
                    power,
                    chroma_fb=self.chroma_fb,
                    norm=self.chroma_norm,
                )
            elif name == "mfcc":
                if power is None:
                    power = mag * mag
                value = _mfcc_from_power(
                    power,
                    mel_fb=self.mel_fb,
                    dct_mat_t=self._dct_mat_t,
                    top_db=self.top_db,
                    lifter_weights=self._lifter_weights,
                )
            else:
                raise ValueError(f"Unhandled spectral feature {name!r}")
            out[name] = _restore_feature_batch(value, squeezed=squeezed)
        return out

    def __call__(self, x: mx.array) -> OrderedDict[str, mx.array]:
        return self.extract(x)

    def _get_compiled_values(self):
        """Return cached compiled raw values in ``include`` order."""
        cached = self._compiled_values_fn
        if cached is not None:
            return cached

        @mx.compile
        def _compiled(x: mx.array):
            out = self.extract(x)
            return tuple(out[name] for name in self.include)

        self._compiled_values_fn = _compiled
        return _compiled

    def get_compiled(self):
        """Return a cached compiled callable matching :meth:`extract` output."""
        cached = self._compiled_fn
        if cached is not None:
            return cached

        values_fn = self._get_compiled_values()

        def _compiled(x: mx.array) -> OrderedDict[str, mx.array]:
            values = values_fn(x)
            return OrderedDict((name, value) for name, value in zip(self.include, values))

        self._compiled_fn = _compiled
        return _compiled


def spectral_centroid(
    x: mx.array,
    *,
    sample_rate: int = 22_050,
    n_fft: int = 2_048,
    hop_length: int = 512,
    win_length: int | None = None,
    window_fn: str = "hann",
    center: bool = True,
    center_pad_mode: str = "reflect",
    center_tail_pad: str = "symmetric",
) -> mx.array:
    """Weighted mean of frequencies per frame."""
    (centroid,), squeezed = _spectral_feature_values(
        x,
        include=("spectral_centroid",),
        sample_rate=sample_rate,
        n_fft=n_fft,
        hop_length=hop_length,
        win_length=win_length,
        window_fn=window_fn,
        center=center,
        center_pad_mode=center_pad_mode,
        center_tail_pad=center_tail_pad,
    )
    return _restore_feature_batch(centroid.astype(mx.float32), squeezed=squeezed)


def spectral_bandwidth(
    x: mx.array,
    *,
    sample_rate: int = 22_050,
    n_fft: int = 2_048,
    hop_length: int = 512,
    win_length: int | None = None,
    p: float = 2.0,
    window_fn: str = "hann",
    center: bool = True,
    center_pad_mode: str = "reflect",
    center_tail_pad: str = "symmetric",
) -> mx.array:
    """Weighted spectral bandwidth around the spectral centroid."""
    (bandwidth,), squeezed = _spectral_feature_values(
        x,
        include=("spectral_bandwidth",),
        sample_rate=sample_rate,
        n_fft=n_fft,
        hop_length=hop_length,
        win_length=win_length,
        window_fn=window_fn,
        center=center,
        center_pad_mode=center_pad_mode,
        center_tail_pad=center_tail_pad,
        bandwidth_p=p,
    )
    return _restore_feature_batch(bandwidth.astype(mx.float32), squeezed=squeezed)


def spectral_rolloff(
    x: mx.array,
    *,
    sample_rate: int = 22_050,
    n_fft: int = 2_048,
    hop_length: int = 512,
    win_length: int | None = None,
    roll_percent: float = 0.85,
    window_fn: str = "hann",
    center: bool = True,
    center_pad_mode: str = "reflect",
    center_tail_pad: str = "symmetric",
) -> mx.array:
    """Frequency below which ``roll_percent`` of spectral energy is contained."""
    (roll,), squeezed = _spectral_feature_values(
        x,
        include=("spectral_rolloff",),
        sample_rate=sample_rate,
        n_fft=n_fft,
        hop_length=hop_length,
        win_length=win_length,
        window_fn=window_fn,
        center=center,
        center_pad_mode=center_pad_mode,
        center_tail_pad=center_tail_pad,
        roll_percent=roll_percent,
    )
    return _restore_feature_batch(roll, squeezed=squeezed)


def spectral_contrast(
    x: mx.array,
    *,
    sample_rate: int = 22_050,
    n_fft: int = 2_048,
    hop_length: int = 512,
    win_length: int | None = None,
    n_bands: int = 6,
    fmin: float = 200.0,
    quantile: float = 0.02,
    window_fn: str = "hann",
    center: bool = True,
    center_pad_mode: str = "reflect",
    center_tail_pad: str = "symmetric",
) -> mx.array:
    """Peak-to-valley spectral contrast per octave subband."""
    (contrast,), squeezed = _spectral_feature_values(
        x,
        include=("spectral_contrast",),
        sample_rate=sample_rate,
        n_fft=n_fft,
        hop_length=hop_length,
        win_length=win_length,
        window_fn=window_fn,
        center=center,
        center_pad_mode=center_pad_mode,
        center_tail_pad=center_tail_pad,
        n_bands=n_bands,
        contrast_fmin=fmin,
        contrast_quantile=quantile,
    )
    return _restore_feature_batch(contrast, squeezed=squeezed)


def rms(
    x: mx.array,
    *,
    frame_length: int = 2_048,
    hop_length: int = 512,
    center: bool = True,
    pad_mode: str = "reflect",
) -> mx.array:
    """Root-mean-square energy per frame."""
    frames, squeezed = _frame_signal(
        x,
        frame_length=frame_length,
        hop_length=hop_length,
        center=center,
        pad_mode=pad_mode,
    )
    power = mx.mean((frames.astype(mx.float32) ** 2), axis=-1)
    out = mx.sqrt(power)[:, None, :].astype(mx.float32)
    return _restore_feature_batch(out, squeezed=squeezed)


def zero_crossing_rate(
    x: mx.array,
    *,
    frame_length: int = 2_048,
    hop_length: int = 512,
    center: bool = True,
    pad_mode: str = "reflect",
) -> mx.array:
    """Fraction of sign changes per frame."""
    frames, squeezed = _frame_signal(
        x,
        frame_length=frame_length,
        hop_length=hop_length,
        center=center,
        pad_mode=pad_mode,
    )
    signs = frames >= 0
    crossings = (signs[..., 1:] != signs[..., :-1]).astype(mx.float32)
    rate = (mx.sum(crossings, axis=-1) / float(frame_length))[:, None, :].astype(mx.float32)
    return _restore_feature_batch(rate, squeezed=squeezed)


# ==============================================================================
# Onset Strength (Spectral Flux)
# ==============================================================================


def onset_strength_multi(
    x: mx.array,
    *,
    sample_rate: int = 22_050,
    n_fft: int = 2_048,
    hop_length: int = 512,
    n_mels: int = 128,
    f_min: float = 0.0,
    f_max: Optional[float] = None,
    center: bool = True,
    lag: int = 1,
    norm: MelNorm = "slaney",
    mel_scale: MelScale = "slaney",
    top_db: Optional[float] = 80.0,
    center_pad_mode: CenterPadMode = "reflect",
    center_tail_pad: CenterTailPad = "symmetric",
) -> mx.array:
    """Per-band half-wave rectified spectral flux of a dB-scaled mel spectrogram.

    Like ``onset_strength`` but returns per-mel-band curves *before*
    averaging across frequency.  Returns shape ``[n_mels, frames]`` for
    1-D input or ``[B, n_mels, frames]`` for batched input.
    """
    sample_rate = int(sample_rate)
    n_fft = int(n_fft)
    hop_length = int(hop_length)
    n_mels = int(n_mels)
    lag = int(lag)
    if lag < 1:
        raise ValueError("lag must be >= 1")

    squeezed = x.ndim == 1
    if squeezed:
        x = x[None, :]

    mel_tr = MelSpectrogramTransform(
        sample_rate=sample_rate,
        n_fft=n_fft,
        hop_length=hop_length,
        n_mels=n_mels,
        f_min=f_min,
        f_max=f_max,
        power=2.0,
        norm=norm,
        mel_scale=mel_scale,
        top_db=top_db,
        mode="mlx_native",
        window_fn="hann",
        periodic=True,
        center=center,
        center_pad_mode=center_pad_mode,
        center_tail_pad=center_tail_pad,
    )

    # [B, n_mels, frames]
    S = mel_tr.mel_spectrogram(x, to_db=True)
    n_frames = S.shape[-1]

    # Spectral flux: half-wave rectified lag-difference along time axis
    flux = mx.maximum(S[..., lag:] - S[..., :-lag], 0.0)  # [B, n_mels, frames-lag]

    # Left-pad to compensate for lag and STFT centering
    pad_width = lag
    if center:
        pad_width += n_fft // (2 * hop_length)
    flux = mx.pad(flux, [(0, 0), (0, 0), (pad_width, 0)])

    # Trim to match mel spectrogram frame count
    flux = flux[..., :n_frames]

    if squeezed:
        flux = flux.squeeze(0)
    return flux


def onset_strength(
    x: mx.array,
    *,
    sample_rate: int = 22_050,
    n_fft: int = 2_048,
    hop_length: int = 512,
    n_mels: int = 128,
    f_min: float = 0.0,
    f_max: Optional[float] = None,
    center: bool = True,
    lag: int = 1,
    norm: MelNorm = "slaney",
    mel_scale: MelScale = "slaney",
    top_db: Optional[float] = 80.0,
    center_pad_mode: CenterPadMode = "reflect",
    center_tail_pad: CenterTailPad = "symmetric",
) -> mx.array:
    """Half-wave rectified spectral flux of a dB-scaled mel spectrogram.

    Equivalent to ``onset_strength_multi`` averaged across mel bands.
    Defaults use Slaney mel scale with Slaney normalization to match
    librosa's ``onset.onset_strength`` conventions.  Returns shape
    ``[frames]`` for 1-D input or ``[B, frames]`` for batched input.
    """
    multi = onset_strength_multi(
        x,
        sample_rate=sample_rate,
        n_fft=n_fft,
        hop_length=hop_length,
        n_mels=n_mels,
        f_min=f_min,
        f_max=f_max,
        center=center,
        lag=lag,
        norm=norm,
        mel_scale=mel_scale,
        top_db=top_db,
        center_pad_mode=center_pad_mode,
        center_tail_pad=center_tail_pad,
    )
    return mx.mean(multi, axis=-2)


# ==============================================================================
# Global Cache & Factory
# ==============================================================================

@lru_cache(maxsize=64)
def _get_transform_cached(key: _TransformKey) -> SpectralTransform:
    return SpectralTransform(
        n_fft=key.n_fft,
        hop_length=key.hop_length,
        win_length=key.win_length,
        window_fn=key.window_fn,
        onesided=key.onesided,
        periodic=key.periodic,
        center=key.center,
        center_pad_mode=key.center_pad_mode,
        center_tail_pad=key.center_tail_pad,
        normalized=key.normalized,
        istft_backend_policy=key.istft_backend_policy,
    )

def get_transform_mlx(
    *,
    n_fft: int,
    hop_length: int,
    win_length: int,
    window_fn: str,
    periodic: bool,
    center: bool,
    normalized: bool,
    window: WindowLike,
    onesided: bool = True,
    center_pad_mode: CenterPadMode = "reflect",
    center_tail_pad: CenterTailPad = "symmetric",
    istft_backend_policy: Optional[str] = None,
) -> SpectralTransform:
    """Return a cached or bespoke SpectralTransform for the given config."""
    resolved_backend = _resolve_backend_policy(
        istft_backend_policy,
        default_policy=_DEFAULT_ISTFT_BACKEND_POLICY,
    )
    if isinstance(window, mx.array):
        return SpectralTransform(
            n_fft=n_fft,
            hop_length=hop_length,
            win_length=win_length,
            window_fn=window_fn,
            onesided=onesided,
            window=window,
            periodic=periodic,
            center=center,
            center_pad_mode=center_pad_mode,
            center_tail_pad=center_tail_pad,
            normalized=normalized,
            istft_backend_policy=resolved_backend,
        )

    key = _TransformKey(
        n_fft=int(n_fft),
        hop_length=int(hop_length),
        win_length=int(win_length),
        window_fn=str(window_fn),
        onesided=bool(onesided),
        periodic=bool(periodic),
        center=bool(center),
        center_pad_mode=str(center_pad_mode),
        center_tail_pad=str(center_tail_pad),
        normalized=bool(normalized),
        istft_backend_policy=str(resolved_backend),
    )
    return _get_transform_cached(key)
