"""Memoising decorator. See README.md."""
import functools
from collections import namedtuple

from .cache import Cache

CacheInfo = namedtuple("CacheInfo", ["hits", "misses", "maxsize", "currsize"])


def cached(cache=None, ttl=None, key=None):
    raise NotImplementedError
