"""``fvwks``: render and inspect the FVWKS rack from the command line (S2 dev tool).

    fvwks render voice.wav -p pact --bpm 140 --bars 4 --key Am -o drop.wav --dry drop_dry.wav
    fvwks render fixtures/sources/we_are__am_fenrir.source.json -p legion \\
        --stack fixtures/sources/we_are__am_michael.source.json --stack fixtures/sources/we_are__bm_george.source.json
    fvwks presets | fvwks rack

The library stays pure DSP; this module is the only place fvwks_fx touches files. WAVs are written as integer
PCM with format tag 1 (CDJs reject WAVE_FORMAT_EXTENSIBLE); .aif/.aiff go through pedalboard.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import time
from pathlib import Path

import numpy as np

from fvwks_contracts.models import Peaks, RenderRequest, SourceInfo
from fvwks_contracts.seam import ENGINE_SR, Source

from . import api
from .dsp import to_mono


def read_audio(path: Path) -> tuple[np.ndarray, int]:
    from pedalboard.io import AudioFile

    with AudioFile(str(path)) as f:
        return f.read(f.frames).astype(np.float32), int(f.samplerate)


def write_wav24(path: Path, x: np.ndarray, sr: int) -> None:
    """24-bit integer PCM WAV, canonical 44-byte header, fmt tag 1."""
    a = np.clip(np.asarray(x, dtype=np.float64), -1.0, 1.0 - 2.0**-23)
    ch, n = a.shape
    ints = np.round(a.T.reshape(-1) * 2.0**23).astype(np.int32)
    b = ints.astype("<i4").view(np.uint8).reshape(-1, 4)[:, :3].tobytes()
    header = b"RIFF" + struct.pack("<I", 36 + len(b)) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, ch, sr, sr * ch * 3, ch * 3, 24)
    header += b"data" + struct.pack("<I", len(b))
    path.write_bytes(header + b)


def write_audio(path: Path, x: np.ndarray, sr: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix.lower() in (".aif", ".aiff"):
        from pedalboard.io import AudioFile

        with AudioFile(str(path), "w", sr, x.shape[0], bit_depth=24) as f:
            f.write(np.ascontiguousarray(x, dtype=np.float32))
    else:
        write_wav24(path, x, sr)


def load_source(path: str, kind: str | None = None) -> Source:
    """A ``*.source.json`` (fixtures: segments + sibling .wav) or any audio file (one segment, resampled to 48 kHz)."""
    p = Path(path)
    if p.name.endswith(".source.json"):
        meta = json.loads(p.read_text())
        audio, sr = read_audio(p.with_name(p.name.replace(".source.json", ".wav")))
        segs = meta["segments"]
        k = kind or meta.get("kind", "tts")
    else:
        audio, sr = read_audio(p)
        segs = None
        meta = {"id": p.stem}
        k = kind or "recording"
    mono = to_mono(audio)
    if sr != ENGINE_SR:
        from fvwks_contracts.audio import resample

        mono = resample(mono, sr, ENGINE_SR)
    dur = mono.shape[1] / ENGINE_SR
    if segs is None:
        segs = [{"index": 0, "text": p.stem, "start_s": 0.0, "end_s": dur}]
    info = SourceInfo(id=str(meta.get("id", p.stem)), kind=k, script=meta.get("script"), script_hash=meta.get("script_hash"),
                      voice_id=meta.get("voice_id"), speed=meta.get("speed"), sample_rate=ENGINE_SR, duration_s=dur,
                      segments=segs, peaks=Peaks(buckets=1, duration_s=dur, min=[0.0], max=[0.0]), audio_id=p.stem,
                      created_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    return Source(info=info, audio=np.ascontiguousarray(mono, dtype=np.float32))


def build_request(a: argparse.Namespace) -> RenderRequest:
    preset = api.get_preset(a.preset)
    if preset is None:
        raise SystemExit(f"unknown preset {a.preset!r}; try: {', '.join(p.id for p in api.list_presets())}")
    bars = None if str(a.bars).lower() == "free" else int(a.bars)
    arrange = {"bpm": a.bpm, "bars": bars, "key": a.key, "beat_lock": a.beat_lock, "fit": a.fit}
    if a.first_word_beat is not None:
        arrange["first_word_beat"] = a.first_word_beat
    if a.tail_beats is not None:
        arrange["tail_beats"] = a.tail_beats
    master = {"mode": a.mode, "sample_rate": a.sr}
    if a.target is not None:
        master["target_lufs"] = a.target
    req = RenderRequest(source_id="cli", preset_id=preset.id, quality=a.quality, stems=a.stems)
    req = api.apply_hints(req, preset)
    macros = req.macros.model_copy(update={k: getattr(a, k) for k in ("depth", "grit", "machine", "space")
                                           if getattr(a, k) is not None})
    return req.model_copy(update={"macros": macros,
                                  "arrange": req.arrange.model_copy(update=arrange),
                                  "master": req.master.model_copy(update=master)})


def cmd_render(a: argparse.Namespace) -> int:
    main = load_source(a.input, a.kind)
    req = build_request(a)
    stack_files = list(a.stack or [])
    stack = [load_source(stack_files[i]) if i < len(stack_files) else None for i in range(len(req.stack or []))]
    t0 = time.perf_counter()
    out = api.render(main, stack, req)
    wall = (time.perf_counter() - t0) * 1000
    dst = Path(a.out or f"{Path(a.input).name.split('.')[0]}_{req.preset_id}.wav")
    write_audio(dst, out.audio, out.sample_rate)
    written = [str(dst)]
    if a.dry:
        write_audio(Path(a.dry), out.dry, out.sample_rate)
        written.append(a.dry)
    if a.stems and out.stems:
        for name, x in out.stems.items():
            p = dst.with_name(f"{dst.stem}_stem-{name}{dst.suffix}")
            write_audio(p, x, out.sample_rate)
            written.append(str(p))
    summary = {
        "files": written, "sample_rate": out.sample_rate, "n_samples": int(out.audio.shape[1]),
        "duration_s": round(out.audio.shape[1] / out.sample_rate, 4), "first_word_s": out.first_word_s, "tail_s": out.tail_s,
        "fit": out.fit.model_dump(), "loudness": out.loudness.model_dump(), "mask": out.mask.model_dump(),
        "segments": [s.model_dump() for s in out.segments], "warnings": out.warnings,
        "timings_ms": {**out.timings_ms, "wall": round(wall, 1)},
    }
    if a.json:
        print(json.dumps(summary, indent=2))
    else:
        ld = out.loudness
        print(f"{dst}  {summary['duration_s']} s  {out.audio.shape[1]} samples @ {out.sample_rate} Hz")
        print(f"  loudness: short-term max {ld.short_term_max_lufs} LUFS, integrated {ld.integrated_lufs} LUFS, "
              f"true peak {ld.true_peak_db} dBTP")
        print(f"  fit: {out.fit.status} - {out.fit.message}")
        print(f"  mask: {out.mask.level.upper()} ({out.mask.score:g}) - {'; '.join(out.mask.reasons)}")
        for w in out.warnings:
            print(f"  warning: {w}")
        print(f"  render {wall:.0f} ms")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="fvwks", description="FoxBox FVWKS rack (S2): render and inspect.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("render", help="render a voice through a preset onto the bar grid")
    r.add_argument("input", help="voice audio (wav/aiff/flac) or a fixtures *.source.json")
    r.add_argument("-p", "--preset", default="pact")
    r.add_argument("-o", "--out", help="output .wav (24-bit, fmt tag 1) or .aiff")
    r.add_argument("--dry", help="also write the level-matched dry A/B file")
    r.add_argument("--stack", action="append", help="STACK voice file (repeatable, in preset order)")
    r.add_argument("--kind", choices=["tts", "recording", "import"], help="source kind (drives the mask badge)")
    r.add_argument("--bpm", type=float, default=140.0)
    r.add_argument("--bars", default="4", help="1, 2, 4, 8, 16 or free")
    r.add_argument("--key", default="Am")
    r.add_argument("--fit", choices=["auto", "pad", "stretch"], default="auto")
    r.add_argument("--beat-lock", action="store_true")
    r.add_argument("--first-word-beat", type=float)
    r.add_argument("--tail-beats", type=float)
    r.add_argument("--quality", choices=["preview", "final"], default="final")
    r.add_argument("--mode", choices=["club", "bake", "custom"], default="club")
    r.add_argument("--target", type=float, help="LUFS target (club: short-term max, custom: integrated)")
    r.add_argument("--sr", type=int, choices=[44100, 48000], default=44100)
    for m in ("depth", "grit", "machine", "space"):
        r.add_argument(f"--{m}", type=float, help=f"{m.upper()} macro 0..1 (0.5 = preset as designed)")
    r.add_argument("--stems", action="store_true")
    r.add_argument("--json", action="store_true", help="print a JSON summary")
    r.set_defaults(func=cmd_render)
    sub.add_parser("presets", help="list factory presets").set_defaults(
        func=lambda a: print("\n".join(f"{p.id:8s} {p.name:8s} {p.description}" for p in api.list_presets())) or 0)
    sub.add_parser("rack", help="print the rack descriptor JSON").set_defaults(
        func=lambda a: print(api.rack_schema().model_dump_json(indent=2)) or 0)

    def _audition(a: argparse.Namespace) -> int:
        from . import audition

        return audition.main()

    sub.add_parser("audition", help="write the audition pack to <repo>/out/audition (needs the dev extra)").set_defaults(
        func=_audition)
    a = ap.parse_args(argv)
    return int(a.func(a) or 0)


if __name__ == "__main__":
    sys.exit(main())
