"""Cache counters. See README.md."""
import threading


class CacheStats:
    def __init__(self):
        self._lock = threading.RLock()
        self.hits = 0
        self.misses = 0
        self.evictions = 0
        self.expirations = 0

    def record_hit(self):
        with self._lock:
            self.hits += 1

    def record_miss(self):
        with self._lock:
            self.misses += 1

    def record_eviction(self, n=1):
        with self._lock:
            self.evictions += n

    def record_expiration(self, n=1):
        with self._lock:
            self.expirations += n

    @property
    def hit_rate(self):
        with self._lock:
            total = self.hits + self.misses
            return self.hits / total if total else 0.0

    def snapshot(self):
        with self._lock:
            return {
                "hits": self.hits,
                "misses": self.misses,
                "evictions": self.evictions,
                "expirations": self.expirations,
                "hit_rate": self.hit_rate,
            }

    def reset(self):
        with self._lock:
            self.hits = self.misses = self.evictions = self.expirations = 0
