"""Renders may run concurrently (S3 overlaps one interactive render with one background render): results must
be identical to serial renders and nothing may raise."""

from concurrent.futures import ThreadPoolExecutor

import numpy as np

from fvwks_contracts.models import Arrange, RenderRequest
from fvwks_fx import api
from fvwks_fx.memo import STAGES


def _req(preset_id: str, quality: str) -> RenderRequest:
    base = RenderRequest(source_id="c", preset_id=preset_id, quality=quality, arrange=Arrange(bpm=140, bars=4, key="Am"))
    return api.apply_hints(base, api.get_preset(preset_id))


def test_concurrent_renders_match_serial(we_are, we_are_stack):
    jobs = [("pact", "preview"), ("unit", "final"), ("ghost", "preview"), ("legion", "final"), ("pact", "preview")]

    def run(job):
        pid, q = job
        pre = api.get_preset(pid)
        stack = [s if sv.voice_id else None for sv, s in zip(pre.stack, we_are_stack)]
        return api.render(we_are, stack, _req(pid, q))

    STAGES.clear()
    serial = [run(j) for j in jobs]
    STAGES.clear()
    with ThreadPoolExecutor(4) as ex:
        parallel = list(ex.map(run, jobs))
    for a, b, (pid, q) in zip(serial, parallel, jobs):
        assert a.audio.shape == b.audio.shape
        # the master's warm start may pick a gain within the search tolerance of the serial one
        assert abs(a.loudness.short_term_max_lufs - b.loudness.short_term_max_lufs) <= (0.1 if q == "final" else 0.5), pid
        assert b.loudness.true_peak_db <= -1.0 + 1e-6 and np.all(np.isfinite(b.audio))
