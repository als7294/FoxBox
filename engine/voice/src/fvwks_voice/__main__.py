"""Dry-voice CLI for listening and debugging (run from engine/):

  uv run python -m fvwks_voice say "WE ARE GUY FVWKS | EXPECT *US*" --voice am_fenrir --stack am_michael,bm_george
  uv run python -m fvwks_voice parse "REMEMBER, REMEMBER [0.5] THE SIGNAL NEVER DIES | WE DO NOT FORGIVE | *EXPECT US*"
  uv run python -m fvwks_voice voices
  uv run python -m fvwks_voice ingest take.wav

`say` and `ingest` write 48 kHz / 24-bit WAVs plus a .json with the segments to --out (default out/voice).
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import soundfile as sf

from fvwks_contracts.models import TTSRequest

from . import api
from .errors import VoiceError


def _write(src, out: Path, stem: str) -> Path:
    out.mkdir(parents=True, exist_ok=True)
    wav = out / f"{stem}.wav"
    sf.write(wav, src.audio[0], src.info.sample_rate, subtype="PCM_24")
    wav.with_suffix(".json").write_text(src.info.model_dump_json(indent=2, exclude={"peaks"}) + "\n")
    return wav


def _slug(script: str) -> str:
    text = re.sub(r"\[[^\]]*\]|[*|]", " ", script)  # drop pause tags and markers
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "line"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m fvwks_voice", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("say", help="synthesize a script (dry)")
    s.add_argument("script")
    s.add_argument("--voice", default="am_fenrir")
    s.add_argument("--stack", default="", help="comma-separated extra voices on the same script")
    s.add_argument("--speed", type=float, default=0.9)
    s.add_argument("--bpm", type=float, default=None)
    s.add_argument("--out", type=Path, default=Path("out/voice"))
    pr = sub.add_parser("parse", help="show segments, TTS text and flags without synthesizing")
    pr.add_argument("script")
    sub.add_parser("voices", help="list voices")
    ing = sub.add_parser("ingest", help="clean up a recording and split it into segments")
    ing.add_argument("file", type=Path)
    ing.add_argument("--out", type=Path, default=Path("out/voice"))
    a = p.parse_args(argv)

    try:
        if a.cmd == "voices":
            for v in api.list_voices():
                star = "*" if v.recommended else " "
                print(f"{star} {v.id:20} {v.name:9} {v.language} {v.gender:6} {', '.join(v.tags)}")
        elif a.cmd == "parse":
            print(api.preview_script(a.script).model_dump_json(indent=2))
        elif a.cmd == "say":
            api.warm_up()
            for voice in [a.voice] + [v for v in a.stack.split(",") if v]:
                vid = voice if ":" in voice else f"kokoro:{voice}"
                src = api.synthesize(TTSRequest(script=a.script, voice_id=vid, speed=a.speed, bpm=a.bpm))
                wav = _write(src, a.out, f"{_slug(a.script)}__{vid.split(':')[-1]}")
                segs = "  ".join(f"[{g.start_s:.2f}-{g.end_s:.2f}]" for g in src.info.segments)
                print(f"{wav}  {src.info.duration_s:.2f}s  {segs}")
        elif a.cmd == "ingest":
            src = api.ingest(a.file.read_bytes(), a.file.name)
            wav = _write(src, a.out, f"{a.file.stem}__clean")
            print(f"{wav}  {src.info.duration_s:.2f}s  {len(src.info.segments)} segments")
    except VoiceError as e:
        print(f"error [{e.code}]: {e.message}" + (f"\n  hint: {e.hint}" if e.hint else ""), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
