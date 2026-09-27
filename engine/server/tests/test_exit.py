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


def test_engine_exits_cleanly_after_kokoro_ran_on_main_and_worker_threads(tmp_path):
    """What the server suite did: a line over HTTP (a worker thread), audition clips rendered on the main thread,
    then another line over HTTP. Unfixed, the process segfaulted at exit every time."""
    code = f"""
        from fastapi.testclient import TestClient

        from fvwks_server.app import create_app
        from fvwks_server.config import Config

        config = Config.from_env({str(tmp_path / "data")!r}, {str(tmp_path / "exports")!r}, "t")
        with TestClient(create_app(config), headers={{"Authorization": "Bearer t"}}) as client:
            def line(script):
                res = client.post("/api/sources/tts", json={{"script": script, "voice_id": "kokoro:am_fenrir"}})
                assert res.status_code == 200, res.text

            line("First line, on a worker thread.")
            client.app.state.service.prerender_samples()  # Kokoro on the main thread
            line("A different line, on a worker thread again.")
    """
    out = _run(code, tmp_path)
    assert out.returncode == 0, (out.returncode, out.stderr[-3000:])
