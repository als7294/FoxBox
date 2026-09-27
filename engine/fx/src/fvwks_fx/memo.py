"""Stage memoization: each rack stage's output is cached under a hash of everything upstream of it,
so a SPACE tweak reuses the MASK/LAYERS/... outputs and only recomputes SPACE onwards."""

from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Any

import numpy as np


def nbytes(obj: Any, _depth: int = 0) -> int:
    if _depth > 4:
        return 0
    if isinstance(obj, np.ndarray):
        return int(obj.nbytes)
    if isinstance(obj, (list, tuple)):
        return sum(nbytes(o, _depth + 1) for o in obj)
    if isinstance(obj, dict):
        return sum(nbytes(o, _depth + 1) for o in obj.values())
    if hasattr(obj, "__dict__"):
        return sum(nbytes(o, _depth + 1) for o in vars(obj).values())
    return 64


class StageCache:
    def __init__(self, max_bytes: int = 640 * 1024 * 1024):
        self.max_bytes = max_bytes
        self._d: OrderedDict[str, tuple[Any, int]] = OrderedDict()
        self._total = 0
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    def get(self, key: str) -> Any | None:
        with self._lock:
            hit = self._d.get(key)
            if hit is None:
                self.misses += 1
                return None
            self._d.move_to_end(key)
            self.hits += 1
            return hit[0]

    def put(self, key: str, value: Any) -> None:
        size = nbytes(value)
        if size > self.max_bytes:
            return
        with self._lock:
            if key in self._d:
                self._total -= self._d.pop(key)[1]
            self._d[key] = (value, size)
            self._total += size
            while self._total > self.max_bytes and self._d:
                _, (_, s) = self._d.popitem(last=False)
                self._total -= s

    def clear(self) -> None:
        with self._lock:
            self._d.clear()
            self._total = 0

    def __len__(self) -> int:
        return len(self._d)

    @property
    def total_bytes(self) -> int:
        return self._total


STAGES = StageCache()
