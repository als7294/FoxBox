"""Shared fixtures: contract ``Source`` objects built from the repo's fixture audio (read-only)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from pedalboard.io import AudioFile
from scipy.signal import resample_poly

from fvwks_contracts.models import Peaks, SourceInfo
from fvwks_contracts.seam import Source

ROOT = Path(__file__).resolve().parents[3]
FIX = ROOT / "fixtures"
SR = 48000


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with AudioFile(str(path)) as f:
        return f.read(f.frames).astype(np.float32), int(f.samplerate)


def _info(meta: dict, sr: int, n: int, kind: str | None = None) -> SourceInfo:
    return SourceInfo(
        id=meta["id"], kind=kind or meta.get("kind", "tts"), script=meta.get("script"), script_hash=meta.get("script_hash"),
        voice_id=meta.get("voice_id"), speed=meta.get("speed"), sample_rate=sr, duration_s=n / sr,
        segments=meta["segments"], peaks=Peaks(buckets=1, duration_s=n / sr, min=[0.0], max=[0.0]), audio_id="test",
        created_at="2026-09-26T00:00:00Z",
    )


def load_source(name: str, kind: str | None = None) -> Source:
    """``fixtures/sources/<name>.wav`` + ``.source.json`` (48 kHz, multi-segment, 1:1 across voices)."""
    meta = json.loads((FIX / "sources" / f"{name}.source.json").read_text())
    audio, sr = read_wav(FIX / "sources" / f"{name}.wav")
    return Source(info=_info(meta, sr, audio.shape[1], kind), audio=audio[:1])


def load_voice(name: str, kind: str = "tts") -> Source:
    """``fixtures/voices/<name>.wav`` (24 kHz, single segment) resampled to 48 kHz."""
    a24, sr = read_wav(FIX / "voices" / f"{name}.wav")
    a = resample_poly(a24[:1], SR, sr, axis=-1).astype(np.float32)
    n = a.shape[1]
    meta = {"id": name, "kind": kind, "segments": [{"index": 0, "text": name, "start_s": 0.0, "end_s": n / SR}]}
    return Source(info=_info(meta, SR, n, kind), audio=a)


def concat_sources(names: list[str], gap_s: float = 0.3) -> Source:
    """Several fixture sources joined into one longer line (segments re-indexed and offset)."""
    srcs = [load_source(n) for n in names]
    parts, segs, t = [], [], 0.0
    for s in srcs:
        for seg in s.info.segments:
            d = seg.model_dump()
            d.update(index=len(segs), start_s=seg.start_s + t, end_s=seg.end_s + t)
            segs.append(d)
        parts += [s.audio[0], np.zeros(int(gap_s * SR), np.float32)]
        t += s.audio.shape[1] / SR + gap_s
    a = np.concatenate(parts)[None, :]
    meta = {**srcs[0].info.model_dump(), "id": "+".join(names), "segments": segs}
    return Source(info=_info(meta, SR, a.shape[1]), audio=a)


@pytest.fixture(scope="session")
def we_are() -> Source:
    return load_source("we_are__am_fenrir")


@pytest.fixture(scope="session")
def we_are_stack() -> list[Source]:
    return [load_source("we_are__am_michael"), load_source("we_are__bm_george")]


@pytest.fixture(scope="session")
def remember() -> Source:
    return load_source("remember__am_fenrir")


@pytest.fixture(scope="session")
def ten_second_line() -> Source:
    return concat_sources(["remember__am_fenrir", "we_are__am_fenrir"])


@pytest.fixture(scope="session")
def ten_second_stack() -> list[Source]:
    return [concat_sources(["remember__am_michael", "we_are__am_michael"]),
            concat_sources(["remember__bm_george", "we_are__bm_george"])]


@pytest.fixture(scope="session")
def recording() -> Source:
    """A 'recorded' (non-TTS) voice: the anonymizer reference phrase marked as a recording."""
    return load_voice("anonymizer_ref", kind="recording")


@pytest.fixture(scope="session")
def loaders():
    """Helper functions for tests (importlib mode can't import from conftest)."""
    return {"source": load_source, "voice": load_voice, "concat": concat_sources, "wav": read_wav}
