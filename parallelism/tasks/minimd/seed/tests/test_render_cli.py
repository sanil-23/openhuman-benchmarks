import os
import subprocess
import sys
import tempfile
import unittest

from minimd.blocks import (BlockQuote, CodeBlock, Heading, ListBlock, ListItem,
                           Paragraph, Rule)
from minimd.render import convert, render_blocks

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run(*args, stdin=None):
    return subprocess.run([sys.executable, "-m", "minimd", *args], cwd=ROOT, input=stdin,
                          capture_output=True, text=True)


class RenderTests(unittest.TestCase):
    def test_simple_blocks_one_per_line(self):
        out = render_blocks([Heading(2, "Hi *x*"), Paragraph("a & b\nc"), Rule()])
        self.assertEqual(out, "<h2>Hi <em>x</em></h2>\n<p>a &amp; b\nc</p>\n<hr>\n")

        self.assertEqual(render_blocks([]), "")
        self.assertEqual(convert(""), "")

    def test_code_block_escaped_and_not_inlined(self):
        self.assertEqual(render_blocks([CodeBlock("a <b> & *c*\n", "py")]),
                         '<pre><code class="language-py">a &lt;b&gt; &amp; *c*\n</code></pre>\n')
        self.assertEqual(render_blocks([CodeBlock("x\n"), CodeBlock("")]),
                         "<pre><code>x\n</code></pre>\n<pre><code></code></pre>\n")

        self.assertEqual(render_blocks([CodeBlock("", 'a"b')]),
                         '<pre><code class="language-a&quot;b"></code></pre>\n')

    def test_blockquote(self):
        self.assertEqual(render_blocks([BlockQuote([Paragraph("a **b**"), Paragraph("c")])]),
                         "<blockquote>\n<p>a <strong>b</strong></p>\n<p>c</p>\n</blockquote>\n")
        self.assertEqual(render_blocks([BlockQuote([])]), "<blockquote>\n</blockquote>\n")

    def test_list_with_inline_markup_in_items(self):
        out = render_blocks([ListBlock(True, [ListItem("[a](u) & `b`"), ListItem("*c*")])])
        self.assertEqual(out, '<ol>\n<li><a href="u">a</a> &amp; <code>b</code></li>\n<li><em>c</em></li>\n</ol>\n')

    def test_nested_list_layout(self):
        out = convert("- a\n  - b\n- c\n")
        self.assertEqual(out, "<ul>\n<li>a\n<ul>\n<li>b</li>\n</ul>\n</li>\n<li>c</li>\n</ul>\n")

    def test_convert_document(self):
        doc = "# T\n\nhello\nworld\n\n> q\n\n```sh\nls\n```\n\n1. x\n"
        self.assertEqual(convert(doc),
                         "<h1>T</h1>\n<p>hello\nworld</p>\n<blockquote>\n<p>q</p>\n</blockquote>\n"
                         '<pre><code class="language-sh">ls\n</code></pre>\n<ol>\n<li>x</li>\n</ol>\n')

        self.assertEqual(convert("```\n<a>"), "<pre><code>&lt;a&gt;\n</code></pre>\n")


class CliTests(unittest.TestCase):
    def test_file_argument(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "in.md")
            with open(path, "w", encoding="utf-8") as f:
                f.write("# h\u00e9\n")
            res = run(path)
        self.assertEqual((res.returncode, res.stdout, res.stderr), (0, "<h1>h\u00e9</h1>\n", ""))

        for args in (("-",), ()):
            res = run(*args, stdin="*x*\n")
            self.assertEqual((res.returncode, res.stdout), (0, "<p><em>x</em></p>\n"))

    def test_missing_file_exit_2(self):
        res = run("/nonexistent/nope.md")
        self.assertEqual(res.returncode, 2)
        self.assertEqual(res.stdout, "")
        self.assertTrue(res.stderr.startswith("error: "))
        self.assertIn("nope.md", res.stderr)

        res = run("a", "b")
        self.assertEqual(res.returncode, 2)
        self.assertTrue(res.stderr.startswith("error: "))
