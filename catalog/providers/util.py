"""Small helpers shared by the provider modules."""
import threading
import time


def join_meta(*bits):
    return " · ".join(str(b) for b in bits if b)


def is_numeric_id(value):
    # isdigit() alone accepts superscripts that int() rejects.
    s = str(value)
    return s.isascii() and s.isdigit()


class TTLCache:
    """In-memory cache with per-entry expiry; None is never stored.

    Reads are plain dict lookups (atomic under the GIL). The lock guards only
    insert + eviction: the eviction sweep iterates the dict, which would raise
    if another thread inserted mid-sweep."""

    def __init__(self, ttl_seconds, max_size):
        self._ttl = ttl_seconds
        self._max = max_size
        self._data = {}
        self._lock = threading.Lock()

    def get(self, key):
        hit = self._data.get(key)
        if hit and time.time() - hit[0] < self._ttl:
            return hit[1]
        return None

    def set(self, key, value):
        with self._lock:
            if len(self._data) >= self._max:
                oldest = sorted(self._data.items(), key=lambda kv: kv[1][0])[: self._max // 2]
                for k, _ in oldest:
                    self._data.pop(k, None)
            self._data[key] = (time.time(), value)
        return value
