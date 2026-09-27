"""Render dry Kokoro fixture phrases (Step 0). Run:
uv run --no-project --python 3.12 --with mlx-audio --with soundfile python scripts/make_fixtures.py
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "fixtures" / "voices"
OUT.mkdir(parents=True, exist_ok=True)

MODEL_ID = "mlx-community/Kokoro-82M-bf16"
LINES = [
    ("we_are_guy_fvwks", "am_fenrir", "We are Guy Fawkes. Expect us."),
    ("remember_remember", "bm_george", "Remember, remember, the signal never dies."),
    ("hands_up", "am_michael", "Put your hands up for the transmission."),
    ("anonymizer_ref", "af_heart", "This is a test of the anonymizer. Nobody will know it is me."),
]


def main() -> int:
    from mlx_audio.tts.utils import load_model

    t0 = time.time()
    model = load_model(MODEL_ID)
    print(f"model loaded in {time.time() - t0:.1f}s", flush=True)
    meta = {"model": MODEL_ID, "speed": 0.9, "items": []}
    for name, voice, text in LINES:
        t1 = time.time()
        chunks, sr = [], 24000
        for r in model.generate(text=text, voice=voice, speed=0.9, lang_code=voice[0]):
            chunks.append(np.asarray(r.audio, dtype=np.float32).reshape(-1))
            sr = int(getattr(r, "sample_rate", sr) or sr)
        audio = np.concatenate(chunks)
        path = OUT / f"{name}.wav"
        sf.write(path, audio, sr, subtype="PCM_24")
        dur = len(audio) / sr
        gen = time.time() - t1
        peak = float(np.max(np.abs(audio)))
        print(f"{name}: {dur:.2f}s audio in {gen:.2f}s (RTF {gen / dur:.3f}), peak {peak:.3f}", flush=True)
        meta["items"].append({"file": f"voices/{name}.wav", "voice": voice, "text": text,
                              "sample_rate": sr, "duration_s": round(dur, 4), "peak": round(peak, 4)})
    (ROOT / "fixtures" / "fixtures.json").write_text(json.dumps(meta, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
