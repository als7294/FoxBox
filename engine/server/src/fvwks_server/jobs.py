"""Background jobs with progress (owned by S3): model installs, batch/Setlist renders, WORLD analysis.

A job function has the shape ``fn(ctx, *args, **kwargs) -> result``. It reports through ``ctx.progress`` or
per-item ``ctx.item`` and calls ``ctx.check()`` between units of work, so it can be cancelled. Lanes are separate
thread pools, so a long model download never blocks WORLD analysis or a Setlist render.

``Job.snapshot()`` has exactly the fields of the contract's ``Job`` model (states: queued, running, done, error,
cancelled), so the HTTP layer can validate it directly.
"""
from __future__ import annotations

import threading
import time
import traceback
import uuid
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterable

QUEUED, RUNNING, DONE, ERROR, CANCELLED = "queued", "running", "done", "error", "cancelled"
ACTIVE = frozenset({QUEUED, RUNNING})
DEFAULT_LANES = {"default": 2, "analysis": 1, "install": 1}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class JobCancelled(Exception):
    """Raised by ``JobContext.check()`` once a job was asked to stop."""


def error_payload(exc: BaseException, default_code: str = "job_failed") -> dict[str, Any]:
    """The engine-wide error shape ``{code, message, hint, retryable}``; exceptions may carry these attributes."""
    error = getattr(exc, "error", None)  # an ApiException carries a ready ApiError
    if error is not None and hasattr(error, "model_dump"):
        return error.model_dump()
    model_id = getattr(exc, "model_id", None)  # model_not_installed from a hook: the app deep-links to it (P7)
    return {
        "code": str(getattr(exc, "code", None) or default_code),
        "message": str(getattr(exc, "message", None) or exc) or type(exc).__name__,
        "hint": getattr(exc, "hint", None),
        "retryable": bool(getattr(exc, "retryable", False)),
        **({"model_id": str(model_id)} if model_id else {}),
    }


@dataclass
class Job:
    id: str
    kind: str
    lane: str
    state: str = QUEUED
    progress: float = 0.0
    message: str | None = None
    items: list[dict[str, Any]] = field(default_factory=list)
    result_ids: list[str] = field(default_factory=list)
    error: dict[str, Any] | None = None
    created_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)
    result: Any = None
    dedupe_key: str | None = None
    retain: bool = True  # False: forget the job once it finishes (internal work nobody polls)
    meta: dict[str, Any] = field(default_factory=dict)
    # v0.4 transfer fields (downloads): bytes, a smoothed rate, the time left and what is being fetched
    bytes_done: int | None = None
    bytes_total: int | None = None
    rate_bps: float | None = None
    eta_s: float | None = None
    current_item: str | None = None
    _rate_mark: tuple[float, int] | None = field(default=None, repr=False)
    _cancel: threading.Event = field(default_factory=threading.Event, repr=False)
    _done: threading.Event = field(default_factory=threading.Event, repr=False)
    _future: Future | None = field(default=None, repr=False)

    @property
    def active(self) -> bool:
        return self.state in ACTIVE

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": self.id, "kind": self.kind, "state": self.state, "progress": round(self.progress, 4),
            "message": self.message, "items": [dict(i, result_ids=list(i["result_ids"])) for i in self.items],
            "result_ids": list(self.result_ids), "error": self.error, "created_at": self.created_at,
            "updated_at": self.updated_at, "bytes_done": self.bytes_done, "bytes_total": self.bytes_total,
            "rate_bps": None if self.rate_bps is None else round(self.rate_bps, 1),
            "eta_s": None if self.eta_s is None else round(self.eta_s, 1), "current_item": self.current_item,
        }


class JobContext:
    def __init__(self, runner: JobRunner, job: Job):
        self._runner = runner
        self.job = job

    @property
    def cancelled(self) -> bool:
        return self.job._cancel.is_set()

    def check(self) -> None:
        if self.cancelled:
            raise JobCancelled(f"job {self.job.id} cancelled")

    def progress(self, fraction: float | None = None, message: str | None = None, /, **meta: Any) -> None:
        self._runner._update(self.job, fraction=fraction, message=message, meta=meta)

    def step(self, done: int, total: int, message: str | None = None, /, **meta: Any) -> None:
        self.progress(done / total if total else 1.0, message, **meta)

    def item(self, index: int, *, state: str | None = None, progress: float | None = None,
             error: dict[str, Any] | None = None, result_ids: Iterable[str] = ()) -> None:
        """Update one batch item; job progress becomes the mean item progress."""
        self._runner._update_item(self.job, index, state, progress, error, list(result_ids))

    def transfer(self, bytes_done: int | None, bytes_total: int | None = None, current_item: str | None = None) -> None:
        """Download progress: the rate is smoothed over half-second windows, and the time left follows from it."""
        self._runner._transfer(self.job, bytes_done, bytes_total, current_item)

    def add_results(self, ids: Iterable[str]) -> None:
        self._runner._update(self.job, result_ids=list(ids))

    def message(self, text: str | None) -> None:
        self._runner._update(self.job, message=text)


Listener = Callable[[dict[str, Any]], None]


class JobRunner:
    def __init__(self, lanes: dict[str, int] | None = None, keep_finished: int = 200):
        self._lane_sizes = {**DEFAULT_LANES, **(lanes or {})}
        self._pools: dict[str, ThreadPoolExecutor] = {}
        self._jobs: OrderedDict[str, Job] = OrderedDict()
        self._lock = threading.RLock()
        self._keep = keep_finished
        self._listeners: list[Listener] = []
        self._closed = False

    # -- submission ---------------------------------------------------------------------------------

    def new_job(self, kind: str, *, labels: Iterable[str] = (), lane: str = "default",
                dedupe_key: str | None = None, meta: dict[str, Any] | None = None, retain: bool = True) -> Job:
        """A registered job that is not running (yet). ``fail`` and ``submit`` use it."""
        job = Job(id=f"job_{uuid.uuid4().hex[:12]}", kind=kind, lane=lane, dedupe_key=dedupe_key, retain=retain,
                  meta=dict(meta or {}),
                  items=[{"index": i, "label": label, "state": QUEUED, "progress": 0.0, "error": None,
                          "result_ids": []} for i, label in enumerate(labels)])
        with self._lock:
            self._jobs[job.id] = job
            self._trim()
        return job

    def submit(self, kind: str, fn: Callable[..., Any], *args: Any, lane: str = "default",
               labels: Iterable[str] = (), dedupe_key: str | None = None, meta: dict[str, Any] | None = None,
               retain: bool = True, **kwargs: Any) -> Job:
        """Queue ``fn(ctx, *args, **kwargs)``. With ``dedupe_key``, an active job with that key is returned."""
        with self._lock:
            if self._closed:
                raise RuntimeError("job runner is shut down")
            if dedupe_key is not None:
                for job in self._jobs.values():
                    if job.dedupe_key == dedupe_key and job.active:
                        return job
            job = self.new_job(kind, labels=labels, lane=lane, dedupe_key=dedupe_key, meta=meta, retain=retain)
            job._future = self._pool(lane).submit(self._run, job, fn, args, kwargs)
        self._emit(job)
        return job

    def complete(self, job: Job, message: str | None = None, result: Any = None) -> Job:
        """Finish a job that had nothing to do (e.g. a model that is already installed)."""
        self._finish(job, DONE, result=result, message=message)
        return job

    def fail(self, job: Job, code: str, message: str, hint: str | None = None) -> Job:
        """Finish a job that could not start (e.g. a model install without disk space)."""
        self._finish(job, ERROR, error={"code": code, "message": message, "hint": hint, "retryable": False})
        return job

    def _pool(self, lane: str) -> ThreadPoolExecutor:
        pool = self._pools.get(lane)
        if pool is None:
            pool = ThreadPoolExecutor(max_workers=self._lane_sizes.get(lane, 1), thread_name_prefix=f"job-{lane}")
            self._pools[lane] = pool
        return pool

    def _run(self, job: Job, fn: Callable[..., Any], args: tuple, kwargs: dict) -> None:
        with self._lock:
            if job._cancel.is_set():
                cancelled_early = True
            else:
                cancelled_early = False
                job.state, job.updated_at = RUNNING, _now()
        if cancelled_early:
            self._finish(job, CANCELLED, message="Cancelled before it started.")
            return
        self._emit(job)
        try:
            result = fn(JobContext(self, job), *args, **kwargs)
        except JobCancelled:
            self._finish(job, CANCELLED, message="Cancelled.")
        except Exception as exc:  # noqa: BLE001 - every failure becomes the job's error payload
            if job._cancel.is_set():  # a hook wrapped our JobCancelled in its own error type
                self._finish(job, CANCELLED, message="Cancelled.")
                return
            job.meta["traceback"] = traceback.format_exc(limit=8)
            self._finish(job, ERROR, error=error_payload(exc))
        else:
            if job._cancel.is_set():
                self._finish(job, CANCELLED, result=result, message=job.message or "Cancelled.")
            else:
                self._finish(job, DONE, result=result)

    def _finish(self, job: Job, state: str, *, result: Any = None, error: dict | None = None,
                message: str | None = None) -> None:
        with self._lock:
            job.state, job.updated_at = state, _now()
            job.result, job.error = result, error
            if state == DONE:
                job.progress = 1.0
            if message is not None:
                job.message = message
            elif error and not job.message:
                job.message = error["message"]
            for item in job.items:
                if item["state"] in ACTIVE:
                    item["state"] = CANCELLED if state in (CANCELLED, ERROR) else item["state"]
            if not job.retain:
                self._jobs.pop(job.id, None)
        job._done.set()
        self._emit(job)

    def _update(self, job: Job, *, fraction: float | None = None, message: str | None = None,
                meta: dict[str, Any] | None = None, result_ids: list[str] | None = None) -> None:
        with self._lock:
            if fraction is not None:
                job.progress = min(1.0, max(0.0, float(fraction)))
            if message is not None:
                job.message = message
            if meta:
                job.meta.update(meta)
            if result_ids:
                job.result_ids.extend(result_ids)
            job.updated_at = _now()
        self._emit(job)

    def _transfer(self, job: Job, done: int | None, total: int | None, item: str | None) -> None:
        now = time.monotonic()
        with self._lock:
            if total is not None:
                job.bytes_total = int(total)
            if item is not None:
                job.current_item = item
            if done is not None:
                done = int(done)
                mark = job._rate_mark
                if mark is None or done < mark[1]:  # first sample, or a restarted download
                    job._rate_mark = (now, done)
                elif now - mark[0] >= 0.5:
                    rate = (done - mark[1]) / (now - mark[0])
                    job.rate_bps = rate if job.rate_bps is None else 0.6 * job.rate_bps + 0.4 * rate
                    job._rate_mark = (now, done)
                job.bytes_done = done
                if job.bytes_total and job.rate_bps:
                    job.eta_s = max(0.0, (job.bytes_total - done) / job.rate_bps)
                elif job.bytes_total and done >= job.bytes_total:
                    job.eta_s = 0.0
            job.updated_at = _now()
        self._emit(job)

    def _update_item(self, job: Job, index: int, state: str | None, progress: float | None,
                     error: dict[str, Any] | None, result_ids: list[str]) -> None:
        with self._lock:
            item = job.items[index]
            if state is not None:
                item["state"] = state
                if state == DONE:
                    item["progress"] = 1.0
            if progress is not None:
                item["progress"] = min(1.0, max(0.0, float(progress)))
            if error is not None:
                item["error"] = error
            item["result_ids"].extend(result_ids)
            finished = sum(1.0 if i["state"] in (DONE, ERROR, CANCELLED) else i["progress"] for i in job.items)
            job.progress = finished / len(job.items)
            job.updated_at = _now()
        self._emit(job)

    def _trim(self) -> None:
        finished = [j for j in self._jobs.values() if not j.active]
        for job in finished[: max(0, len(finished) - self._keep)]:
            del self._jobs[job.id]

    # -- queries and control ------------------------------------------------------------------------

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self, kind: str | None = None, active_only: bool = False) -> list[Job]:
        with self._lock:
            jobs = list(self._jobs.values())
        return [j for j in jobs if (kind is None or j.kind == kind) and (not active_only or j.active)]

    def cancel(self, job_id: str) -> bool:
        """Ask a job to stop. Queued jobs never start; running jobs stop at their next ``ctx.check()``."""
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or not job.active:
                return False
            job._cancel.set()
            never_started = job.state == QUEUED and job._future is not None and job._future.cancel()
        if never_started:
            self._finish(job, CANCELLED, message="Cancelled before it started.")
        return True

    def wait(self, job: Job | str, timeout: float | None = None) -> Job:
        job = self.get(job) if isinstance(job, str) else job
        if job is None:
            raise KeyError("unknown job")
        if not job._done.wait(timeout):
            raise TimeoutError(f"job {job.id} still {job.state}")
        return job

    def add_listener(self, listener: Listener) -> None:
        self._listeners.append(listener)

    def _emit(self, job: Job) -> None:
        if not self._listeners:
            return
        snap = job.snapshot()
        for listener in list(self._listeners):
            try:
                listener(snap)
            except Exception:  # noqa: BLE001 - a broken listener must not kill the job
                pass

    def shutdown(self, cancel: bool = True, wait: bool = True, timeout: float | None = None) -> bool:
        """Stop taking jobs. With ``cancel``, queued jobs never start and running ones stop at their next
        ``ctx.check()``. With ``wait``, wait up to ``timeout`` s for active jobs, then join the lane threads.
        Returns whether every job had finished (the threads are left to exit on their own if not)."""
        never_started: list[Job] = []
        with self._lock:
            self._closed = True
            active = [job for job in self._jobs.values() if job.active]
            if cancel:
                for job in active:
                    job._cancel.set()
                    if job.state == QUEUED and job._future is not None and job._future.cancel():
                        never_started.append(job)
            pools = list(self._pools.values())
        for job in never_started:
            self._finish(job, CANCELLED, message="Engine shutting down.")
        finished = True
        if wait:
            deadline = None if timeout is None else time.monotonic() + timeout
            for job in active:
                if not job._done.wait(None if deadline is None else max(0.0, deadline - time.monotonic())):
                    finished = False
                    break
        else:
            finished = not any(job.active for job in active)
        for pool in pools:
            pool.shutdown(wait=wait and finished, cancel_futures=cancel)
        return finished
