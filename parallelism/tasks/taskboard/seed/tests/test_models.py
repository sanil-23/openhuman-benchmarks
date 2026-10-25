import unittest
from datetime import date

from taskboard import Task


class TestTask(unittest.TestCase):
    def test_defaults(self):
        t = Task(1, "write")
        self.assertEqual((t.status, t.priority, t.due), ("todo", 3, None))
        self.assertEqual(t.tags, set())
        self.assertEqual(t.dependencies, [])

    def test_invalid_status_rejected(self):
        with self.assertRaises(ValueError):
            Task(1, "x", status="blocked")

    def test_priority_range(self):
        for bad in (0, 6, -1, 2.5, True):
            with self.assertRaises(ValueError, msg=repr(bad)):
                Task(1, "x", priority=bad)
        self.assertEqual(Task(1, "x", priority=1).priority, 1)
        self.assertEqual(Task(1, "x", priority=5).priority, 5)

    def test_tasks_do_not_share_collections(self):
        a, b = Task(1, "a"), Task(2, "b")
        a.tags.add("x")
        a.dependencies.append(9)
        self.assertEqual(b.tags, set())
        self.assertEqual(b.dependencies, [])


if __name__ == "__main__":
    unittest.main()
