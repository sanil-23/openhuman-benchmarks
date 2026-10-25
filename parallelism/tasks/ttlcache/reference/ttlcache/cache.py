"""LRU cache with optional TTL. See README.md."""
import threading
import time
from collections import OrderedDict

from .stats import CacheStats


def _check_ttl(ttl):
    if ttl is not None and not (ttl > 0):
        raise ValueError("ttl must be positive")


def _check_size(n):
    if isinstance(n, bool) or not isinstance(n, int) or n < 1:
        raise ValueError("max_size must be a positive integer")


class Cache:
    def __init__(self, max_size=128, default_ttl=None, clock=time.monotonic, stats=None):
        _check_size(max_size)
        _check_ttl(default_ttl)
        self.max_size = max_size
        self.default_ttl = default_ttl
        self._clock = clock
        self.stats = stats if stats is not None else CacheStats()
        self.lock = threading.RLock()
        self._data = OrderedDict()  # key -> (value, expires_at | None), LRU first

    # internal helpers (lock must be held)
    def _expired(self, key, now):
        exp = self._data[key][1]
        return exp is not None and now >= exp

    def _drop_if_expired(self, key, now):
        if key in self._data and self._expired(key, now):
            del self._data[key]
            self.stats.record_expiration()

    def _purge(self, now):
        dead = [k for k in self._data if self._expired(k, now)]
        for k in dead:
            del self._data[k]
        if dead:
            self.stats.record_expiration(len(dead))
        return len(dead)

    def _shrink(self, now):
        evicted = []
        if len(self._data) > self.max_size:
            self._purge(now)
            while len(self._data) > self.max_size:
                k, _ = self._data.popitem(last=False)
                evicted.append(k)
                self.stats.record_eviction()
        return evicted

    def _set(self, key, value, ttl, now):
        _check_ttl(ttl)
        if ttl is None:
            ttl = self.default_ttl
        self._drop_if_expired(key, now)
        self._data[key] = (value, None if ttl is None else now + ttl)
        self._data.move_to_end(key)
        return self._shrink(now)

    def _lookup(self, key, default, now):
        self._drop_if_expired(key, now)
        if key in self._data:
            return self._data[key][0], True
        return default, False

    # public API
    def set(self, key, value, ttl=None):
        with self.lock:
            return self._set(key, value, ttl, self._clock())

    def get(self, key, default=None):
        with self.lock:
            value, found = self._lookup(key, default, self._clock())
            if found:
                self._data.move_to_end(key)
                self.stats.record_hit()
            else:
                self.stats.record_miss()
            return value

    def peek(self, key, default=None):
        with self.lock:
            return self._lookup(key, default, self._clock())[0]

    def delete(self, key):
        with self.lock:
            self._drop_if_expired(key, self._clock())
            if key in self._data:
                del self._data[key]
                return True
            return False

    def __contains__(self, key):
        with self.lock:
            self._drop_if_expired(key, self._clock())
            return key in self._data

    def __len__(self):
        with self.lock:
            self._purge(self._clock())
            return len(self._data)

    def purge(self):
        with self.lock:
            return self._purge(self._clock())

    def clear(self):
        with self.lock:
            self._data.clear()

    def keys(self):
        with self.lock:
            self._purge(self._clock())
            return list(self._data)

    def resize(self, max_size):
        with self.lock:
            _check_size(max_size)
            self.max_size = max_size
            return self._shrink(self._clock())

    def update(self, key, func, default=None):
        with self.lock:
            now = self._clock()
            current, _ = self._lookup(key, default, now)
            result = func(current)
            self._set(key, result, None, now)
            return result
