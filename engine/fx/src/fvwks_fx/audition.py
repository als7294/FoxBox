"""Audition pack: every fixture through every preset, macro sweeps, dry references, spectrograms and
measurements, written to ``<repo>/out/audition/`` (git-ignored). Run: ``uv run fvwks audition``.

S2 can't listen, so everything here is also measured (loudness, true peak, exact length, measured pitch,
spectral centroid, mono compatibility); the user judges by ear.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from fvwks_contracts.models import Arrange, Master, RenderRequest

from . import api
from .cli import load_source, write_audio
from .master import integrated_lufs, short_term_max, true_peak
from .modules.stereo import mono_compat

ROOT = Path(__file__).resolve().parents[4]
FIX = ROOT / "fixtures"
OUT = ROOT / "out" / "audition"
MACROS = ("depth", "grit", "machine", "space")
SWEEP_STEPS = (0.0, 0.25, 0.5, 0.75, 1.0)
PRESET_IDS = ("pact", "legion", "abyss", "unit", "ghost", "signal", "raw")
SWEEPS = [(pid, m) for pid in PRESET_IDS for m in MACROS]  # every macro on every preset


@dataclass
class Input:
    key: str
    label: str
    path: Path
    kind: str | None
    bars: int
    beat_lock: bool = False
    stack: tuple[Path, ...] = ()


def inputs() -> list[Input]:
    s, v = FIX / "sources", FIX / "voices"
    return [
        Input("we_are", "WE ARE GUY FVWKS | EXPECT *US* (am_fenrir, real STACK voices)", s / "we_are__am_fenrir.source.json",
              None, 4, False, (s / "we_are__am_michael.source.json", s / "we_are__bm_george.source.json")),
        Input("remember", "REMEMBER, REMEMBER [0.5] ... | *EXPECT US* (am_fenrir, Beat-Lock, real STACK voices)",
              s / "remember__am_fenrir.source.json", None, 8, True,
              (s / "remember__am_michael.source.json", s / "remember__bm_george.source.json")),
        Input("we_are_guy_fvwks", "We are Guy Fawkes. Expect us. (am_fenrir)", v / "we_are_guy_fvwks.wav", "tts", 4),
        Input("remember_remember", "Remember, remember, the signal never dies. (bm_george)", v / "remember_remember.wav", "tts", 4),
        Input("hands_up", "Put your hands up for the transmission. (am_michael)", v / "hands_up.wav", "tts", 4),
        Input("anonymizer_ref", "This is a test of the anonymizer... (af_heart, treated as a RECORDING)",
              v / "anonymizer_ref.wav", "recording", 4),
    ]


# --------------------------------------------------------------------------- measurement


def measured_f0(x: np.ndarray, sr: int) -> float:
    import pyworld as pw
    from scipy.signal import resample_poly

    mono = x.mean(axis=0).astype(np.float64)
    lo = resample_poly(mono, 16000, sr)
    f0, _ = pw.harvest(lo, 16000, f0_floor=40.0, f0_ceil=700.0, frame_period=10.0)
    v = f0[f0 > 0]
    return float(np.median(v)) if v.size > 10 else 0.0


def centroid(x: np.ndarray, sr: int) -> float:
    spec = np.abs(np.fft.rfft(x.mean(axis=0))) ** 2
    f = np.fft.rfftfreq(x.shape[1], 1 / sr)
    return float(np.sum(f * spec) / max(np.sum(spec), 1e-20))


def metrics(out, wall_ms: float, f0_in: float) -> dict:
    x, sr = out.audio, out.sample_rate
    f0 = measured_f0(x, sr)
    return {
        "n_samples": int(x.shape[1]), "sample_rate": sr, "duration_s": round(x.shape[1] / sr, 4),
        "short_term_max_lufs": round(short_term_max(x, sr), 2), "integrated_lufs": round(integrated_lufs(x, sr), 2),
        "true_peak_dbtp": round(true_peak(x, sr), 2), "f0_median_hz": round(f0, 1),
        "f0_shift_st": round(12 * np.log2(f0 / f0_in), 2) if f0 > 0 and f0_in > 0 else None,
        "centroid_hz": round(centroid(x, sr)), "mono": {k: round(v, 3) for k, v in mono_compat(x).items()},
        "fit": out.fit.status, "fit_message": out.fit.message, "mask": out.mask.level, "mask_score": out.mask.score,
        "mask_reasons": out.mask.reasons, "first_word_s": out.first_word_s, "tail_s": out.tail_s,
        "warnings": out.warnings, "render_ms": round(wall_ms), "no_nans": bool(np.all(np.isfinite(x))),
    }


# --------------------------------------------------------------------------- spectrograms


def spectrogram(path: Path, x: np.ndarray, sr: int, title: str, bpm: float, first_word_s: float | None = None,
                marks: list[float] | None = None) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    mono = x.mean(axis=0)
    fig, ax = plt.subplots(figsize=(12, 3.6), dpi=100)
    nfft, hop = 2048, 256
    with np.errstate(divide="ignore"):
        ax.specgram(mono + 1e-9, NFFT=nfft, Fs=sr, noverlap=nfft - hop, cmap="magma", scale="dB", vmin=-120, vmax=-20)
    ax.set_yscale("symlog", linthresh=200)
    ax.set_ylim(40, 16000)
    ax.set_yticks([50, 100, 200, 500, 1000, 2000, 5000, 10000])
    ax.set_yticklabels(["50", "100", "200", "500", "1k", "2k", "5k", "10k"])
    beat = 60.0 / bpm
    dur = x.shape[1] / sr
    for i in range(int(dur / beat) + 1):
        ax.axvline(i * beat, color="white", alpha=0.35 if i % 4 == 0 else 0.1, lw=1.2 if i % 4 == 0 else 0.6)
    if first_word_s is not None:
        ax.axvline(first_word_s, color="#39d353", lw=1.4)
    for m in marks or []:
        ax.axvline(m, color="#ff5a36", lw=1.2, ls="--")
    ax.set_xlim(0, dur)
    ax.set_xlabel("seconds (bars bright, beats faint; green = first word)")
    ax.set_ylabel("Hz")
    ax.set_title(title, fontsize=10, loc="left")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


# --------------------------------------------------------------------------- rendering


def _request(preset_id: str, inp: Input, mode: str = "club", **macros: float) -> RenderRequest:
    pre = api.get_preset(preset_id)
    req = api.apply_hints(RenderRequest(source_id=inp.key, preset_id=preset_id, quality="final",
                                        arrange=Arrange(bpm=140, bars=inp.bars, key="Am", beat_lock=inp.beat_lock),
                                        master=Master(mode=mode)), pre)
    if req.arrange.first_word_beat:
        # keep the requested pre-roll but make sure the phrase still fits after it
        req = req.model_copy(update={"arrange": req.arrange.model_copy(update={"bars": max(inp.bars, 4)})})
    if macros:
        req = req.model_copy(update={"macros": req.macros.model_copy(update=macros)})
    return req


def _render(src, stack_srcs, req):
    pre = api.get_preset(req.preset_id)
    stack = [stack_srcs[i] if (sv.voice_id and i < len(stack_srcs)) else None for i, sv in enumerate(pre.stack)]
    t = time.perf_counter()
    out = api.render(src, stack, req)
    if out.fit.status == "overflow" and out.fit.suggested_bars:
        req = req.model_copy(update={"arrange": req.arrange.model_copy(update={"bars": out.fit.suggested_bars})})
        out = api.render(src, stack, req)
    return out, (time.perf_counter() - t) * 1000, req


def run(out_dir: Path = OUT, presets: list[str] | None = None, sweeps: bool = True, log=print) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "presets").mkdir(exist_ok=True)
    (out_dir / "dry").mkdir(exist_ok=True)
    (out_dir / "sweeps").mkdir(exist_ok=True)
    (out_dir / "bake").mkdir(exist_ok=True)
    preset_ids = presets or [p.id for p in api.list_presets()]
    results: dict = {"generated": time.strftime("%Y-%m-%d %H:%M:%S"), "renders": [], "sweeps": []}
    srcs = {}
    for inp in inputs():
        src = load_source(str(inp.path), inp.kind)
        stack = [load_source(str(p)) for p in inp.stack]
        for s in [src, *stack]:
            api.analyze(s)
        srcs[inp.key] = (inp, src, stack)
        f0_in = measured_f0(src.audio, 48000)
        for pid in preset_ids:
            req = _request(pid, inp)
            out, ms, req = _render(src, stack, req)
            name = f"{inp.key}__{pid.upper()}"
            write_audio(out_dir / "presets" / f"{name}.wav", out.audio, out.sample_rate)
            m = metrics(out, ms, f0_in)
            m.update(input=inp.key, preset=pid, bars=req.arrange.bars, bpm=req.arrange.bpm, file=f"presets/{name}.wav")
            spectrogram(out_dir / "presets" / f"{name}.png", out.audio, out.sample_rate,
                        f"{pid.upper()} | {inp.label} | {m['short_term_max_lufs']} LUFS-S max, {m['true_peak_dbtp']} dBTP, "
                        f"mask {m['mask'].upper()}", req.arrange.bpm, out.first_word_s,
                        [s.start_s for s in out.segments if s.flags.throw])
            results["renders"].append(m)
            log(f"  {name}: {m['short_term_max_lufs']} LUFS  TP {m['true_peak_dbtp']}  {m['n_samples']} smp  "
                f"{m['fit']}  {m['mask']}  {m['render_ms']} ms")
            # BAKE-IN (peaks at -6 dBFS, no limiter): the voice design without club limiting colouring it
            bout, bms, breq = _render(src, stack, _request(pid, inp, mode="bake"))
            write_audio(out_dir / "bake" / f"{name}.wav", bout.audio, bout.sample_rate)
            spectrogram(out_dir / "bake" / f"{name}.png", bout.audio, bout.sample_rate,
                        f"{pid.upper()} BAKE-IN (-6 dBFS peaks, no limiter) | {inp.label}", breq.arrange.bpm,
                        bout.first_word_s, [s.start_s for s in bout.segments if s.flags.throw])
            if pid == "pact":
                write_audio(out_dir / "dry" / f"{inp.key}__DRY.wav", out.dry, out.sample_rate)
                spectrogram(out_dir / "dry" / f"{inp.key}__DRY.png", out.dry, out.sample_rate,
                            f"DRY (level-matched A/B) | {inp.label}", req.arrange.bpm, out.first_word_s)
    if sweeps:
        inp, src, stack = srcs["we_are"]
        f0_in = measured_f0(src.audio, 48000)
        for pid, macro in SWEEPS:
            parts, info = [], []
            for v in SWEEP_STEPS:
                req = _request(pid, inp, **{macro: v})
                out, ms, req = _render(src, stack, req)
                parts.append(out.audio)
                resolved = {f"{t.module}.{t.param}": next(m.params.get(t.param) for m in out.resolved_chain.modules
                                                          if m.id == t.module)
                            for t in getattr(api.get_preset(pid).macro_map, macro)}
                m = metrics(out, ms, f0_in)
                m.update(preset=pid, macro=macro, value=v, resolved=resolved)
                info.append(m)
            sr = out.sample_rate
            gap = np.zeros((2, int(0.6 * sr)), np.float32)
            strip = np.concatenate([p for part in parts for p in (part, gap)], axis=1)
            name = f"{pid.upper()}__{macro.upper()}_sweep"
            write_audio(out_dir / "sweeps" / f"{name}.wav", strip, sr)
            starts, t = [], 0.0
            for part in parts:
                starts.append(t)
                t += (part.shape[1] + gap.shape[1]) / sr
            spectrogram(out_dir / "sweeps" / f"{name}.png", strip, sr,
                        f"{pid.upper()} {macro.upper()} sweep: " + "  ".join(f"{v:g}" for v in SWEEP_STEPS)
                        + " (red = next step)", 140.0, None, starts[1:])
            results["sweeps"].append({"preset": pid, "macro": macro, "file": f"sweeps/{name}.wav", "steps": info,
                                      "step_starts_s": [round(s, 3) for s in starts]})
            log(f"  {name}: " + ", ".join(f"{i['value']:g}->{i['short_term_max_lufs']}LUFS/{i['f0_median_hz']}Hz"
                                          for i in info))
    (out_dir / "measurements.json").write_text(json.dumps(results, indent=2) + "\n")
    (out_dir / "README.md").write_text(readme(results))
    return results


# --------------------------------------------------------------------------- README


RECIPES = {
    "pact": "Pitch -9, formant -5, sub -12 st at about -8 dB, 2 TTS stack voices at -8/-10 st (+-40 %, -14 dB), vocoder 0.15, parallel tube->hard clip 45 %, OTT 30 %, HPF 50 / -3 dB @ 300 / LPF 8k, dark plate ~1 s at 15 %, 1/8 slap.",
    "legion": "Pitch -3, monotone 0.8 on the key root, 2 stack voices at -6 dB, ring mod 60 Hz 25 %, ~10-bit crush, GSM codec, noise bed -30 dB, band-pass 300-3400 + 4 dB @ 1.2k, squelch at start/end.",
    "abyss": "Pitch -12, formant -7, growl 0.6, layers at -7 and -12, heavy tube drive, phaser 0.3, LPF 8k, dark hall 2.5 s at 25 %.",
    "unit": "Monotone on the key root, 32-band saw vocoder (root + fifth) at 0.8, ring mod 60 Hz 35 %, hard clip, HPF 80 / LPF 10k, 1/16 slapback, no reverb.",
    "ghost": "Pitch -2, full whisper, sub at about -15 dB, HPF 180, 1-bar reverse swell (first word on beat 4), hall 6 s at 40 %, dotted-1/4 ping-pong.",
    "signal": "Pitch -5, formant -2, ~6-bit crush at 8 kHz, frequency shift +200 Hz, 1/16 x4 stutter, 1-beat tape-stop, gate.",
    "raw": "Prep, pitch -4, formant -4, McAdams 0.8. Everything else off at the default macros (GRIT/SPACE fade in above 0.5).",
}


def readme(res: dict) -> str:
    rows = res["renders"]
    lines = [
        "# FoxBox: S2 audition pack",
        "",
        f"Generated {res['generated']} by `uv run fvwks audition` (engine/fx). Final quality: 44.1 kHz / 24-bit WAV (fmt tag 1), "
        "stereo, CLUB master (short-term max -7 LUFS, true peak <= -1 dBTP), 140 BPM, key Am.",
        "",
        "I can't listen, so every file below is measured. You judge by ear: tell S2 what to change per preset "
        "(e.g. \"PACT: less sub, darker verb\") and the preset JSONs get retuned.",
        "",
        "## What's here",
        "- `presets/<input>__<PRESET>.wav` + `.png`: each fixture through each of the 7 presets at the default macros (0.5 = the preset as designed).",
        "- `bake/<input>__<PRESET>.wav` + `.png`: the same renders in BAKE-IN mode (peaks at -6 dBFS, no limiter). "
        "**Judge the voice design here**: club mode's heavy limiting (~10 dB at -7 LUFS) colours everything.",
        "- `dry/<input>__DRY.wav`: the arranged, level-matched dry voice for A/B (same grid as the renders).",
        "- `sweeps/<PRESET>__<MACRO>_sweep.wav`: every macro on every preset swept 0, 0.25, 0.5, 0.75, 1.0 on `we_are` "
        "(0.6 s gaps; red lines in the PNG mark each step; 0.5 = the preset as designed).",
        "- `measurements.json`: everything measured, per file.",
        "",
        "Spectrograms: log frequency 40 Hz to 16 kHz; bright vertical lines = bars, faint = beats, green = first word, red dashed = throw words or sweep steps.",
        "",
        "## What to listen for",
        "- **Identity**: does the voice still sound like the TTS speaker? PACT/ABYSS/UNIT should not.",
        "- **Collage**: in PACT and LEGION on `we_are`/`remember`, the two extra TTS voices should sit under the main voice (\"robotic collage\"), not flam.",
        "- **Throws**: \"US\" in `we_are` and \"EXPECT US\" in `remember` get an extra delay/verb tail.",
        "- **Grid**: the first word hits the downbeat (GHOST: beat 4 after the reverse swell); `remember` uses Beat-Lock so each `|` chunk lands on a beat.",
        "- **Loudness**: all at club level (-7 LUFS short-term max). BAKE-IN / CUSTOM modes are available in the CLI (`--mode bake`).",
        "",
        "## Presets (starting values from the plan; tune by ear)",
    ]
    for pid, text in RECIPES.items():
        lines.append(f"- **{pid.upper()}**: {text}")
    lines += ["", "## Measurements", "",
              "F0 is Harvest on the full mix (median of voiced frames); F0 shift compares it with the dry voice. It is only "
              "meaningful for lightly layered presets: with growl (period doubling), vocoder chords (UNIT's fifth reads "
              "as the 55 Hz dyad root), whisper (GHOST) or dense stacks it reports the dominant periodicity, not the pitch.",
              "",
              "| file | bars | short-term max LUFS | integrated | true peak dBTP | measured F0 (Hz) | F0 shift (st) | centroid (Hz) | mono loss (dB) | fit | mask |",
              "|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        lines.append(f"| `{r['file']}` | {r['bars']} | {r['short_term_max_lufs']} | {r['integrated_lufs']} | {r['true_peak_dbtp']} | "
                     f"{r['f0_median_hz'] or '-'} | {r['f0_shift_st'] if r['f0_shift_st'] is not None else '-'} | {r['centroid_hz']} | "
                     f"{r['mono']['mono_loss_db']} | {r['fit']} | {r['mask']} |")
    if res.get("sweeps"):
        lines += ["", "## Macro sweeps (resolved values per step)", ""]
        for sw in res["sweeps"]:
            lines.append(f"**{sw['preset'].upper()} {sw['macro'].upper()}** (`{sw['file']}`)")
            lines.append("")
            keys = list(sw["steps"][0]["resolved"])
            lines.append("| step | " + " | ".join(keys) + " | LUFS-S | F0 (Hz) | centroid (Hz) |")
            lines.append("|---" * (len(keys) + 4) + "|")
            for st in sw["steps"]:
                lines.append(f"| {st['value']:g} | " + " | ".join(str(st['resolved'][k]) for k in keys)
                             + f" | {st['short_term_max_lufs']} | {st['f0_median_hz']} | {st['centroid_hz']} |")
            lines.append("")
    lines += [
        "## Mask badge on a recording",
        "`anonymizer_ref` is marked as a *recording* (not TTS) to show the badge: RAW scores MEDIUM, PACT scores STRONG, "
        "a pitch-only chain would score WEAK. TTS sources always show SYNTHETIC. This is a heuristic, not forensic protection.",
        "",
        "## Known limits",
        "- Tuned by measurement only. Levels between layers (sub/stack/ghost), reverb/delay amounts and drive colour are the first things to adjust by ear.",
        "- Previews (in the app) run the rack at 24 kHz and may differ slightly from these finals above 12 kHz.",
    ]
    return "\n".join(lines) + "\n"


def main() -> int:
    t = time.perf_counter()
    print(f"writing audition pack to {OUT}")
    run(OUT)
    size = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    print(f"done in {time.perf_counter() - t:.0f} s, {size / 1e6:.0f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
