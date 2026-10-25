"""LRU cache with optional TTL. See README.md."""
import threading
import time


class Cache:
    def __init__(self, max_size=128, default_ttl=None, clock=time.monotonic, stats=None):
        raise NotImplementedError

    def set(self, key, value, ttl=None):
        raise NotImplementedError

    def get(self, key, default=None):
        raise NotImplementedError

    def peek(self, key, default=None):
        raise NotImplementedError

    def delete(self, key):
        raise NotImplementedError

    def __contains__(self, key):
        raise NotImplementedError

    def __len__(self):
        raise NotImplementedError

    def purge(self):
        raise NotImplementedError

    def clear(self):
        raise NotImplementedError

    def keys(self):
        raise NotImplementedError

    def resize(self, max_size):
        raise NotImplementedError

    def update(self, key, func, default=None):
        raise NotImplementedError
