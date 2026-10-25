from dataclasses import dataclass

from .errors import CalcSyntaxError
from .lexer import tokenize


@dataclass
class Num:
    value: object


@dataclass
class Var:
    name: str


@dataclass
class Unary:
    op: str
    operand: object


@dataclass
class Binary:
    op: str
    left: object
    right: object


@dataclass
class Compare:
    op: str
    left: object
    right: object


@dataclass
class Call:
    name: str
    args: list


@dataclass
class Assign:
    name: str
    value: object


_CMP = ("==", "!=", "<", "<=", ">", ">=")


class _Parser:
    def __init__(self, source):
        self.toks = tokenize(source)
        self.i = 0

    @property
    def tok(self):
        return self.toks[self.i]

    def advance(self):
        t = self.toks[self.i]
        self.i += 1
        return t

    def is_op(self, *ops):
        return self.tok.kind == "OP" and self.tok.text in ops

    def unexpected(self):
        t = self.tok
        if t.kind in ("EOF", "SEP"):
            return CalcSyntaxError("unexpected end of input", t.pos)
        return CalcSyntaxError("unexpected token %r" % t.text, t.pos)

    def program(self):
        stmts = []
        while True:
            while self.tok.kind == "SEP":
                self.advance()
            if self.tok.kind == "EOF":
                return stmts
            stmts.append(self.statement())
            if self.tok.kind not in ("SEP", "EOF"):
                raise self.unexpected()

    def statement(self):
        if self.tok.kind == "IDENT" and self.toks[self.i + 1].kind == "ASSIGN":
            name = self.advance().text
            self.advance()
            return Assign(name, self.comparison())
        return self.comparison()

    def comparison(self):
        left = self.additive()
        if self.is_op(*_CMP):
            op = self.advance().text
            right = self.additive()
            if self.is_op(*_CMP):
                raise CalcSyntaxError("chained comparison is not supported", self.tok.pos)
            return Compare(op, left, right)
        return left

    def additive(self):
        left = self.term()
        while self.is_op("+", "-"):
            op = self.advance().text
            left = Binary(op, left, self.term())
        return left

    def term(self):
        left = self.unary()
        while self.is_op("*", "/", "//", "%"):
            op = self.advance().text
            left = Binary(op, left, self.unary())
        return left

    def unary(self):
        if self.is_op("+", "-"):
            op = self.advance().text
            return Unary(op, self.unary())
        return self.power()

    def power(self):
        base = self.atom()
        if self.is_op("**"):
            self.advance()
            return Binary("**", base, self.unary())
        return base

    def atom(self):
        t = self.tok
        if t.kind == "NUMBER":
            self.advance()
            text = t.text.replace("_", "")
            if text.isdigit():
                return Num(int(text))
            return Num(float(text))
        if t.kind == "IDENT":
            self.advance()
            if self.tok.kind == "LPAREN":
                self.advance()
                args = []
                if self.tok.kind != "RPAREN":
                    args.append(self.comparison())
                    while self.tok.kind == "COMMA":
                        self.advance()
                        args.append(self.comparison())
                if self.tok.kind != "RPAREN":
                    raise CalcSyntaxError("expected ')'", self.tok.pos)
                self.advance()
                return Call(t.text, args)
            return Var(t.text)
        if t.kind == "LPAREN":
            self.advance()
            inner = self.comparison()
            if self.tok.kind != "RPAREN":
                raise CalcSyntaxError("expected ')'", self.tok.pos)
            self.advance()
            return inner
        raise self.unexpected()


def parse(source):
    return _Parser(source).program()
