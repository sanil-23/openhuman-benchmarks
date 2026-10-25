import io
import os
import subprocess
import sys
import unittest

from calc.cli import main
from calc.evaluator import Environment
from calc.repl import format_value, run

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def cli(argv, stdin=""):
    out, err = io.StringIO(), io.StringIO()
    code = main(argv, io.StringIO(stdin), out, err)
    return code, out.getvalue(), err.getvalue()


class ReplTests(unittest.TestCase):
    def test_run_returns_last_statement(self):
        self.assertEqual(run("x = 3; x * 2"), 6)
        self.assertEqual(run("1\n2\n3"), 3)

    def test_run_empty_is_none(self):
        self.assertIsNone(run(""))
        self.assertIsNone(run(" ; \n"))

    def test_run_shares_given_env(self):
        env = Environment()
        run("q = 7", env)
        self.assertEqual(run("q + 1", env), 8)

    def test_format_value(self):
        self.assertEqual(format_value(True), "true")
        self.assertEqual(format_value(False), "false")
        self.assertEqual(format_value(7), "7")
        self.assertEqual(format_value(-4), "-4")
        self.assertEqual(format_value(2.0), "2.0")
        self.assertEqual(format_value(0.1), "0.1")
        self.assertEqual(format_value(1e3), "1000.0")


class CliTests(unittest.TestCase):
    def test_prints_value(self):
        self.assertEqual(cli(["1+2"]), (0, "3\n", ""))
        self.assertEqual(cli(["-2**2"]), (0, "-4\n", ""))
        self.assertEqual(cli(["1 < 2"]), (0, "true\n", ""))
        self.assertEqual(cli(["x = 4; x ** 2 / 8"]), (0, "2.0\n", ""))

    def test_stdin(self):
        self.assertEqual(cli(["-"], "a = 2\nb = 3\na * b\n"), (0, "6\n", ""))

    def test_empty_program_prints_nothing(self):
        self.assertEqual(cli([""]), (0, "", ""))
        self.assertEqual(cli(["-"], "\n\n"), (0, "", ""))

    def test_error_with_position(self):
        self.assertEqual(cli(["3 $ 4"]), (2, "", "error: unexpected character '$' (at 2)\n"))
        self.assertEqual(cli(["1 < 2 < 3"]),
                         (2, "", "error: chained comparison is not supported (at 6)\n"))

    def test_error_without_position(self):
        self.assertEqual(cli(["1 / 0"]), (2, "", "error: division by zero\n"))
        self.assertEqual(cli(["y"]), (2, "", "error: undefined variable 'y'\n"))

    def test_usage(self):
        for argv in ([], ["1", "2"]):
            code, out, err = cli(argv)
            self.assertEqual((code, out), (2, ""))
            self.assertEqual(err, "usage: python -m calc EXPR | -\n")

    def test_python_dash_m(self):
        p = subprocess.run([sys.executable, "-m", "calc", "2**3**2"], cwd=ROOT,
                           capture_output=True, text=True, timeout=10)
        self.assertEqual((p.returncode, p.stdout, p.stderr), (0, "512\n", ""))
        p = subprocess.run([sys.executable, "-m", "calc", "-"], cwd=ROOT, input="7 // -2",
                           capture_output=True, text=True, timeout=10)
        self.assertEqual((p.returncode, p.stdout), (0, "-4\n"))
        p = subprocess.run([sys.executable, "-m", "calc", "1 +"], cwd=ROOT,
                           capture_output=True, text=True, timeout=10)
        self.assertEqual((p.returncode, p.stdout, p.stderr),
                         (2, "", "error: unexpected end of input (at 3)\n"))
