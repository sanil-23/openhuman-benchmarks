from dataclasses import dataclass

from .errors import CalcSyntaxError


@dataclass(frozen=True)
class Token:
    kind: str
    text: str
    pos: int


_OPS3 = ()
_OPS2 = ("**", "//", "==", "!=", "<=", ">=")
_OPS1 = "+-*/%<>"
_PUNCT = {"(": "LPAREN", ")": "RPAREN", ",": "COMMA", "=": "ASSIGN", ";": "SEP", "\n": "SEP"}


def _digits(s, i):
    """Match digits(_digits)* at i; return end index (i if none)."""
    n = len(s)
    if i >= n or not s[i].isascii() or not s[i].isdigit():
        return i
    while True:
        while i < n and s[i].isascii() and s[i].isdigit():
            i += 1
        if i + 1 < n and s[i] == "_" and s[i + 1].isascii() and s[i + 1].isdigit():
            i += 1
            continue
        return i


def tokenize(source):
    tokens = []
    i = 0
    n = len(source)
    while i < n:
        c = source[i]
        if c in " \t\r":
            i += 1
        elif c.isascii() and c.isdigit():
            start = i
            i = _digits(source, i)
            if i + 1 < n and source[i] == "." and source[i + 1].isascii() and source[i + 1].isdigit():
                i = _digits(source, i + 1)
            if i < n and source[i] in "eE":
                j = i + 1
                if j < n and source[j] in "+-":
                    j += 1
                k = _digits(source, j)
                if k > j:
                    i = k
            if i < n and (source[i].isalnum() or source[i] in "_."):
                raise CalcSyntaxError("invalid number", start)
            tokens.append(Token("NUMBER", source[start:i], start))
        elif c.isascii() and (c.isalpha() or c == "_"):
            start = i
            while i < n and source[i].isascii() and (source[i].isalnum() or source[i] == "_"):
                i += 1
            tokens.append(Token("IDENT", source[start:i], start))
        elif source[i:i + 2] in _OPS2:
            tokens.append(Token("OP", source[i:i + 2], i))
            i += 2
        elif c in _OPS1:
            tokens.append(Token("OP", c, i))
            i += 1
        elif c in _PUNCT:
            tokens.append(Token(_PUNCT[c], c, i))
            i += 1
        else:
            raise CalcSyntaxError("unexpected character %r" % c, i)
    tokens.append(Token("EOF", "", n))
    return tokens
