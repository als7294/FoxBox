"""Engine audio store (owned by S3).

Every buffer the engine keeps (sources, renders, dry takes, stems, voice auditions) lives under ``<data>/audio/``:
float32 WAV by default (fast to write, used for previews), or FLAC 24-bit for masters that are kept (final renders:
about a quarter of the size; exports are 24-bit anyway). ``GET /api/audio/{id}`` streams an integer-PCM copy made on
first request (``<data>/audio/stream/``), served as a file so the player gets Range requests.
"""
from __future__ import annotations

import os
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import numpy as np
import soundfile as sf

from fvwks_contracts.audio import wav_bytes
from fvwks_contracts.models import Peaks

ID_RX = re.compile(r"[a-z]+_[0-9a-f]{12}")
PARTIAL_RX = re.compile(r"^\..+\.[0-9a-f]{8}\.part$")  # the engine's own temp files: .<name>.<8 hex>.part
STREAM_BUDGET = 256 << 20  # stream copies are re-creatable; keep the most recently played ones up to this size


def sweep_partials(folders: Iterable[Path], older_than_s: float = 3600, depth: int = 0) -> int:
    """Delete leftover engine temp files older than ``older_than_s`` (what a crash mid-write leaves), looking
    ``depth`` folders down. Only the exact ``.<name>.<8 hex>.part`` pattern is ever touched."""
    now, removed = time.time(), 0

    def scan(folder: Path, level: int) -> None:
        nonlocal removed
        try:
            entries = list(os.scandir(folder))
        except OSError:
            return
        for entry in entries:
            try:
                if entry.is_file(follow_symlinks=False) and PARTIAL_RX.match(entry.name):
                    if now - entry.stat(follow_symlinks=False).st_mtime > older_than_s:
                        os.unlink(entry.path)
                        removed += 1
                elif entry.is_dir(follow_symlinks=False) and level < depth and not entry.name.startswith("."):
                    scan(Path(entry.path), level + 1)
            except OSError:
                continue

    for folder in folders:
        scan(Path(folder), 0)
    return removed


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def peaks(x: np.ndarray, sr: int, buckets: int = 800) -> Peaks:
    """Same result as ``fvwks_contracts.audio.peaks`` (min/max of the channel-summed signal per bucket), vectorized
    with ``reduceat``: about 1 ms instead of 7 ms for an 8-bar stereo render, and every render needs two."""
    a = np.asarray(x, dtype=np.float32)
    mono = a.mean(axis=0) if a.ndim == 2 else a
    n = mono.shape[-1]
    if n == 0:
        return Peaks(buckets=1, duration_s=0.0, min=[0.0], max=[0.0])
    buckets = max(1, min(buckets, n))
    starts = np.linspace(0, n, buckets + 1).astype(int)[:-1]  # strictly increasing while buckets <= n
    lo = np.round(np.clip(np.minimum.reduceat(mono, starts).astype(np.float64), -1, 1), 4)
    hi = np.round(np.clip(np.maximum.reduceat(mono, starts).astype(np.float64), -1, 1), 4)
    return Peaks(buckets=buckets, duration_s=round(n / sr, 5), min=lo.tolist(), max=hi.tolist())


def as_channels_first(audio: np.ndarray) -> np.ndarray:
    """float32 ``(channels, n)`` from ``(n,)`` or ``(channels, n)``."""
    a = np.asarray(audio, dtype=np.float32)
    return a[None, :] if a.ndim == 1 else a


class AudioStore:
    def __init__(self, data_dir: Path, stream_budget: int = STREAM_BUDGET, folder: str = "audio"):
        self.dir = Path(data_dir) / folder
        self.stream_dir = self.dir / "stream"
        self.stream_dir.mkdir(parents=True, exist_ok=True)
        self.stream_budget = stream_budget

    @staticmethod
    def valid(audio_id: str | None) -> bool:
        return bool(audio_id) and ID_RX.fullmatch(audio_id) is not None

    def _masters(self, audio_id: str) -> list[Path]:
        if not self.valid(audio_id):
            raise KeyError(f"bad audio id {audio_id!r}")
        return [self.dir / f"{audio_id}.wav", self.dir / f"{audio_id}.flac"]

    def _master(self, audio_id: str) -> Path | None:
        return next((p for p in self._masters(audio_id) if p.is_file()), None)

    def put(self, audio: np.ndarray, sr: int, prefix: str = "aud", audio_id: str | None = None,
            compact: bool = False) -> str:
        """Store a buffer; ``compact`` keeps it as FLAC 24-bit (unless it goes over full scale, which would clip).
        libsndfile scales FLAC-24 by 2^23 both ways: -1.0 fits (and a decoded 16/24-bit file round-trips exactly),
        +1.0 would wrap."""
        audio_id = audio_id or new_id(prefix)
        a = as_channels_first(audio)
        compact = compact and a.size > 0 and float(a.max()) < 1.0 and float(a.min()) >= -1.0
        wav, flac = self._masters(audio_id)
        path, stale = (flac, wav) if compact else (wav, flac)
        tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.part")
        try:
            sf.write(tmp, a.T, int(sr), format="FLAC" if compact else "WAV", subtype="PCM_24" if compact else "FLOAT")
            os.replace(tmp, path)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        stale.unlink(missing_ok=True)
        (self.stream_dir / f"{audio_id}.wav").unlink(missing_ok=True)
        return audio_id

    def exists(self, audio_id: str | None) -> bool:
        return self.valid(audio_id) and self._master(audio_id) is not None

    def load(self, audio_id: str) -> tuple[np.ndarray, int]:
        """float32 ``(channels, n)`` and the sample rate. Raises FileNotFoundError when it's gone."""
        path = self._master(audio_id)
        if path is None:
            raise FileNotFoundError(f"audio {audio_id} is gone")
        data, sr = sf.read(path, dtype="float32", always_2d=True)
        return np.ascontiguousarray(data.T), int(sr)

    def stream_path(self, audio_id: str) -> Path | None:
        """A 16-bit integer-PCM WAV of the master (fmt tag 1), created on first use; None if unknown."""
        if not self.exists(audio_id):
            return None
        path = self.stream_dir / f"{audio_id}.wav"
        if path.is_file():
            try:  # recently played: pruned last. Only the access time moves, so the file's ETag stays the same.
                os.utime(path, (time.time(), path.stat().st_mtime))
            except OSError:
                pass
            return path
        audio, sr = self.load(audio_id)
        tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.part")
        tmp.write_bytes(wav_bytes(audio, sr, "PCM_16"))
        os.replace(tmp, path)
        self._prune_streams(keep=path)
        return path

    def _prune_streams(self, keep: Path) -> None:
        """Drop the least recently played stream copies beyond the budget (masters are untouched)."""
        entries = []
        for p in self.stream_dir.glob("*.wav"):
            try:
                st = p.stat()
            except OSError:
                continue
            entries.append((max(st.st_atime, st.st_mtime), st.st_size, p))
        total = 0
        for _, size, p in sorted(entries, key=lambda e: e[0], reverse=True):
            total += size
            if total > self.stream_budget and p != keep:
                p.unlink(missing_ok=True)

    def delete(self, *audio_ids: str | None) -> None:
        for audio_id in audio_ids:
            if self.valid(audio_id):
                for path in self._masters(audio_id):
                    path.unlink(missing_ok=True)
                (self.stream_dir / f"{audio_id}.wav").unlink(missing_ok=True)

    def bytes_used(self) -> int:
        return sum(p.stat().st_size for p in self.dir.rglob("*") if p.is_file())
