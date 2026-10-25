# ttlcache

A small thread-safe in-memory LRU cache with optional TTL, standard library only (Python 3.10).

## Modules

### `ttlcache/stats.py`
`class CacheStats` holds four counters as plain int attributes: `hits`, `misses`, `evictions`,
`expirations`, all starting at 0.
- `record_hit()`, `record_miss()`, `record_eviction(n=1)`, `record_expiration(n=1)` add to the counter.
- `hit_rate` (property) is `hits / (hits + misses)`, or `0.0` when there have been no lookups.
- `snapshot() -> dict` returns a new dict with exactly the keys `hits`, `misses`, `evictions`,
  `expirations`, `hit_rate`. Later changes to the stats do not alter a snapshot already taken.
- `reset()` sets all four counters back to 0.
- All methods are thread-safe (guarded by an `RLock`, so no increments are lost under contention).

### `ttlcache/cache.py`
`class Cache(max_size=128, default_ttl=None, clock=time.monotonic, stats=None)`
- `max_size` must be an int >= 1, else `ValueError("max_size must be a positive integer")`.
  `default_ttl` is `None` (entries never expire unless given a TTL) or a number > 0, else
  `ValueError("ttl must be positive")`. The same check and message apply to the `ttl` argument of `set`.
- `clock` is a zero-argument callable returning the current time as a number. The cache never calls
  `time` itself; every time decision uses `clock()`. It is called at most once per public method call.
- `stats` is a `CacheStats` to feed; when `None` the cache creates its own. It is exposed as
  `cache.stats`. The lock is exposed as `cache.lock` (an `RLock`); every public method holds it for
  its whole duration, and callers may hold it too to group several calls atomically.

Entries are kept in recency order. "Most recently used" and "least recently used" below refer to it.

**Expiry.** An entry stored with a TTL is expired when `now >= set_time + ttl`, where `set_time` is the
clock reading when it was last stored with `set`. Reads never extend a TTL. An entry with no TTL never
expires. Expired entries are removed lazily: whenever a method below touches an expired entry it
removes it and calls `stats.record_expiration()` once for it. `purge()` removes all of them.
An expired entry is never visible: it behaves exactly like an absent key.

**Methods.**
- `set(key, value, ttl=None) -> list` stores the value. `ttl=None` means use `default_ttl`. The entry
  becomes the most recently used one and its `set_time` is the current time (this also applies when
  overwriting an existing live key; overwriting never counts as an eviction). If the key is present
  but expired, that old entry is removed first (counted as an expiration) and the key is then stored
  as a new entry. After storing, if the cache is over `max_size`, every expired entry is purged first
  (counted as expirations), and only if it is still over `max_size` are least recently used entries
  evicted, one at a time (each counted via `record_eviction()`). Returns the list of evicted keys in
  eviction order (empty list if none). Expired entries removed this way are not in that list.
- `get(key, default=None)` returns the value of a live key and makes it the most recently used
  (`record_hit()`). For an absent or expired key returns `default` (`record_miss()`; an expired entry
  is also removed and counted as an expiration).
- `peek(key, default=None)` like `get` but does not change recency and does not record hits or misses.
  An expired entry is still removed and counted as an expiration.
- `delete(key) -> bool` removes the key and returns `True` if a live entry was removed. Returns `False`
  if the key was absent or expired (an expired entry is removed and counted as an expiration). Deleting
  is never an eviction.
- `key in cache` (`__contains__`) is `True` only for a live key. It changes no recency and records no
  hit or miss; an expired entry is removed and counted as an expiration.
- `len(cache)` is the number of live entries; expired entries are purged (and counted) first.
- `purge() -> int` removes every expired entry, counts each as an expiration and returns how many.
- `clear()` removes everything without touching any counter.
- `keys() -> list` the live keys from least to most recently used (purging expired ones first). It does
  not change recency.
- `resize(max_size) -> list` changes `max_size` (same validation as the constructor). If the cache is now
  over the limit, it purges expired entries first and then evicts least recently used entries, with the
  same accounting as `set`, and returns the evicted keys in eviction order.
- `update(key, func, default=None)` atomically computes a new value: it looks the key up without
  changing recency or recording a hit or miss (an expired entry is removed and counted as an expiration;
  an absent or expired key yields `default`), calls `func(current)`, stores the result with `set(key,
  result)` (default TTL) and returns the stored result. The whole operation holds the lock, so
  concurrent `update` calls never lose an update.

### `ttlcache/decorators.py`
`cached(cache=None, ttl=None, key=None)` returns a memoising decorator (it must always be called:
`@cached()`, not `@cached`).
- With `cache=None` each decorated function gets its own new `Cache(max_size=128)`. A given `cache` may
  be shared by several functions without their results colliding.
- `ttl` is passed to `cache.set` for every stored result (`None` means the cache's default TTL).
- `key` is an optional function called as `key(*args, **kwargs)` returning the hashable cache key. By
  default the key is built from the arguments so that `f(1, b=2, a=3)` and `f(1, a=3, b=2)` share an
  entry, `f(1)` and `f(a=1)` do not, and `f((1, 2))` and `f(1, 2)` do not. Arguments that compare equal
  and hash equal (such as `1` and `1.0`) share an entry.
- If any argument (positional, or a keyword value) is unhashable, the wrapper raises `TypeError` before
  calling the function, with the message `unhashable argument of type 'list'` (naming the type of the
  first offending argument, positionals first, then keywords in sorted name order). If a custom `key`
  function returns an unhashable value the message is `unhashable key of type 'list'` likewise.
- Results (including `None`) are looked up with `cache.get`, so they feed the cache's stats and
  refresh recency; a result that is `None` is still a hit when it was stored. Exceptions raised by the
  function are propagated and nothing is stored.
- The wrapper is built with `functools.wraps`, and has `.cache` (the cache in use),
  `.cache_info()` and `.cache_clear()`.
- `cache_info()` returns a `CacheInfo` namedtuple `(hits, misses, maxsize, currsize)`. `hits` and `misses`
  count only this wrapper's own lookups (not other users of a shared cache); `maxsize` is
  `cache.max_size`; `currsize` is the number of live entries in the cache that belong to this function.
- `cache_clear()` removes only this function's entries from the cache and resets this wrapper's `hits`
  and `misses` to 0. Other users of a shared cache are unaffected; cache stats are not reset.
