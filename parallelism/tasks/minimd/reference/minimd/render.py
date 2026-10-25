"""AST to HTML. See README.md."""
from .blocks import (BlockQuote, CodeBlock, Heading, ListBlock, Paragraph, Rule,
                     parse_blocks)
from .inline import _esc, _esc_attr, render_inline


def _list(lst):
    tag = "ol" if lst.ordered else "ul"
    out = ["<%s>" % tag]
    for it in lst.items:
        if it.sublist is None:
            out.append("<li>%s</li>" % render_inline(it.text))
        else:
            out.append("<li>%s" % render_inline(it.text))
            out.append(_list(it.sublist))
            out.append("</li>")
    out.append("</%s>" % tag)
    return "\n".join(out)


def _block(b):
    if isinstance(b, Heading):
        return "<h%d>%s</h%d>" % (b.level, render_inline(b.text), b.level)
    if isinstance(b, Paragraph):
        return "<p>%s</p>" % render_inline(b.text)
    if isinstance(b, CodeBlock):
        cls = ' class="language-%s"' % _esc_attr(b.lang) if b.lang else ""
        return "<pre><code%s>%s</code></pre>" % (cls, _esc(b.code))
    if isinstance(b, Rule):
        return "<hr>"
    if isinstance(b, BlockQuote):
        return "\n".join(["<blockquote>"] + [_block(p) for p in b.paragraphs] + ["</blockquote>"])
    if isinstance(b, ListBlock):
        return _list(b)
    raise TypeError(b)


def render_blocks(blocks):
    return "".join(_block(b) + "\n" for b in blocks)


def convert(text):
    return render_blocks(parse_blocks(text))
