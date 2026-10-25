"""JSON pointer helpers (RFC 6901)."""

import re

_INDEX = re.compile(r"(0|[1-9][0-9]*)\Z")


def escape(token):
    return token.replace("~", "~0").replace("/", "~1")


def unescape(token):
    out = []
    i = 0
    while i < len(token):
        c = token[i]
        if c == "~":
            nxt = token[i + 1 : i + 2]
            if nxt == "0":
                out.append("~")
            elif nxt == "1":
                out.append("/")
            else:
                raise ValueError("invalid escape in pointer token %r" % token)
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def build(tokens):
    return "".join("/" + escape(str(t)) for t in tokens)


def append(pointer, token):
    return pointer + "/" + escape(str(token))


def parse(pointer):
    if pointer == "":
        return []
    if not pointer.startswith("/"):
        raise ValueError("pointer must start with '/': %r" % pointer)
    return [unescape(seg) for seg in pointer[1:].split("/")]


def resolve(doc, pointer):
    cur = doc
    for tok in parse(pointer):
        if isinstance(cur, dict):
            if tok not in cur:
                raise KeyError(tok)
            cur = cur[tok]
        elif isinstance(cur, list):
            if not _INDEX.match(tok) or int(tok) >= len(cur):
                raise KeyError(tok)
            cur = cur[int(tok)]
        else:
            raise KeyError(tok)
    return cur
