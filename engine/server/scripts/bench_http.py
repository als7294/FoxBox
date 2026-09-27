"""End-to-end HTTP benchmark of the real engine (owned by S3).

    cd engine && uv run --all-packages python server/scripts/bench_http.py [--out report.json] [--quick]

Starts `fvwks-engine` on a throwaway data dir, waits for READY and the voice warm-up, then measures over HTTP:
TTS (cold and cached), preview renders per preset x bars (first and warm), final render + auto-export, WORLD
analysis reuse, and preview latency while a Setlist batch runs. Prints a markdown report.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

PRESETS = ["pact", "legion", "abyss", "unit", "ghost", "signal", "raw"]
SCRIPTS = [
    "WE ARE GUY FVWKS | EXPECT *US*",
    "REMEMBER, REMEMBER [0.5] THE SIGNAL NEVER DIES | WE DO NOT FORGIVE | *EXPECT US*",
    "Put your hands up | for the *transmission*",
    "This is not a drill | we are already inside",
    "No names | no faces | only the *signal*",
    "Lights down | volume up | we are *legion*",
    "They told you to forget | we remember",
    "Hold the line | the drop is *coming*",
]
TOKEN = "bench-token"


class Engine:
    def __init__(self, root: Path):
        self.root = root
        env = {**os.environ, "PYTHONUNBUFFERED": "1"}
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "fvwks_server.main", "--port", "0", "--token", TOKEN, "--data-dir",
             str(root / "data"), "--export-dir", str(root / "exports"), "--exit-with-parent"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, text=True)
        line = self.proc.stdout.readline()
        m = re.fullmatch(r"FVWKS_ENGINE_READY port=(\d+)\n", line)
        if not m:
            raise RuntimeError(f"engine did not start: {line!r}")
        self.base = f"http://127.0.0.1:{m.group(1)}"

    def call(self, method: str, path: str, body=None, timeout: float = 300):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                raw = res.read()
        except urllib.error.HTTPError as err:
            raise RuntimeError(f"{method} {path} → {err.code}: {err.read()[:300]!r}") from None
        ms = (time.perf_counter() - t0) * 1000
        return (json.loads(raw) if raw and raw[:1] in b"{[" else raw), ms

    def wait_ready(self, timeout: float = 300) -> float:
        t0 = time.perf_counter()
        while time.perf_counter() - t0 < timeout:
            health, _ = self.call("GET", "/api/health")
            if health["state"] == "ready":
                return time.perf_counter() - t0
            if health["state"] == "error":
                raise RuntimeError(health["message"])
            time.sleep(0.1)
        raise TimeoutError("engine never became ready")

    def wait_analysis(self, source_id: str, timeout: float = 60) -> float:
        t0 = time.perf_counter()
        while time.perf_counter() - t0 < timeout:
            src, _ = self.call("GET", f"/api/sources/{source_id}")
            if src["analysis_state"] in ("done", "error"):
                return time.perf_counter() - t0
            time.sleep(0.02)
        raise TimeoutError("analysis never finished")

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.stdin.close()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def pct(values: list[float], p: float) -> float:
    if not values:
        return float("nan")
    ordered = sorted(values)
    k = (len(ordered) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)


def summary(values: list[float]) -> dict:
    return {"n": len(values), "p50": round(pct(values, 0.5)), "p95": round(pct(values, 0.95)),
            "max": round(max(values)) if values else None}


def render_body(source_id: str, preset: str, bars: int, quality: str = "preview", depth: float | None = None):
    body = {"source_id": source_id, "preset_id": preset, "quality": quality,
            "arrange": {"bpm": 140, "bars": bars, "key": "Am"}}
    if depth is not None:
        body["macros"] = {"depth": depth, "grit": 0.5, "machine": 0.5, "space": 0.5}
    return body


def run(quick: bool) -> dict:
    root = Path(tempfile.mkdtemp(prefix="fvwks-bench-"))
    eng = Engine(root)
    report: dict = {}
    try:
        report["warm_up_s"] = round(eng.wait_ready(), 2)
        health, _ = eng.call("GET", "/api/health")
        report["engines"] = {"voice": health["voice_engine"], "fx": health["fx_engine"]}

        # -- TTS
        cold, sources = [], []
        for i, script in enumerate(SCRIPTS[: 4 if quick else 8]):
            src, ms = eng.call("POST", "/api/sources/tts", {"script": script, "voice_id": "kokoro:am_fenrir"})
            cold.append(ms)
            sources.append(src)
            if i == 0:  # how long after TTS returns is the background WORLD analysis ready?
                report["analysis_after_tts_s"] = round(eng.wait_analysis(src["id"]), 2)
                time.sleep(3)  # let the stack prefetch finish, so later TTS timings aren't sharing the model
        _, hit_ms = eng.call("POST", "/api/sources/tts", {"script": SCRIPTS[0], "voice_id": "kokoro:am_fenrir"})
        report["tts_cold_ms"] = summary(cold)
        report["tts_cache_hit_ms"] = round(hit_ms)
        # Same phrase lengths through another (non-stack) voice: MLX kernels are compiled per input shape, so this is
        # the steady state once a length has been seen.
        warm_tts = [eng.call("POST", "/api/sources/tts", {"script": sc, "voice_id": "kokoro:am_onyx"})[1]
                    for sc in SCRIPTS[: 4 if quick else 8]]
        report["tts_warm_shapes_ms"] = summary(warm_tts)
        report["speech_s"] = {s["script"]: s["duration_s"] for s in sources}
        for s in sources[1:]:
            eng.wait_analysis(s["id"])
        time.sleep(3)  # background stack prefetch for the last lines

        # -- previews and finals, per preset x bars
        main = sources[0]
        per_preset = {}
        warm_all, first_all, final_all = [], [], []
        depths = [0.2, 0.4, 0.6, 0.8] if not quick else [0.3, 0.7]
        for bars in (4, 8):
            for preset in PRESETS:
                first, first_ms = eng.call("POST", "/api/render", render_body(main["id"], preset, bars))
                warm = [eng.call("POST", "/api/render", render_body(main["id"], preset, bars, depth=d))[1]
                        for d in depths]
                final, final_ms = eng.call("POST", "/api/render", render_body(main["id"], preset, bars, "final"))
                per_preset[f"{preset}@{bars}"] = {
                    "first_preview_ms": round(first_ms), "warm_preview": summary(warm), "final_ms": round(final_ms),
                    "fx_ms": first["timings_ms"].get("engine_fx"), "fit": first["fit"]["status"],
                    "lufs": final["loudness"]["short_term_max_lufs"], "true_peak": final["loudness"]["true_peak_db"],
                    "n_samples": final["n_samples"], "export": Path(final["export"]["path"]).name}
                first_all.append(first_ms)
                warm_all += warm
                final_all.append(final_ms)
        report["per_preset"] = per_preset
        report["first_preview_ms"] = summary(first_all)
        report["warm_preview_ms"] = summary(warm_all)
        report["final_render_export_ms"] = summary(final_all)
        report["fx_timing_keys"] = sorted(first["timings_ms"])

        # -- WORLD analysis reuse: a fresh source rendered before vs. after its background analysis
        fresh, _ = eng.call("POST", "/api/sources/tts", {"script": "Fresh words | for the *analysis* test",
                                                         "voice_id": "kokoro:am_michael"})
        _, racing_ms = eng.call("POST", "/api/render", render_body(fresh["id"], "raw", 4))
        eng.wait_analysis(fresh["id"])
        _, after_ms = eng.call("POST", "/api/render", render_body(fresh["id"], "raw", 4, depth=0.9))
        fresh2, _ = eng.call("POST", "/api/sources/tts", {"script": "Second fresh line | waits for analysis",
                                                          "voice_id": "kokoro:am_michael"})
        eng.wait_analysis(fresh2["id"])
        _, analysed_ms = eng.call("POST", "/api/render", render_body(fresh2["id"], "raw", 4))
        report["world_reuse_ms"] = {"render_racing_analysis": round(racing_ms),
                                    "first_render_after_analysis": round(analysed_ms),
                                    "second_render_same_source": round(after_ms)}

        # -- previews while a batch runs (lanes must not block interactive renders)
        lines = [{"script": s, "bars": 8} for s in SCRIPTS[: 3 if quick else 6]]
        job, _ = eng.call("POST", "/api/batch", {"lines": lines, "preset_id": "pact", "playlist": "Bench"})
        during = []
        t_batch = time.perf_counter()
        while True:
            j, _ = eng.call("GET", f"/api/jobs/{job['id']}")
            if j["state"] not in ("queued", "running"):
                break
            _, ms = eng.call("POST", "/api/render",
                             render_body(main["id"], "unit", 4, depth=round(0.05 + (len(during) % 90) * 0.01, 2)))
            during.append(ms)
        report["batch"] = {"lines": len(lines), "state": j["state"], "wall_s": round(time.perf_counter() - t_batch, 1)}
        report["preview_during_batch_ms"] = summary(during)

        # -- disk
        def du(p: Path) -> int:
            return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())

        report["disk_mb"] = {"audio": round(du(root / "data" / "audio") / 1e6, 1),
                             "cache": round(du(root / "data" / "cache") / 1e6, 1),
                             "library": round(sum(f.stat().st_size for f in (root / "data").glob("library*")) / 1e6, 2),
                             "exports": round(du(root / "exports") / 1e6, 1)}
    finally:
        eng.stop()
        shutil.rmtree(root, ignore_errors=True)
    return report


def markdown(r: dict) -> str:
    out = [f"engines: voice={r['engines']['voice']} fx={r['engines']['fx']}; warm-up {r['warm_up_s']} s",
           "", "| what | n | p50 ms | p95 ms | max ms |", "|---|---|---|---|---|"]
    for label, key in [("TTS, new phrase lengths", "tts_cold_ms"), ("TTS, seen lengths", "tts_warm_shapes_ms"),
                       ("preview, first per preset", "first_preview_ms"),
                       ("preview, warm (knob moves)", "warm_preview_ms"), ("final render + export",
                                                                            "final_render_export_ms"),
                       ("preview during a batch", "preview_during_batch_ms")]:
        s = r[key]
        out.append(f"| {label} | {s['n']} | {s['p50']} | {s['p95']} | {s['max']} |")
    out += ["", f"TTS cache hit: {r['tts_cache_hit_ms']} ms; background WORLD analysis done {r['analysis_after_tts_s']} s "
                f"after TTS", f"WORLD reuse: {r['world_reuse_ms']}", f"batch: {r['batch']}", f"disk: {r['disk_mb']}",
            "", "| preset@bars | first | warm p50 | final | fit | LUFS | TP |", "|---|---|---|---|---|---|---|"]
    for k, v in r["per_preset"].items():
        out.append(f"| {k} | {v['first_preview_ms']} | {v['warm_preview']['p50']} | {v['final_ms']} | {v['fit']} | "
                   f"{v['lufs']} | {v['true_peak']} |")
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path)
    ap.add_argument("--quick", action="store_true")
    args = ap.parse_args()
    report = run(args.quick)
    if args.out:
        args.out.write_text(json.dumps(report, indent=2))
    print(markdown(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
