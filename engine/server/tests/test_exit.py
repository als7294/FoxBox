"""The engine's processes must exit cleanly: never a crash (exit 139) while the interpreter shuts down.

MLX keeps a compile cache per thread and, at exit, clears only the cache of the thread that first imported
``mlx.core``. Entries left in the main thread's cache are otherwise destroyed after Python has finalized, and
their destructor takes the GIL of an interpreter that no longer exists. These run in subprocesses, since the
crash only shows in the exit status.
"""
import subprocess
import sys
import textwrap

import pytest


def _run(code: str, cwd) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-c", textwrap.dedent(code)], cwd=cwd, capture_output=True, text=True,
                          timeout=300)


def test_mlx_exit_hook_belongs_to_the_main_thread(tmp_path):
    """Once an engine exists, MLX's exit hook covers the main thread, whichever thread uses MLX first.
    Unfixed, this segfaulted every time."""
    pytest.importorskip("mlx.core")
    code = f"""
        import threading

        from fvwks_server.app import create_app
        from fvwks_server.config import Config

        create_app(Config.from_env({str(tmp_path / "data")!r}, {str(tmp_path / "exports")!r}, "t"))

        def use():
            import mlx.core as mx
            import mlx.nn as nn
            mx.eval(nn.gelu(mx.ones((4,))))  # a module-level mx.compile'd function

        def on_a_worker():
            t = threading.Thread(target=use)
            t.start()
            t.join()

        on_a_worker()  # MLX first used (and imported) on a worker thread, as the voice package does
        use()          # then the main thread runs the same compiled function...
        on_a_worker()  # ...and a worker calls it last, so it no longer clears the main thread's entries
    """
    for _ in range(3):
        out = _run(code, tmp_path)
        assert out.returncode == 0, (out.returncode, out.stderr[-3000:])


def test_engine_exits_cleanly_after_the_stem_splitter_ran_on_worker_threads(tmp_path):
    """FoxBox 2.0's MLX work: a song split into stems (a job on a worker thread), twice, then the process exits.
    Unfixed, MLX's per-thread cache made the process segfault at exit."""
    from fvwks_voice import stems

    if not stems.get_splitter().is_installed():
        pytest.skip("stems-htdemucs isn't installed")
    code = f"""
        import io, time, wave

        import numpy as np
        from fastapi.testclient import TestClient

        from fvwks_server.app import create_app
        from fvwks_server.config import Config

        def song(seed):
            sr, rng = 44100, np.random.default_rng(seed)
            x = (0.3 * np.sin(2 * np.pi * 55 * np.arange(sr * 3) / sr) + 0.05 * rng.standard_normal(sr * 3))
            buf = io.BytesIO()
            with wave.open(buf, "wb") as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
                w.writeframes((np.clip(x, -1, 1) * 30000).astype("<i2").tobytes())
            return buf.getvalue()

        config = Config.from_env({str(tmp_path / "data")!r}, {str(tmp_path / "exports")!r}, "t")
        with TestClient(create_app(config), headers={{"Authorization": "Bearer t"}}) as client:
            for seed in (1, 2):
                s = client.post("/api/songs", files={{"file": ("s.wav", song(seed), "audio/wav")}}).json()
                job = client.post(f"/api/songs/{{s['id']}}/stems").json()
                deadline = time.monotonic() + 120
                while job["state"] in ("queued", "running") and time.monotonic() < deadline:
                    time.sleep(0.1)
                    job = client.get(f"/api/jobs/{{job['id']}}").json()
                assert job["state"] == "done", job
    """
    out = _run(code, tmp_path)
    assert out.returncode == 0, (out.returncode, out.stderr[-3000:])
