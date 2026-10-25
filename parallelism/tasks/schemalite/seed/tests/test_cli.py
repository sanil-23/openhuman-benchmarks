import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest

from schemalite import cli

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class CliTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def write(self, name, obj, raw=False):
        p = os.path.join(self._tmp.name, name)
        with open(p, "w", encoding="utf-8") as f:
            f.write(obj if raw else json.dumps(obj))
        return p

    def run_main(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli.main(list(args))
        return code, out.getvalue(), err.getvalue()

    def test_valid_exit_zero_silent(self):
        s = self.write("s.json", {"type": "object"})
        i = self.write("i.json", {"a": 1})
        self.assertEqual(self.run_main(s, i), (0, "", ""))

    def test_invalid_prints_lines_exit_one(self):
        s = self.write("s.json", {"type": "object", "required": ["id"], "properties": {"n": {"type": "integer"}}})
        i = self.write("i.json", {"n": "x"})
        code, out, err = self.run_main(s, i)
        self.assertEqual((code, err), (1, ""))
        lines = out.splitlines()
        self.assertEqual(len(lines), 2)
        self.assertTrue(lines[0].startswith("/ required: "), lines[0])
        self.assertTrue(lines[1].startswith("/n type: "), lines[1])
        self.assertTrue(lines[1][len("/n type: "):].strip())

    def test_root_path_printed_as_slash(self):
        s = self.write("s.json", {"type": "string"})
        i = self.write("i.json", 5)
        code, out, _ = self.run_main(s, i)
        self.assertEqual(code, 1)
        self.assertTrue(out.startswith("/ type: "))

    def test_usage_and_io_and_json_errors(self):
        s = self.write("s.json", {})
        bad = self.write("bad.json", "{nope", raw=True)
        cases = [
            [],
            [s],
            [s, s, s],
            [s, os.path.join(self._tmp.name, "missing.json")],
            [bad, s],
            [s, bad],
        ]
        for args in cases:
            code, out, err = self.run_main(*args)
            self.assertEqual(code, 2, args)
            self.assertEqual(out, "", args)
            self.assertTrue(err.startswith("error: "), err)
            self.assertEqual(len(err.strip().splitlines()), 1, err)
        self.assertIn("usage:", self.run_main()[2])

    def test_schema_error_exit_two(self):
        s = self.write("s.json", {"$ref": "#/definitions/nope"})
        i = self.write("i.json", 1)
        code, out, err = self.run_main(s, i)
        self.assertEqual((code, out), (2, ""))
        self.assertTrue(err.startswith("error: "))

    def test_python_dash_m_entry_point(self):
        s = self.write("s.json", {"maximum": 3})
        i = self.write("i.json", 9)
        r = subprocess.run([sys.executable, "-m", "schemalite", s, i], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertTrue(r.stdout.startswith("/ maximum: "))
        r = subprocess.run([sys.executable, "-m", "schemalite"], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertTrue(r.stderr.startswith("error: "))
