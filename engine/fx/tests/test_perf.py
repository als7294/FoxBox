"""Performance on a 10.9 s line (8 bars @ 140 BPM), WORLD analysis cached as after the background
``analyze()``. Wall-clock best-of-5, with budgets scaled for machine load (other sessions share it). Skip with FVWKS_SKIP_PERF=1.

Targets from the brief: final < 3 s; preview < 400 ms for knob tweaks downstream of MASK (SPACE / STEREO /
master). A cold preview and DEPTH/MACHINE tweaks (which re-run WORLD synthesis) are held to the targets
proposed in contracts/proposals/S2.md (measured ~0.5-0.9 s and ~0.35-0.6 s; asserted with headroom for load).
"""

import os
import time

import pytest

from fvwks_contracts.models import Arrange, RenderRequest
from fvwks_fx import api
from fvwks_fx.memo import STAGES

pytestmark = pytest.mark.skipif(os.environ.get("FVWKS_SKIP_PERF") == "1", reason="perf tests disabled")


def _req(quality: str) -> RenderRequest:
    base = RenderRequest(source_id="perf", preset_id="pact", quality=quality, arrange=Arrange(bpm=140, bars=8, key="Am"))
    return api.apply_hints(base, api.get_preset("pact"))


def _tweak(req: RenderRequest, module: str, param: str, value) -> RenderRequest:
    ch = req.chain.model_copy(deep=True)
    for m in ch.modules:
        if m.id == module:
            m.params[param] = value
    return req.model_copy(update={"chain": ch})


def _best(fn, n: int = 5) -> float:
    best = float("inf")
    for i in range(n):
        t = time.perf_counter()
        fn(i)
        best = min(best, time.perf_counter() - t)
    return best


def _budget(seconds: float) -> float:
    """The target, scaled for machine load: other sessions, the app and test runs share this Mac. Unchanged below
    0.4 load per core, +60 % per unit of load per core above that, capped at 1.8x, so a real 2x regression still
    fails at any realistic load."""
    try:
        per_core = os.getloadavg()[0] / (os.cpu_count() or 1)
    except OSError:
        per_core = 0.0
    return seconds * min(1.8, 1.0 + 0.6 * max(0.0, per_core - 0.4))


def _check(elapsed: float, target: float) -> None:
    budget = _budget(target)
    assert elapsed < budget, f"{elapsed * 1000:.0f} ms > {budget * 1000:.0f} ms ({target * 1000:.0f} ms target, load-scaled)"


@pytest.fixture(scope="module")
def warm(ten_second_line, ten_second_stack):
    for s in [ten_second_line, *ten_second_stack]:
        api.analyze(s)
    from fvwks_fx.pipeline import get_analysis, source_audio48

    for s in ten_second_stack:  # the server analyzes STACK sources after synthesizing them
        get_analysis(source_audio48(s), "tts", "final", role="stack")
    return ten_second_line, ten_second_stack


def test_final_under_3s(warm):
    main, stack = warm

    def run(_):
        STAGES.clear()
        api.render(main, stack, _req("final"))

    _check(_best(run), 3.0)


def test_preview_cold_under_1_2s(warm):
    main, stack = warm

    def run(_):
        STAGES.clear()
        api.render(main, stack, _req("preview"))

    _check(_best(run), 1.2)


def test_preview_space_tweak_under_400ms(warm):
    main, stack = warm
    req = _req("preview")
    api.render(main, stack, req)

    def run(i):
        api.render(main, stack, _tweak(req, "space", "reverb_decay_s", 1.5 + 0.1 * (i + 1)))

    _check(_best(run), 0.4)


def test_preview_depth_tweak_under_800ms(warm):
    main, stack = warm
    req = _req("preview")
    api.render(main, stack, req)

    def run(i):
        api.render(main, stack, req.model_copy(update={"macros": req.macros.model_copy(update={"depth": 0.55 + 0.05 * i})}))

    _check(_best(run), 0.8)
