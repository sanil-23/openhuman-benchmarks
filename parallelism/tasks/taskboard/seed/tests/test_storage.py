import json
import os
import tempfile
import unittest
from datetime import date
from unittest import mock

from taskboard import Board, SchemaVersionError, StorageError, load, save


class TestStorage(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.path = os.path.join(self.dir, "board.json")

    def tearDown(self):
        self._tmp.cleanup()

    def make_board(self):
        b = Board(wip_limits={"doing": 2})
        b.add_task("a", priority=4, due=date(2024, 5, 1), tags=["x", "y"])
        b.add_task("b")
        b.add_task("c", depends_on=[1, 2])
        b.move(2, "doing")
        return b

    def raw(self):
        with open(self.path, encoding="utf-8") as fh:
            return json.load(fh)

    def test_round_trip(self):
        b = self.make_board()
        save(b, self.path)
        r = load(self.path)
        self.assertEqual(r.tasks(), b.tasks())
        self.assertEqual(r.wip_limits, {"doing": 2})
        self.assertEqual(r.get(1).due, date(2024, 5, 1))
        self.assertEqual(r.get(1).tags, {"x", "y"})
        self.assertEqual(r.get(3).dependencies, [1, 2])

    def test_next_id_survives(self):
        b = self.make_board()
        b.remove_task(3)
        save(b, self.path)
        self.assertEqual(load(self.path).add_task("n").id, 4)

    def test_empty_tags_written_as_empty_list(self):
        save(self.make_board(), self.path)
        t = self.raw()["tasks"][1]
        self.assertEqual(t["tags"], [])
        self.assertIsNone(t["due"])
        self.assertEqual(load(self.path).get(2).tags, set())

    def test_file_format(self):
        save(self.make_board(), self.path)
        data = self.raw()
        self.assertEqual(data["version"], 1)
        self.assertEqual(data["next_id"], 4)
        self.assertEqual([t["id"] for t in data["tasks"]], [1, 2, 3])
        self.assertEqual(data["tasks"][0]["due"], "2024-05-01")

    def test_tags_written_sorted(self):
        b = Board()
        names = ["theta", "alpha", "eta", "gamma", "zeta", "beta", "delta", "epsilon"]
        b.add_task("a", tags=names)
        save(b, self.path)
        self.assertEqual(self.raw()["tasks"][0]["tags"], sorted(names))

    def test_unsupported_or_missing_version(self):
        for payload in ({"version": 2, "tasks": [], "next_id": 1},
                        {"tasks": [], "next_id": 1}):
            with open(self.path, "w") as fh:
                json.dump(payload, fh)
            with self.assertRaises(SchemaVersionError):
                load(self.path)
        self.assertTrue(issubclass(SchemaVersionError, StorageError))

    def test_invalid_json(self):
        with open(self.path, "w") as fh:
            fh.write("{nope")
        with self.assertRaises(StorageError):
            load(self.path)

    def test_failed_save_keeps_old_file_and_leaves_no_temp(self):
        save(self.make_board(), self.path)
        before = open(self.path, "rb").read()
        b = self.make_board()
        b.add_task("extra")
        with mock.patch("json.dump", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                save(b, self.path)
        self.assertEqual(open(self.path, "rb").read(), before)
        self.assertEqual(os.listdir(self.dir), ["board.json"])

    def test_save_uses_os_replace_and_leaves_only_target(self):
        with mock.patch("os.replace", wraps=os.replace) as rep:
            save(self.make_board(), self.path)
        self.assertEqual(rep.call_count, 1)
        self.assertEqual(rep.call_args[0][1], self.path)
        self.assertEqual(os.listdir(self.dir), ["board.json"])


if __name__ == "__main__":
    unittest.main()
