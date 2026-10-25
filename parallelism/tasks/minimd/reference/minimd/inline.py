"""Inline span rendering. See README.md."""

ESCAPABLE = set("\\`*_[]()#")


def _esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _esc_attr(s):
    return _esc(s).replace('"', "&quot;")


def render_inline(text):
    return _parse(text, 0, None)[0]


def _closer_ok(t, i, delim):
    if i == 0 or t[i - 1].isspace():
        return False
    if delim[0] == "_":
        j = i + len(delim)
        if j < len(t) and t[j].isalnum():
            return False
    return True


def _opener_ok(t, i, d):
    j = i + len(d)
    if j >= len(t) or t[j].isspace():
        return False
    if d[0] == "_" and i > 0 and t[i - 1].isalnum():
        return False
    return True


def _find_bracket_end(t, i):
    n = len(t)
    k = i + 1
    while k < n:
        c = t[k]
        if c == "\\" and k + 1 < n:
            k += 2
        elif c == "`":
            j = t.find("`", k + 1)
            if j > k + 1:
                k = j + 1
            else:
                k += 1
        elif c == "]":
            return k
        else:
            k += 1
    return -1


def _parse(t, i, delim):
    out = []
    n = len(t)
    start = i
    while i < n:
        c = t[i]
        if delim and i > start and t.startswith(delim, i) and _closer_ok(t, i, delim):
            return "".join(out), i + len(delim), True
        if c == "\\" and i + 1 < n and t[i + 1] in ESCAPABLE:
            out.append(_esc(t[i + 1]))
            i += 2
            continue
        if c == "`":
            if i + 1 < n and t[i + 1] == "`":
                out.append("``")
                i += 2
                continue
            j = t.find("`", i + 1)
            if j > 0:
                out.append("<code>" + _esc(t[i + 1:j]) + "</code>")
                i = j + 1
            else:
                out.append("`")
                i += 1
            continue
        if c == "[":
            k = _find_bracket_end(t, i)
            if k != -1 and t[k + 1:k + 2] == "(":
                m = t.find(")", k + 2)
                if m != -1:
                    url = t[k + 2:m]
                    if not any(ch.isspace() for ch in url):
                        inner = render_inline(t[i + 1:k])
                        out.append('<a href="' + _esc_attr(url) + '">' + inner + "</a>")
                        i = m + 1
                        continue
            out.append("[")
            i += 1
            continue
        if c in "*_":
            d = c * 2 if t.startswith(c * 2, i) else c
            if _opener_ok(t, i, d):
                inner, j, closed = _parse(t, i + len(d), d)
                if closed:
                    tag = "strong" if len(d) == 2 else "em"
                    out.append("<%s>%s</%s>" % (tag, inner, tag))
                    i = j
                    continue
            out.append(d)
            i += len(d)
            continue
        out.append(_esc(c))
        i += 1
    return "".join(out), i, False
