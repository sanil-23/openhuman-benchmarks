import math
import unittest

from calc.errors import (CalcError, CalcNameError, CalcTypeError,
                         CalcZeroDivisionError)
from calc.evaluator import Environment, evaluate
from calc.parser import parse


def ev(src, env=None):
    env = env or Environment()
    result = None
    for stmt in parse(src):
        result = evaluate(stmt, env)
    return result


class EvaluatorTests(unittest.TestCase):
    def assertSame(self, got, want):
        self.assertEqual(got, want)
        self.assertIs(type(got), type(want))

    def test_int_float_rules(self):
        self.assertSame(ev("2 + 3"), 5)
        self.assertSame(ev("4 / 2"), 2.0)
        self.assertSame(ev("2 * 2.5"), 5.0)
        self.assertSame(ev("1e3"), 1000.0)
        self.assertSame(ev("1_000 + 1"), 1001)

    def test_floor_div_and_mod(self):
        self.assertSame(ev("7 // -2"), -4)
        self.assertSame(ev("-7 // 2"), -4)
        self.assertSame(ev("7.5 // 2"), 3.0)
        self.assertSame(ev("-7 % 3"), 2)
        self.assertSame(ev("7 % -3"), -2)
        self.assertSame(ev("7.5 % 2"), 1.5)

    def test_power(self):
        self.assertSame(ev("-2**2"), -4)
        self.assertSame(ev("2**3**2"), 512)
        self.assertSame(ev("(-2)**2"), 4)
        self.assertSame(ev("2**-1"), 0.5)
        self.assertSame(ev("2**0.5 * 2**0.5 > 1.99"), True)

    def test_comparisons_return_bool(self):
        self.assertIs(ev("1 < 2"), True)
        self.assertIs(ev("2 <= 1"), False)
        self.assertIs(ev("1 == 1.0"), True)
        self.assertIs(ev("1 != 1"), False)
        self.assertIs(ev("1 + 1 >= 2"), True)

    def test_variables_and_constants(self):
        env = Environment({"a": 10})
        self.assertEqual(ev("a * 2", env), 20)
        self.assertEqual(ev("pi", env), math.pi)
        self.assertEqual(ev("e", env), math.e)
        self.assertEqual(ev("b = a + 1; b * 2", env), 22)
        self.assertEqual(env.variables["b"], 11)

    def test_environment_copies_variables(self):
        src = {"a": 1}
        env = Environment(src)
        ev("a = 5; z = 1", env)
        self.assertEqual(src, {"a": 1})
        self.assertNotIn("z", Environment().variables)

    def test_assignment_value(self):
        self.assertSame(ev("x = 2 * 3"), 6)
        self.assertIs(ev("x = 1 < 2"), True)

    def test_builtins(self):
        self.assertSame(ev("min(3, 1, 2)"), 1)
        self.assertSame(ev("max(3, 1.5)"), 3)
        self.assertSame(ev("abs(-4)"), 4)
        self.assertSame(ev("sqrt(16)"), 4.0)
        self.assertSame(ev("sum(1, 2, 3)"), 6)
        self.assertSame(ev("sum()"), 0)
        self.assertSame(ev("round(2.5)"), 2)
        self.assertSame(ev("round(3.5)"), 4)
        self.assertSame(ev("round(7)"), 7)
        self.assertSame(ev("round(3.14159, 2)"), 3.14)
        self.assertSame(ev("max(1, 2) + min(4)"), 6)

    def test_function_and_variable_namespaces(self):
        env = Environment()
        self.assertEqual(ev("max = 3; max(1, 2) + max", env), 5)

    def test_name_errors(self):
        with self.assertRaises(CalcNameError) as cm:
            ev("x + 1")
        self.assertEqual(cm.exception.message, "undefined variable 'x'")
        self.assertIsNone(cm.exception.pos)
        with self.assertRaises(CalcNameError) as cm:
            ev("foo(1)")
        self.assertEqual(cm.exception.message, "undefined function 'foo'")
        with self.assertRaises(CalcNameError) as cm:
            ev("pi(1)")
        self.assertEqual(cm.exception.message, "undefined function 'pi'")
        with self.assertRaises(CalcNameError) as cm:
            ev("max")
        self.assertEqual(cm.exception.message, "undefined variable 'max'")
        with self.assertRaises(CalcNameError) as cm:
            ev("nope(1/0)")
        self.assertEqual(cm.exception.message, "undefined function 'nope'")

    def test_zero_division(self):
        for src in ["1 / 0", "1 // 0", "1 % 0", "1.5 / 0.0", "0 ** -1", "5 % (2 - 2)"]:
            with self.subTest(src=src):
                with self.assertRaises(CalcZeroDivisionError) as cm:
                    ev(src)
                self.assertEqual(cm.exception.message, "division by zero")
                self.assertIsNone(cm.exception.pos)
                self.assertIsInstance(cm.exception, CalcError)

    def test_arity_errors(self):
        cases = [
            ("sqrt(1, 2)", "wrong number of arguments for 'sqrt': expected 1, got 2"),
            ("abs()", "wrong number of arguments for 'abs': expected 1, got 0"),
            ("min()", "wrong number of arguments for 'min': expected at least 1, got 0"),
            ("max()", "wrong number of arguments for 'max': expected at least 1, got 0"),
            ("round(1, 2, 3)", "wrong number of arguments for 'round': expected 1 to 2, got 3"),
            ("round()", "wrong number of arguments for 'round': expected 1 to 2, got 0"),
        ]
        for src, msg in cases:
            with self.subTest(src=src):
                with self.assertRaises(CalcTypeError) as cm:
                    ev(src)
                self.assertEqual(cm.exception.message, msg)
                self.assertIsNone(cm.exception.pos)

    def test_domain_errors(self):
        with self.assertRaises(CalcTypeError) as cm:
            ev("sqrt(0 - 4)")
        self.assertEqual(cm.exception.message, "sqrt() argument must be non-negative")
        with self.assertRaises(CalcTypeError) as cm:
            ev("(-8) ** 0.5")
        self.assertEqual(cm.exception.message, "result is not a real number")
