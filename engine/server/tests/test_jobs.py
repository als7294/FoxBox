"""Background job runner: progress, items, errors, cancellation, dedupe, lanes."""
import threading

import pytest
from fvwks_contracts.models import Job as JobModel

from fvwks_server.jobs import CANCELLED, DONE, ERROR, JobRunner


@pytest.fixture
def runner():
    r = JobRunner()
    yield r
    r.shutdown()


def test_progress_and_result(runner):
    seen = []
    runner.add_listener(lambda snap: seen.append((snap["state"], snap["progress"])))

    def work(ctx, n):
        for i in range(n):
            ctx.check()
            ctx.step(i + 1, n, f"line {i + 1}/{n}", done=i + 1)
        return {"files": n}

    job = runner.submit("batch", work, 5, meta={"playlist": "Friday"})
    done = runner.wait(job.id, timeout=5)
    snap = done.snapshot()
    assert snap["state"] == DONE and snap["progress"] == 1.0 and done.result == {"files": 5}
    assert snap["message"] == "line 5/5" and done.meta == {"playlist": "Friday", "done": 5}
    assert snap["updated_at"] >= snap["created_at"]
    assert ("running", 0.4) in seen and seen[-1] == ("done", 1.0)
    JobModel.model_validate(snap)  # snapshots are valid contract Jobs


def test_items_and_results(runner):
    def work(ctx):
        ctx.item(0, state="running")
        ctx.item(0, state="done", result_ids=["exp_1"])
        ctx.add_results(["exp_1"])
        ctx.item(1, state="error", error={"code": "line_failed", "message": "boom", "hint": None,
                                          "retryable": False})
        ctx.message("/tmp/x_rekordbox.xml")

    job = runner.wait(runner.submit("batch", work, labels=["a", "b", "c"]).id, timeout=5)
    snap = JobModel.model_validate(job.snapshot())
    assert [i.state for i in snap.items] == ["done", "error", "queued"]
    assert snap.items[0].result_ids == ["exp_1"] and snap.items[1].error.code == "line_failed"
    assert snap.result_ids == ["exp_1"] and snap.message == "/tmp/x_rekordbox.xml" and snap.state == "done"


class Boom(Exception):
    code, hint = "disk_full", "Free 3 GB and retry"


def test_failure_becomes_error_payload(runner):
    def fail(ctx):
        raise Boom("no space left")

    job = runner.wait(runner.submit("model_install", fail, lane="install").id, timeout=5)
    assert job.state == ERROR and job.message == "no space left"
    assert job.error == {"code": "disk_full", "message": "no space left", "hint": "Free 3 GB and retry",
                         "retryable": False}
    plain = runner.wait(runner.submit("batch", lambda ctx: 1 / 0).id, timeout=5)
    assert plain.error["code"] == "job_failed" and "division" in plain.error["message"]
    failed = runner.fail(runner.new_job("persona_design"), "model_missing", "Install it first.")
    assert JobModel.model_validate(failed.snapshot()).error.code == "model_missing"


def test_cancel_running_and_queued(runner):
    started, release = threading.Event(), threading.Event()

    def blocking(ctx):
        started.set()
        while not release.wait(0.01):
            ctx.check()

    running = runner.submit("model_install", blocking, lane="install")
    queued = runner.submit("model_install", blocking, lane="install", labels=["x"])  # waits behind the first
    assert started.wait(5)
    assert runner.cancel(queued.id) and runner.wait(queued.id, 5).state == CANCELLED
    assert queued.items[0]["state"] == CANCELLED
    assert runner.cancel(running.id) and runner.wait(running.id, 5).state == CANCELLED
    assert not runner.cancel(running.id) and not runner.cancel("job_missing")


def test_dedupe_and_lanes(runner):
    gate = threading.Event()
    a = runner.submit("analysis", lambda ctx: gate.wait(5), lane="analysis", dedupe_key="world:src_1")
    b = runner.submit("analysis", lambda ctx: gate.wait(5), lane="analysis", dedupe_key="world:src_1")
    assert a is b
    other = runner.submit("batch", lambda ctx: "ok")  # the default lane is not blocked by analysis
    assert runner.wait(other.id, 5).result == "ok"
    gate.set()
    assert runner.wait(a.id, 5).state == DONE
    c = runner.submit("analysis", lambda ctx: 2, lane="analysis", dedupe_key="world:src_1")
    assert c is not a  # finished jobs don't dedupe
    assert {j.id for j in runner.list(kind="analysis")} == {a.id, c.id}


def test_unretained_jobs_are_forgotten_when_done(runner):
    job = runner.submit("analysis", lambda ctx: 7, lane="analysis", retain=False)
    assert runner.wait(job, timeout=5).result == 7 and runner.get(job.id) is None
    kept = runner.submit("batch", lambda ctx: 8)
    assert runner.wait(kept.id, timeout=5).result == 8 and runner.get(kept.id) is kept


def test_finished_jobs_are_trimmed_and_shutdown():
    runner = JobRunner(keep_finished=3)
    ids = [runner.submit("batch", lambda ctx: None).id for _ in range(6)]
    for job_id in ids:
        if runner.get(job_id):
            runner.wait(job_id, 5)
    runner.submit("batch", lambda ctx: None)
    assert len(runner.list()) <= 4
    runner.shutdown()
    with pytest.raises(RuntimeError):
        runner.submit("batch", lambda ctx: None)
