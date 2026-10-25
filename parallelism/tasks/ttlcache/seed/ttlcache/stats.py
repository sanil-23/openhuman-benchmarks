"""Cache counters. See README.md."""
import threading


class CacheStats:
    def __init__(self):
        raise NotImplementedError

    def record_hit(self):
        raise NotImplementedError

    def record_miss(self):
        raise NotImplementedError

    def record_eviction(self, n=1):
        raise NotImplementedError

    def record_expiration(self, n=1):
        raise NotImplementedError

    @property
    def hit_rate(self):
        raise NotImplementedError

    def snapshot(self):
        raise NotImplementedError

    def reset(self):
        raise NotImplementedError
