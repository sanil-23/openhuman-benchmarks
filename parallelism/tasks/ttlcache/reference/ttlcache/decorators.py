"""Memoising decorator. See README.md."""
import functools
import threading
from collections import namedtuple

from .cache import Cache

CacheInfo = namedtuple("CacheInfo", ["hits", "misses", "maxsize", "currsize"])

_MISSING = object()


def _check_hashable(value, what):
    try:
        hash(value)
    except TypeError:
        raise TypeError("unhashable %s of type %r" % (what, type(value).__name__)) from None


def _default_key(args, kwargs):
    for a in args:
        _check_hashable(a, "argument")
    items = tuple(sorted(kwargs.items()))
    for _, v in items:
        _check_hashable(v, "argument")
    return (args, items)


def cached(cache=None, ttl=None, key=None):
    def decorator(func):
        store = cache if cache is not None else Cache(max_size=128)
        token = object()
        lock = threading.Lock()
        counts = {"hits": 0, "misses": 0}

        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            if key is None:
                k = _default_key(args, kwargs)
            else:
                k = key(*args, **kwargs)
                _check_hashable(k, "key")
            full = (token, k)
            value = store.get(full, _MISSING)
            if value is not _MISSING:
                with lock:
                    counts["hits"] += 1
                return value
            with lock:
                counts["misses"] += 1
            value = func(*args, **kwargs)
            store.set(full, value, ttl)
            return value

        def mine():
            return [k for k in store.keys() if isinstance(k, tuple) and len(k) == 2 and k[0] is token]

        def cache_info():
            with lock:
                return CacheInfo(counts["hits"], counts["misses"], store.max_size, len(mine()))

        def cache_clear():
            with store.lock:
                for k in mine():
                    store.delete(k)
            with lock:
                counts["hits"] = counts["misses"] = 0

        wrapper.cache = store
        wrapper.cache_info = cache_info
        wrapper.cache_clear = cache_clear
        return wrapper

    return decorator
