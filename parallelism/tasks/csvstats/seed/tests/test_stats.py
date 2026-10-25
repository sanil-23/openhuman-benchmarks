import math
import unittest

from csvstats.stats import aggregate, describe, group_by, percentile


class StatsTests(unittest.TestCase):
    def test_describe(self):
        d = describe([1, 2, 3, 4, None, "x"])
        self.assertEqual(d["count"], 4)
        self.assertAlmostEqual(d["mean"], 2.5)
        self.assertAlmostEqual(d["median"], 2.5)
        self.assertAlmostEqual(d["stdev"], math.sqrt(5 / 3))
        self.assertEqual((d["min"], d["max"]), (1, 4))

    def test_describe_edges(self):
        self.assertEqual(describe([]), {"count": 0})
        self.assertEqual(describe([None])["count"], 0)
        self.assertEqual(describe([7])["stdev"], 0.0)

    def test_percentile(self):
        xs = [15, 20, 35, 40, 50]
        self.assertAlmostEqual(percentile(xs, 0), 15)
        self.assertAlmostEqual(percentile(xs, 40), 29.0)
        self.assertAlmostEqual(percentile(xs, 100), 50)
        self.assertAlmostEqual(percentile([1, 2], 50), 1.5)

    def test_percentile_errors(self):
        with self.assertRaises(ValueError):
            percentile([], 50)
        with self.assertRaises(ValueError):
            percentile([1], 101)

    def test_group_by_order_and_none(self):
        rows = [{"k": "b"}, {"k": "a"}, {"k": None}, {}, {"k": "b"}]
        g = group_by(rows, "k")
        self.assertEqual(list(g), ["b", "a", "(none)"])
        self.assertEqual(len(g["b"]), 2)
        self.assertEqual(len(g["(none)"]), 2)

    def test_aggregate(self):
        rows = [{"g": "x", "v": 1}, {"g": "y", "v": 10}, {"g": "x", "v": 3}, {"g": "x", "v": None}]
        out = aggregate(rows, "g", "v", ["count", "sum", "mean", "p50", "max"])
        self.assertEqual(out[0], {"g": "x", "v_count": 2, "v_sum": 4, "v_mean": 2.0, "v_p50": 2.0, "v_max": 3})
        self.assertEqual(out[1]["g"], "y")

    def test_aggregate_unknown_func(self):
        with self.assertRaises(ValueError):
            aggregate([{"g": 1, "v": 1}], "g", "v", ["bogus"])


if __name__ == "__main__":
    unittest.main()
