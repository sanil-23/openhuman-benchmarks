import unittest
from datetime import date

from taskboard import Task
from taskboard.query import (by_status, due_window, filter_by_tags, overdue,
                             sort_tasks)

D = date


def T(i, **kw):
    return Task(i, "t%d" % i, **kw)


class TestQuery(unittest.TestCase):
    def test_by_status(self):
        ts = [T(1), T(2, status="done"), T(3)]
        self.assertEqual([t.id for t in by_status(ts, "todo")], [1, 3])
        with self.assertRaises(ValueError):
            by_status(ts, "nope")

    def test_tags_any_and_all(self):
        ts = [T(1, tags={"a"}), T(2, tags={"a", "b"}), T(3, tags={"c"}), T(4)]
        self.assertEqual([t.id for t in filter_by_tags(ts, ["a", "c"])], [1, 2, 3])
        self.assertEqual([t.id for t in filter_by_tags(ts, ["a", "b"], mode="all")], [2])

    def test_empty_tag_filter(self):
        ts = [T(1, tags={"a"}), T(2)]
        self.assertEqual(filter_by_tags(ts, []), [])
        self.assertEqual(len(filter_by_tags(ts, [], mode="all")), 2)

    def test_bad_tag_mode(self):
        with self.assertRaises(ValueError):
            filter_by_tags([], ["a"], mode="most")

    def test_due_window_start_inclusive_end_exclusive(self):
        ts = [T(1, due=D(2024, 3, 1)), T(2, due=D(2024, 3, 15)),
              T(3, due=D(2024, 4, 1)), T(4, due=D(2024, 2, 29)), T(5)]
        got = due_window(ts, D(2024, 3, 1), D(2024, 4, 1))
        self.assertEqual([t.id for t in got], [1, 2])

    def test_due_window_open_bounds(self):
        ts = [T(1, due=D(2024, 1, 1)), T(2, due=D(2025, 1, 1)), T(3)]
        self.assertEqual([t.id for t in due_window(ts, start=D(2024, 6, 1))], [2])
        self.assertEqual([t.id for t in due_window(ts, end=D(2024, 6, 1))], [1])
        self.assertEqual([t.id for t in due_window(ts)], [1, 2])

    def test_overdue_is_strictly_before_today(self):
        ts = [T(1, due=D(2024, 5, 9)), T(2, due=D(2024, 5, 10)), T(3, due=D(2024, 5, 11)), T(4)]
        self.assertEqual([t.id for t in overdue(ts, D(2024, 5, 10))], [1])

    def test_overdue_ignores_done_tasks(self):
        ts = [T(1, due=D(2024, 1, 1), status="done"), T(2, due=D(2024, 1, 1), status="doing")]
        self.assertEqual([t.id for t in overdue(ts, D(2024, 6, 1))], [2])

    def test_sort_priority_descending(self):
        ts = [T(1, priority=2), T(2, priority=5), T(3, priority=3)]
        self.assertEqual([t.id for t in sort_tasks(ts)], [2, 3, 1])

    def test_sort_due_ascending_then_undated_last(self):
        ts = [T(1), T(2, due=D(2024, 5, 1)), T(3, due=D(2023, 1, 1)), T(4)]
        self.assertEqual([t.id for t in sort_tasks(ts)], [3, 2, 1, 4])

    def test_sort_id_breaks_ties_and_priority_beats_due(self):
        ts = [T(5, due=D(2024, 1, 1)), T(3, due=D(2024, 1, 1)),
              T(4, priority=4, due=D(2030, 1, 1)), T(2, priority=4)]
        self.assertEqual([t.id for t in sort_tasks(ts)], [4, 2, 3, 5])

    def test_queries_do_not_modify_input(self):
        ts = [T(2, priority=1), T(1, priority=5)]
        sort_tasks(ts)
        self.assertEqual([t.id for t in ts], [2, 1])


if __name__ == "__main__":
    unittest.main()
