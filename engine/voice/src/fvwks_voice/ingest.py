"""Recorded or imported voice -> clean 48 kHz mono source with segments split on silence.

Steps:
1. Decode (WAV/AIFF/FLAC/MP3 via libsndfile), downmix, resample to 48 kHz.
2. 70 Hz high-pass (zero-phase, steep; also removes DC).
3. DeepFilterNet3 denoise at the requested strength (see denoise.py).
4. Trim leading and trailing silence, normalize to speech level, split on pauses of 250 ms or more. Trim and split
   listen to a 150 Hz-5 kHz copy with a noise-aware threshold, so rumble, hum, hiss and a stray mic bump don't count
   as voice.

The UI converts any other format with Web Audio before uploading.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from pathlib import PurePath

import numpy as np
import soundfile as sf

from .dsp import SR, fade, highpass, normalize_speech, resample, speech_band, speech_bounds, split_on_silence
from .denoise import get_denoiser
from .errors import VoiceError

SUPPORTED = ("wav", "aiff", "aif", "aifc", "flac", "mp3")
MAX_BYTES = 200 * 1024 * 1024
MAX_SECONDS = 600.0
HIGHPASS_HZ = 70.0
HIGHPASS_ORDER = 4  # through filtfilt: 35 Hz rumble -48 dB; a deep 85 Hz fundamental -1.7 dB (2nd order: -3.3 dB)
_FORMAT_HINT = {"mp3": "MP3", "wav": "WAV", "wave": "WAV", "aif": "AIFF", "aiff": "AIFF", "aifc": "AIFF",
                "flac": "FLAC"}
_HINT = "Use WAV, AIFF, FLAC or MP3 (the app converts other formats)."
_TRIM = dict(rel_db=-45.0, floor_db=-65.0, pad_start_s=0.03, pad_end_s=0.08, noise_margin_db=6.0, min_run_s=0.05,
             isolation_s=0.15)


@dataclass
class IngestResult:
    audio: np.ndarray  # mono float32 at SR
    regions: list[tuple[int, int]]  # speech regions [start, end) in samples
    source_sample_rate: int
    source_channels: int
    source_format: str
    source_duration_s: float
    gain_db: float = 0.0
    denoise: float = 0.0  # DeepFilterNet3 strength actually applied
    trimmed_start_s: float = 0.0
    trimmed_end_s: float = 0.0
    warnings: list[str] = field(default_factory=list)


def _decode(data: bytes, filename: str | None) -> tuple[np.ndarray, int, str]:
    ext = PurePath(filename).suffix.lower().lstrip(".") if filename else ""
    attempts: list[str | None] = [None]
    if ext in _FORMAT_HINT:
        attempts.append(_FORMAT_HINT[ext])
    last: Exception | None = None
    for fmt in attempts:
        try:
            with sf.SoundFile(io.BytesIO(data), format=fmt) if fmt else sf.SoundFile(io.BytesIO(data)) as f:
                x = f.read(dtype="float32", always_2d=True)
                return x, int(f.samplerate), str(f.format)
        except (sf.LibsndfileError, RuntimeError, TypeError, ValueError) as e:
            last = e
    raise VoiceError("unsupported_audio", f"Could not read {filename or 'the audio'}: {last}", _HINT, status=415)


def ingest_audio(data: bytes, filename: str | None = None, *, denoise: float = 0.0) -> IngestResult:
    """`denoise`: DeepFilterNet3 strength, 0 (off) to 1 (fully cleaned)."""
    if not data:
        raise VoiceError("audio_empty", "The uploaded file is empty.", _HINT)
    if len(data) > MAX_BYTES:
        raise VoiceError("audio_too_large", "The file is larger than 200 MB.", "Trim it before importing.",
                         status=413)
    x, sr, fmt = _decode(data, filename)
    n, channels = x.shape
    if n == 0:
        raise VoiceError("audio_empty", "The file contains no audio frames.", _HINT)
    dur = n / sr
    if dur > MAX_SECONDS:
        raise VoiceError("audio_too_long", f"The recording is {dur / 60:.1f} minutes long.",
                         f"Keep sources under {MAX_SECONDS / 60:.0f} minutes; drops are usually a few seconds.",
                         status=413)
    warnings: list[str] = []
    if not np.all(np.isfinite(x)):
        x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
        warnings.append("Replaced invalid (NaN/inf) samples with silence.")
    if float(np.mean(np.abs(x) >= 0.999)) > 0.001:
        warnings.append("The recording clips (samples at full scale); re-record a little quieter if you can.")

    mono = x.mean(axis=1, dtype=np.float64).astype(np.float32)
    audio = resample(mono, sr, SR)
    audio = highpass(audio, SR, HIGHPASS_HZ, order=HIGHPASS_ORDER)
    applied = 0.0
    raw = audio
    if denoise > 0:
        dn = get_denoiser()
        if dn.is_installed():
            audio = dn.enhance(audio, denoise)
            applied = float(min(1.0, denoise))
        else:
            warnings.append("The denoiser isn't installed, so this take wasn't cleaned (VOICES → Models).")
    # Find the speech on a speech-band copy, so rumble, hum or hiss that survives the high-pass isn't taken
    # for voice. A short isolated burst at either edge (mic bump, click) is ignored.
    detector = speech_band(audio, SR)
    bounds = speech_bounds(detector, SR, **_TRIM)
    if applied > 0:
        # A speech denoiser treats a steady tone, a chord or music as noise and fades it out. When the sound it
        # leaves is under half of what the raw take had, this isn't a voice take: keep it as recorded.
        raw_detector = speech_band(raw, SR)
        raw_bounds = speech_bounds(raw_detector, SR, **_TRIM)
        if raw_bounds is not None and (bounds is None or
                                       bounds[1] - bounds[0] < 0.5 * (raw_bounds[1] - raw_bounds[0])):
            audio, detector, bounds, applied = raw, raw_detector, raw_bounds, 0.0
            warnings.append("The denoiser would have removed most of this take (tones or music?), so it was kept "
                            "as recorded.")
    if bounds is None:
        raise VoiceError("no_speech", "No voice found: the file is silent or too quiet.",
                         "Check the input level and record again.")
    s0, s1 = bounds
    audio = fade(audio[s0:s1], SR, 0.005, 0.02)
    audio, gain_db = normalize_speech(audio, SR)
    detector = detector[s0:s1] * np.float32(10.0 ** (gain_db / 20.0))
    regions = split_on_silence(detector, SR) or [(0, len(audio))]
    return IngestResult(audio=audio, regions=regions, source_sample_rate=sr, source_channels=channels,
                        source_format=fmt, source_duration_s=dur, gain_db=gain_db, denoise=applied,
                        trimmed_start_s=s0 / SR, trimmed_end_s=max(0.0, dur - s1 / SR), warnings=warnings)
