import unittest

from ttlcache import Cache, cached, CacheInfo
from helpers import FakeClock


class DecoratorTests(unittest.TestCase):
    def test_memoises_and_reports_info(self):
        calls = []

        @cached()
        def f(x, y=0):
            """doc"""
            calls.append((x, y))
            return x + y

        self.assertEqual(f(1, y=2), 3)
        self.assertEqual(f(1, y=2), 3)
        self.assertEqual(f(2), 2)
        self.assertEqual(calls, [(1, 2), (2, 0)])
        info = f.cache_info()
        self.assertIsInstance(info, CacheInfo)
        self.assertEqual(tuple(info), (1, 2, 128, 2))
        self.assertEqual((f.__name__, f.__doc__), ("f", "doc"))
        self.assertIsInstance(f.cache, Cache)

    def test_kwargs_order_insensitive_and_distinct_shapes(self):
        calls = []

        @cached()
        def f(*args, **kwargs):
            calls.append(1)
            return len(calls)

        a = f(1, b=2, a=3)
        self.assertEqual(f(1, a=3, b=2), a)
        self.assertEqual(len(calls), 1)
        f(1)
        f(a=1)
        f((1, 2))
        f(1, 2)
        self.assertEqual(len(calls), 5)
        f(1.0)
        self.assertEqual(len(calls), 5)

    def test_unhashable_arguments_raise_clear_typeerror_without_calling(self):
        calls = []

        @cached()
        def f(*args, **kwargs):
            calls.append(1)

        with self.assertRaisesRegex(TypeError, "^unhashable argument of type 'list'$"):
            f(1, [2])
        with self.assertRaisesRegex(TypeError, "^unhashable argument of type 'dict'$"):
            f(1, k={})
        with self.assertRaisesRegex(TypeError, "^unhashable argument of type 'set'$"):
            f({1}, z={}, a=[])
        with self.assertRaisesRegex(TypeError, "^unhashable argument of type 'list'$"):
            f({}, a=[])  if False else f(1, b={}, a=[])
        self.assertEqual(calls, [])

    def test_custom_key_function(self):
        calls = []

        @cached(key=lambda x, verbose=False: x)
        def f(x, verbose=False):
            calls.append(x)
            return x * 2

        f(2)
        f(2, verbose=True)
        self.assertEqual(calls, [2])

        @cached(key=lambda x: [x])
        def g(x):
            return x

        with self.assertRaisesRegex(TypeError, "^unhashable key of type 'list'$"):
            g(1)

    def test_none_results_and_exceptions(self):
        calls = []

        @cached()
        def f(x):
            calls.append(x)
            if x < 0:
                raise KeyError(x)
            return None

        self.assertIsNone(f(1))
        self.assertIsNone(f(1))
        self.assertEqual(f.cache_info().hits, 1)
        for _ in range(2):
            with self.assertRaises(KeyError):
                f(-1)
        self.assertEqual(calls, [1, -1, -1])
        self.assertEqual(f.cache_info().currsize, 1)

    def test_ttl_expiry_with_shared_cache_clock(self):
        clk = FakeClock()
        cache = Cache(clock=clk)
        calls = []

        @cached(cache=cache, ttl=10)
        def f(x):
            calls.append(x)
            return x

        f(1)
        clk.advance(9)
        f(1)
        clk.advance(1)
        f(1)
        self.assertEqual(calls, [1, 1])
        self.assertEqual(cache.stats.expirations, 1)
        self.assertEqual((cache.stats.hits, cache.stats.misses), (1, 2))

    def test_shared_cache_no_collisions_and_selective_clear(self):
        cache = Cache(max_size=10, clock=FakeClock())

        @cached(cache=cache)
        def f(x):
            return ("f", x)

        @cached(cache=cache)
        def g(x):
            return ("g", x)

        cache.set("plain", 1)
        self.assertEqual((f(1), g(1)), (("f", 1), ("g", 1)))
        f(1)
        self.assertEqual(f.cache_info().currsize, 1)
        f.cache_clear()
        self.assertEqual(tuple(f.cache_info()), (0, 0, 10, 0))
        self.assertEqual(g.cache_info().currsize, 1)
        self.assertEqual(cache.peek("plain"), 1)
        self.assertEqual(cache.stats.hits, 1)

    def test_eviction_through_small_cache(self):
        cache = Cache(max_size=2, clock=FakeClock())

        @cached(cache=cache)
        def f(x):
            return x

        f(1), f(2), f(1), f(3)
        self.assertEqual(cache.stats.evictions, 1)
        f(2)
        self.assertEqual(f.cache_info().misses, 4)
