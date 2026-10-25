import unittest

from ttlcache.cache import Cache
from ttlcache.stats import CacheStats
from helpers import FakeClock


class BasicTests(unittest.TestCase):
    def test_set_get_delete_contains_len(self):
        c = Cache(max_size=4, clock=FakeClock())
        self.assertEqual(c.set("a", 1), [])
        c.set("b", 2)
        self.assertEqual(c.get("a"), 1)
        self.assertEqual(c.get("zzz", "dflt"), "dflt")
        self.assertIn("b", c)
        self.assertNotIn("q", c)
        self.assertEqual(len(c), 2)
        self.assertTrue(c.delete("a"))
        self.assertFalse(c.delete("a"))
        self.assertEqual(len(c), 1)

    def test_validation(self):
        for bad in (0, -1, 1.5, "3", None, True):
            with self.assertRaisesRegex(ValueError, "^max_size must be a positive integer$"):
                Cache(max_size=bad)
        for bad in (0, -5):
            with self.assertRaisesRegex(ValueError, "^ttl must be positive$"):
                Cache(default_ttl=bad)
        c = Cache()
        with self.assertRaisesRegex(ValueError, "^ttl must be positive$"):
            c.set("k", 1, ttl=0)
        self.assertNotIn("k", c)
        with self.assertRaises(ValueError):
            c.resize(0)
        self.assertEqual(c.max_size, 128)


class EvictionTests(unittest.TestCase):
    def test_lru_eviction_order(self):
        c = Cache(max_size=3, clock=FakeClock())
        for k in "abc":
            c.set(k, k)
        self.assertEqual(c.set("d", 4), ["a"])
        self.assertEqual(c.keys(), ["b", "c", "d"])
        self.assertEqual(c.stats.evictions, 1)

    def test_get_refreshes_recency_but_peek_and_contains_do_not(self):
        c = Cache(max_size=3, clock=FakeClock())
        for k in "abc":
            c.set(k, k)
        c.get("a")
        self.assertEqual(c.peek("b"), "b")
        self.assertIn("b", c)
        self.assertEqual(c.keys(), ["b", "c", "a"])
        self.assertEqual(c.set("d", 4), ["b"])

    def test_overwrite_refreshes_recency_and_never_evicts(self):
        c = Cache(max_size=2, clock=FakeClock())
        c.set("a", 1)
        c.set("b", 2)
        self.assertEqual(c.set("a", 10), [])
        self.assertEqual(c.keys(), ["b", "a"])
        self.assertEqual(c.get("a"), 10)
        self.assertEqual(c.set("c", 3), ["b"])
        self.assertEqual(c.stats.evictions, 1)

    def test_resize_evicts_oldest_first(self):
        c = Cache(max_size=5, clock=FakeClock())
        for k in "abcde":
            c.set(k, k)
        c.get("a")
        self.assertEqual(c.resize(2), ["b", "c", "d"])
        self.assertEqual(c.keys(), ["e", "a"])
        self.assertEqual(c.stats.evictions, 3)
        self.assertEqual(c.resize(10), [])
        self.assertEqual(c.max_size, 10)


class TTLTests(unittest.TestCase):
    def test_boundary_is_expired_at_exactly_ttl(self):
        clk = FakeClock()
        c = Cache(clock=clk)
        c.set("a", 1, ttl=10)
        clk.advance(9.999)
        self.assertEqual(c.get("a"), 1)
        clk.advance(0.001)
        clk.now = 110.0
        self.assertIsNone(c.get("a"))
        self.assertEqual(c.stats.expirations, 1)


    def test_no_ttl_never_expires_and_get_does_not_extend_ttl(self):
        clk = FakeClock()
        c = Cache(clock=clk)
        c.set("forever", 1)
        c.set("temp", 2, ttl=10)
        clk.advance(6)
        self.assertEqual(c.get("temp"), 2)
        clk.advance(4)
        self.assertIsNone(c.get("temp"))
        clk.advance(10 ** 6)
        self.assertEqual(c.get("forever"), 1)

    def test_overwrite_resets_set_time(self):
        clk = FakeClock()
        c = Cache(clock=clk)
        c.set("a", 1, ttl=10)
        clk.advance(8)
        c.set("a", 2, ttl=10)
        clk.advance(8)
        self.assertEqual(c.get("a"), 2)
        clk.advance(2)
        self.assertNotIn("a", c)

    def test_overwriting_expired_key_counts_expiration_not_eviction(self):
        clk = FakeClock()
        c = Cache(max_size=2, clock=clk)
        c.set("a", 1, ttl=1)
        clk.advance(1)
        self.assertEqual(c.set("a", 2), [])
        self.assertEqual(c.stats.expirations, 1)
        self.assertEqual(c.stats.evictions, 0)
        self.assertEqual(c.get("a"), 2)

    def test_expired_entries_are_purged_before_live_ones_are_evicted(self):
        clk = FakeClock()
        c = Cache(max_size=3, clock=clk)
        c.set("old", 1, ttl=1)
        c.set("b", 2)
        c.set("c", 3)
        clk.advance(1)
        self.assertEqual(c.set("d", 4), [])
        self.assertEqual(c.keys(), ["b", "c", "d"])
        self.assertEqual(c.stats.expirations, 1)
        self.assertEqual(c.stats.evictions, 0)

    def test_purge_and_lazy_removal_accounting(self):
        clk = FakeClock()
        c = Cache(clock=clk)
        for i in range(4):
            c.set(i, i, ttl=5)
        c.set("keep", 1)
        clk.advance(5)
        self.assertEqual(c.purge(), 4)
        self.assertEqual(c.purge(), 0)
        self.assertEqual(c.stats.expirations, 4)
        self.assertEqual(len(c), 1)
        c.set("x", 1, ttl=1)
        clk.advance(1)
        self.assertEqual(len(c), 1)
        self.assertEqual(c.stats.expirations, 5)

    def test_delete_and_peek_on_expired_entry(self):
        clk = FakeClock()
        c = Cache(clock=clk)
        c.set("a", 1, ttl=1)
        c.set("b", 2, ttl=1)
        clk.advance(1)
        self.assertFalse(c.delete("a"))
        self.assertEqual(c.peek("b", "gone"), "gone")
        self.assertEqual(c.stats.expirations, 2)
        self.assertEqual((c.stats.hits, c.stats.misses), (0, 0))


class StatsFeedTests(unittest.TestCase):
    def test_hits_and_misses(self):
        clk = FakeClock()
        c = Cache(clock=clk)
        c.set("a", 1, ttl=2)
        c.get("a")
        c.get("nope")
        c.peek("a")
        c.peek("nope")
        self.assertIn("a", c)
        clk.advance(2)
        c.get("a")
        snap = c.stats.snapshot()
        self.assertEqual((snap["hits"], snap["misses"], snap["expirations"]), (1, 2, 1))
        self.assertAlmostEqual(snap["hit_rate"], 1 / 3)


    def test_update_semantics(self):
        clk = FakeClock()
        c = Cache(max_size=2, default_ttl=10, clock=clk)
        self.assertEqual(c.update("n", lambda v: v + 1, default=0), 1)
        self.assertEqual(c.update("n", lambda v: v + 1, default=0), 2)
        self.assertEqual(c.peek("n"), 2)
        self.assertEqual((c.stats.hits, c.stats.misses), (0, 0))
        clk.advance(10)
        self.assertEqual(c.update("n", lambda v: v + 1, default=100), 101)
        self.assertEqual(c.stats.expirations, 1)
