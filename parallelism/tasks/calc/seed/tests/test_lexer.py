import unittest

from calc.errors import CalcError, CalcSyntaxError
from calc.lexer import Token, tokenize


def kt(src):
    return [(t.kind, t.text) for t in tokenize(src)]


class LexerTests(unittest.TestCase):
    def test_numbers_and_positions(self):
        toks = tokenize("12 3.5 1e3 1.5E-2")
        self.assertEqual(toks[0], Token("NUMBER", "12", 0))
        self.assertEqual([t.text for t in toks[:4]], ["12", "3.5", "1e3", "1.5E-2"])
        self.assertEqual([t.pos for t in toks], [0, 3, 7, 11, 17])
        self.assertEqual(toks[-1], Token("EOF", "", 17))

        self.assertEqual(kt("1_000"), [("NUMBER", "1_000"), ("EOF", "")])
        self.assertEqual(kt("1_0.2_5")[0], ("NUMBER", "1_0.2_5"))

    def test_bad_underscores(self):
        for src, pos in [("1_", 0), ("1__0", 0), ("  2x", 2), ("1e", 0), ("1.5.2", 0), ("1.", 0)]:
            with self.subTest(src=src):
                with self.assertRaises(CalcSyntaxError) as cm:
                    tokenize(src)
                self.assertEqual(cm.exception.message, "invalid number")
                self.assertEqual(cm.exception.pos, pos)

        with self.assertRaises(CalcSyntaxError) as cm:
            tokenize("x + .5")
        self.assertEqual((cm.exception.message, cm.exception.pos), ("unexpected character '.'", 4))

    def test_operators_longest_match(self):
        src = "** // == != <= >= < > * / % + -"
        self.assertEqual([t.text for t in tokenize(src)][:-1], src.split())
        self.assertTrue(all(t.kind == "OP" for t in tokenize(src)[:-1]))

        self.assertEqual(kt("a=b==c"), [("IDENT", "a"), ("ASSIGN", "="), ("IDENT", "b"),
                                         ("OP", "=="), ("IDENT", "c"), ("EOF", "")])

        self.assertEqual(kt("f(a,b);\n"), [("IDENT", "f"), ("LPAREN", "("), ("IDENT", "a"),
                                           ("COMMA", ","), ("IDENT", "b"), ("RPAREN", ")"),
                                           ("SEP", ";"), ("SEP", "\n"), ("EOF", "")])

        self.assertEqual(len(tokenize(" \t\r 1 \t")), 2)
        self.assertEqual(tokenize("")[0], Token("EOF", "", 0))

        self.assertEqual(kt("_x1 abc_9")[:2], [("IDENT", "_x1"), ("IDENT", "abc_9")])

    def test_unexpected_character(self):
        for src, ch, pos in [("3 $ 4", "$", 2), ("a ! b", "!", 2), ("x\n?", "?", 2)]:
            with self.subTest(src=src):
                with self.assertRaises(CalcSyntaxError) as cm:
                    tokenize(src)
                self.assertEqual(cm.exception.message, "unexpected character %r" % ch)
                self.assertEqual(cm.exception.pos, pos)
                self.assertIsInstance(cm.exception, CalcError)
                self.assertEqual(str(cm.exception), cm.exception.message)
