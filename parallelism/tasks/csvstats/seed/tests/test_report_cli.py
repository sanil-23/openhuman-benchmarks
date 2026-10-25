import io
import json
import os
import subprocess
import sys
import tempfile
import unittest

from csvstats.report import render_json, render_table

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run(args, stdin=None):
    return subprocess.run([sys.executable, "-m", "csvstats", *args], cwd=ROOT, input=stdin, capture_output=True, text=True)


class ReportTests(unittest.TestCase):
    def test_table(self):
        out = render_table([{"name": "alpha", "v": 1.5}, {"name": "b", "v": None}])
        self.assertEqual(
            out,
            "| name  |    v |\n| :---- | ---: |\n| alpha | 1.50 |\n| b     |      |\n",
        )

    def test_json(self):
        self.assertEqual(json.loads(render_json([{"a": 1}])), [{"a": 1}])
        self.assertTrue(render_json([]).endswith("\n"))


class CliTests(unittest.TestCase):
    CSV = "team,score\nred,10\nblue,20\nred,30\n"

    def test_grouped_json(self):
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as f:
            f.write(self.CSV)
        r = run([f.name, "--group-by", "team", "--column", "score", "--stats", "count,mean,p50", "--format", "json"])
        self.assertEqual(r.returncode, 0, r.stderr)
        data = json.loads(r.stdout)
        self.assertEqual(data[0], {"team": "red", "score_count": 2, "score_mean": 20.0, "score_p50": 20.0})

    def test_stdin_ungrouped_table(self):
        r = run(["-", "--column", "score"], stdin=self.CSV)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("score_count", r.stdout)
        self.assertIn("all", r.stdout)

    def test_errors_exit_2(self):
        for args, stdin in ((["/nonexistent.csv", "--column", "x"], None), (["-", "--column", "nope"], self.CSV), (["-", "--column", "score", "--stats", "zzz"], self.CSV)):
            r = run(args, stdin)
            self.assertEqual(r.returncode, 2, args)
            self.assertTrue(r.stderr.startswith("error: "), r.stderr)


if __name__ == "__main__":
    unittest.main()
