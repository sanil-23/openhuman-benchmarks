import threading
import unittest

from ttlcache import Cache, CacheStats, cached

THREADS, ITERS = 8, 500


def run_threads(fn):
    errors = []
    barrier = threading.Barrier(THREADS)

    def worker():
        try:
            barrier.wait()
            fn()
        except BaseException as e:  # noqa
            errors.append(e)

    ts = [threading.Thread(target=worker) for _ in range(THREADS)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    return errors


class ThreadTests(unittest.TestCase):
    def test_update_loses_no_increments(self):
        c = Cache(max_size=10)
        errors = run_threads(lambda: [c.update("n", lambda v: v + 1, default=0) for _ in range(ITERS)])
        self.assertEqual(errors, [])
        self.assertEqual(c.peek("n"), THREADS * ITERS)


    def test_stats_and_eviction_under_contention(self):
        s = CacheStats()
        c = Cache(max_size=4, stats=s)
        errors = run_threads(lambda: [c.set(i, i) for i in range(ITERS)])
        self.assertEqual(errors, [])
        self.assertEqual(len(c), 4)
        s2 = CacheStats()
        errors = run_threads(lambda: [s2.record_hit() or s2.record_miss() for _ in range(ITERS)])
        self.assertEqual(errors, [])
        self.assertEqual((s2.hits, s2.misses), (THREADS * ITERS,) * 2)
