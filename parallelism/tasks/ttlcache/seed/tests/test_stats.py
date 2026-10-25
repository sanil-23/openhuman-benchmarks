import unittest

from ttlcache.stats import CacheStats


class StatsTests(unittest.TestCase):
    def test_initial_and_hit_rate(self):
        s = CacheStats()
        self.assertEqual((s.hits, s.misses, s.evictions, s.expirations), (0, 0, 0, 0))
        self.assertEqual(s.hit_rate, 0.0)
        s.record_hit()
        s.record_hit()
        s.record_hit()
        s.record_miss()
        self.assertAlmostEqual(s.hit_rate, 0.75)


    def test_snapshot_is_independent_copy_and_reset(self):
        s = CacheStats()
        s.record_eviction(3)
        s.record_eviction()
        s.record_expiration(2)
        s.record_hit()
        s.record_miss()
        snap = s.snapshot()
        self.assertEqual(set(snap), {"hits", "misses", "evictions", "expirations", "hit_rate"})
        self.assertEqual(snap["hit_rate"], 0.5)
        self.assertEqual((snap["evictions"], snap["expirations"]), (4, 2))
        s.record_hit()
        self.assertEqual(snap["hits"], 1)
        s.reset()
        self.assertEqual(s.snapshot(),
                         {"hits": 0, "misses": 0, "evictions": 0, "expirations": 0, "hit_rate": 0.0})
