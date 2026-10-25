import unittest

from calc.errors import CalcSyntaxError
from calc.parser import Assign, Binary, Call, Compare, Num, Unary, Var, parse


def err(src):
    with unittest.TestCase().assertRaises(CalcSyntaxError) as cm:
        parse(src)
    return cm.exception.message, cm.exception.pos


class ParserTests(unittest.TestCase):
    def test_precedence(self):
        self.assertEqual(parse("1 + 2 * 3"),
                         [Binary("+", Num(1), Binary("*", Num(2), Num(3)))])
        self.assertEqual(parse("(1 + 2) * 3"),
                         [Binary("*", Binary("+", Num(1), Num(2)), Num(3))])

        self.assertEqual(parse("8 - 3 - 2"),
                         [Binary("-", Binary("-", Num(8), Num(3)), Num(2))])
        self.assertEqual(parse("8 / 4 // 2"),
                         [Binary("//", Binary("/", Num(8), Num(4)), Num(2))])

    def test_unary_minus_vs_power(self):
        self.assertEqual(parse("-2**2"), [Unary("-", Binary("**", Num(2), Num(2)))])
        self.assertEqual(parse("(-2)**2"), [Binary("**", Unary("-", Num(2)), Num(2))])

        self.assertEqual(parse("2**3**2"),
                         [Binary("**", Num(2), Binary("**", Num(3), Num(2)))])
        self.assertEqual(parse("2**-1"), [Binary("**", Num(2), Unary("-", Num(1)))])
        self.assertEqual(parse("- -3"), [Unary("-", Unary("-", Num(3)))])
        self.assertEqual(parse("+4"), [Unary("+", Num(4))])

    def test_number_values(self):
        self.assertEqual(parse("1_000"), [Num(1000)])
        self.assertIsInstance(parse("1_000")[0].value, int)
        self.assertIsInstance(parse("1e3")[0].value, float)
        self.assertEqual(parse("2.50"), [Num(2.5)])

        self.assertEqual(parse("f()"), [Call("f", [])])
        self.assertEqual(parse("max(1, a + 2, g(3))"),
                         [Call("max", [Num(1), Binary("+", Var("a"), Num(2)), Call("g", [Num(3)])])])

    def test_assignment(self):
        self.assertEqual(parse("x = 1 + 2"), [Assign("x", Binary("+", Num(1), Num(2)))])
        self.assertEqual(parse("ok = 1 < 2"), [Assign("ok", Compare("<", Num(1), Num(2)))])

        self.assertEqual(parse("1; 2\n3"), [Num(1), Num(2), Num(3)])
        self.assertEqual(parse(";;1;;\n\n2\n"), [Num(1), Num(2)])
        self.assertEqual(parse(""), [])
        self.assertEqual(parse("  \n ; "), [])

        self.assertEqual(parse("1 + 1 == 2"),
                         [Compare("==", Binary("+", Num(1), Num(1)), Num(2))])

    def test_chained_comparison_error(self):
        self.assertEqual(err("1 < 2 < 3"), ("chained comparison is not supported", 6))
        self.assertEqual(err("a == b != c"), ("chained comparison is not supported", 7))

    def test_unexpected_end(self):
        self.assertEqual(err("1 +"), ("unexpected end of input", 3))
        self.assertEqual(err("1 +\n2"), ("unexpected end of input", 3))
        self.assertEqual(err("x ="), ("unexpected end of input", 3))

    def test_unexpected_token(self):
        self.assertEqual(err("1 2"), ("unexpected token '2'", 2))
        self.assertEqual(err("x = y = 1"), ("unexpected token '='", 6))
        self.assertEqual(err("f(1,)"), ("unexpected token ')'", 4))
        self.assertEqual(err("1(2)"), ("unexpected token '('", 1))
        self.assertEqual(err("(1))"), ("unexpected token ')'", 3))
        self.assertEqual(err("* 2"), ("unexpected token '*'", 0))
        self.assertEqual(err("(x = 1)"), ("expected ')'", 3))

        self.assertEqual(err("(1 + 2"), ("expected ')'", 6))
        self.assertEqual(err("f(1 2)"), ("expected ')'", 4))
        self.assertEqual(err("(1 +\n2)"), ("unexpected end of input", 4))

        self.assertEqual(err("1 + $"), ("unexpected character '$'", 4))
