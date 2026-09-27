"""Render multi-segment, multi-voice fixtures (48 kHz) so S2 can build STACK alignment and S1 has markup references.
uv run --no-project --python 3.12 --with mlx-audio --with "misaki[en]" --with soundfile --with scipy python scripts/make_stack_fixtures.py
Segment text is pre-normalized here (lexicon + ALL-CAPS lower-casing done by hand) so fixtures don't depend on S1.
"""
import hashlib
import json
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "fixtures" / "sources"
OUT.mkdir(parents=True, exist_ok=True)
SR = 48000
VOICES = ["am_fenrir", "am_michael", "bm_george"]
SCRIPTS = {
    "we_are": {
        "script": "WE ARE GUY FVWKS | EXPECT *US*",
        "segments": [
            {"say": "we are Guy Fawkes", "text": "WE ARE GUY FVWKS", "flags": {"beat_break": True}},
            {"say": "expect us", "text": "EXPECT *US*", "flags": {"throw": True}},
        ],
    },
    "remember": {
        "script": "REMEMBER, REMEMBER [0.5] THE SIGNAL NEVER DIES | WE DO NOT FORGIVE | *EXPECT US*",
        "segments": [
            {"say": "remember, remember", "text": "REMEMBER, REMEMBER", "flags": {"pause_after_s": 0.5}},
            {"say": "the signal never dies", "text": "THE SIGNAL NEVER DIES", "flags": {"beat_break": True}},
            {"say": "we do not forgive", "text": "WE DO NOT FORGIVE", "flags": {"beat_break": True}},
            {"say": "expect us", "text": "*EXPECT US*", "flags": {"throw": True}},
        ],
    },
}


def main() -> None:
    from mlx_audio.tts.utils import load_model

    model = load_model("mlx-community/Kokoro-82M-bf16")
    for sid, spec in SCRIPTS.items():
        script_hash = hashlib.sha256(spec["script"].encode()).hexdigest()[:16]
        for voice in VOICES:
            parts, segs, t = [], [], 0.0
            for i, seg in enumerate(spec["segments"]):
                chunks = [np.asarray(r.audio, dtype=np.float32).reshape(-1)
                          for r in model.generate(text=seg["say"], voice=voice, speed=0.9, lang_code=voice[0])]
                a = resample_poly(np.concatenate(chunks), 2, 1).astype(np.float32)  # 24k -> 48k
                start = t
                parts.append(a)
                t += len(a) / SR
                flags = {"throw": False, "beat_break": False, "pause_after_s": 0.0, "pause_after_beats": 0.0}
                flags.update(seg["flags"])
                segs.append({"index": i, "text": seg["text"], "start_s": round(start, 5), "end_s": round(t, 5), "flags": flags})
                gap = flags["pause_after_s"] or (0.08 if i < len(spec["segments"]) - 1 else 0.0)
                if gap:
                    parts.append(np.zeros(int(gap * SR), dtype=np.float32))
                    t += gap
            audio = np.concatenate(parts)
            name = f"{sid}__{voice}"
            sf.write(OUT / f"{name}.wav", audio, SR, subtype="PCM_24")
            meta = {"id": name, "kind": "tts", "script": spec["script"], "script_hash": script_hash,
                    "voice_id": f"kokoro:{voice}", "speed": 0.9, "sample_rate": SR,
                    "duration_s": round(len(audio) / SR, 5), "segments": segs}
            (OUT / f"{name}.source.json").write_text(json.dumps(meta, indent=2) + "\n")
            print(name, meta["duration_s"], "s", len(segs), "segments", flush=True)


if __name__ == "__main__":
    main()
