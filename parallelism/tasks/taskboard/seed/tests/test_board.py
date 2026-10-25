import unittest

from taskboard import (Board, BoardError, CycleError, DependencyError,
                       UnknownTaskError, WipLimitError)


class TestBoardBasics(unittest.TestCase):
    def test_ids_sequential_and_never_reused(self):
        b = Board()
        self.assertEqual([b.add_task("a").id, b.add_task("b").id], [1, 2])
        b.remove_task(2)
        self.assertEqual(b.add_task("c").id, 3)

    def test_new_task_goes_to_todo(self):
        b = Board()
        t = b.add_task("a", priority=5, tags=["x"])
        self.assertEqual((t.status, t.priority, t.tags), ("todo", 5, {"x"}))
        self.assertEqual(b.column("todo"), [t])

    def test_unknown_task(self):
        b = Board()
        for call in (lambda: b.get(7), lambda: b.move(7, "doing"),
                     lambda: b.remove_task(7), lambda: b.add_task("x", depends_on=[7])):
            with self.assertRaises(UnknownTaskError):
                call()

    def test_invalid_limit_config(self):
        for bad in ({"review": 2}, {"doing": 0}):
            with self.assertRaises(ValueError):
                Board(wip_limits=bad)

    def test_exception_hierarchy(self):
        self.assertTrue(issubclass(CycleError, DependencyError))
        self.assertTrue(issubclass(DependencyError, BoardError))
        self.assertTrue(issubclass(WipLimitError, BoardError))

    def test_tasks_without_dependencies_stay_independent(self):
        b = Board()
        a, c = b.add_task("a"), b.add_task("c")
        d = b.add_task("d")
        b.add_dependency(a.id, d.id)
        self.assertEqual(a.dependencies, [d.id])
        self.assertEqual(c.dependencies, [])
        self.assertEqual(b.add_task("e").dependencies, [])

    def test_remove_drops_dependency_references(self):
        b = Board()
        a, c = b.add_task("a"), b.add_task("c", depends_on=[1])
        b.remove_task(a.id)
        self.assertEqual(c.dependencies, [])
        self.assertEqual([t.id for t in b.tasks()], [2])


class TestWip(unittest.TestCase):
    def setUp(self):
        self.b = Board(wip_limits={"doing": 2})
        self.ids = [self.b.add_task(n).id for n in "abcd"]

    def test_column_can_fill_to_its_limit(self):
        self.b.move(self.ids[0], "doing")
        self.b.move(self.ids[1], "doing")
        self.assertEqual(len(self.b.column("doing")), 2)

    def test_move_into_full_column_raises(self):
        self.b.move(self.ids[0], "doing")
        self.b.move(self.ids[1], "doing")
        with self.assertRaises(WipLimitError):
            self.b.move(self.ids[2], "doing")
        self.assertEqual(self.b.get(self.ids[2]).status, "todo")

    def test_leaving_a_column_frees_a_slot(self):
        self.b.move(1, "doing")
        self.b.move(2, "doing")
        self.b.move(1, "done")
        self.b.move(3, "doing")
        self.assertEqual([t.id for t in self.b.column("doing")], [2, 3])

    def test_moving_within_same_column_is_a_noop(self):
        self.b.move(1, "doing")
        self.b.move(2, "doing")
        self.assertEqual(self.b.move(1, "doing").status, "doing")

    def test_unlimited_columns(self):
        for i in self.ids:
            self.b.move(i, "done")
        self.assertEqual(len(self.b.column("done")), 4)

    def test_todo_limit_applies_to_new_tasks(self):
        b = Board(wip_limits={"todo": 1})
        b.add_task("a")
        with self.assertRaises(WipLimitError):
            b.add_task("b")


class TestDependencies(unittest.TestCase):
    def setUp(self):
        self.b = Board()
        self.a, self.c, self.d = (self.b.add_task(n) for n in "acd")

    def test_blocked_until_dependency_done(self):
        self.b.add_dependency(self.a.id, self.c.id)
        for target in ("doing", "done"):
            with self.assertRaises(DependencyError):
                self.b.move(self.a.id, target)
        self.b.move(self.c.id, "doing")
        with self.assertRaises(DependencyError):
            self.b.move(self.a.id, "doing")
        self.b.move(self.c.id, "done")
        self.assertEqual(self.b.move(self.a.id, "doing").status, "doing")

    def test_moving_back_to_todo_is_never_blocked(self):
        self.b.add_dependency(self.a.id, self.c.id)
        self.b.move(self.c.id, "done")
        self.b.move(self.a.id, "done")
        self.b.move(self.c.id, "todo")
        self.assertEqual(self.b.move(self.a.id, "todo").status, "todo")

    def test_self_dependency_is_a_cycle(self):
        with self.assertRaises(CycleError):
            self.b.add_dependency(self.a.id, self.a.id)

    def test_two_task_cycle(self):
        self.b.add_dependency(self.a.id, self.c.id)
        with self.assertRaises(CycleError):
            self.b.add_dependency(self.c.id, self.a.id)
        self.assertEqual(self.c.dependencies, [])

    def test_three_task_cycle(self):
        self.b.add_dependency(self.a.id, self.c.id)
        self.b.add_dependency(self.c.id, self.d.id)
        with self.assertRaises(CycleError):
            self.b.add_dependency(self.d.id, self.a.id)
        self.assertEqual(self.d.dependencies, [])

    def test_diamond_is_not_a_cycle(self):
        e = self.b.add_task("e")
        self.b.add_dependency(self.a.id, self.c.id)
        self.b.add_dependency(self.a.id, self.d.id)
        self.b.add_dependency(self.c.id, e.id)
        self.b.add_dependency(self.d.id, e.id)
        self.assertEqual(self.a.dependencies, [self.c.id, self.d.id])

    def test_duplicate_dependency_ignored(self):
        self.b.add_dependency(self.a.id, self.c.id)
        self.b.add_dependency(self.a.id, self.c.id)
        self.assertEqual(self.a.dependencies, [self.c.id])


if __name__ == "__main__":
    unittest.main()
