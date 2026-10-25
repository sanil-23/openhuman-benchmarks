import unittest

from minimd.inline import render_inline as r


class InlineTests(unittest.TestCase):
    def test_plain_text_escaped(self):
        self.assertEqual(r('a < b & c > "d"'), 'a &lt; b &amp; c &gt; "d"')

    def test_strong_and_em_both_delimiters(self):
        self.assertEqual(r("**a** __b__ *c* _d_"),
                         "<strong>a</strong> <strong>b</strong> <em>c</em> <em>d</em>")

    def test_nesting(self):
        self.assertEqual(r("**a *b* c**"), "<strong>a <em>b</em> c</strong>")
        self.assertEqual(r("*a **b** c*"), "<em>a <strong>b</strong> c</em>")
        self.assertEqual(r("***x***"), "<strong><em>x</em></strong>")

    def test_unmatched_and_spaced_delimiters_are_literal(self):
        self.assertEqual(r("2 * 3 * 4"), "2 * 3 * 4")
        self.assertEqual(r("**"), "**")
        self.assertEqual(r("*oops"), "*oops")

    def test_underscore_is_not_intraword(self):
        self.assertEqual(r("snake_case_name"), "snake_case_name")
        self.assertEqual(r("a*b*c"), "a<em>b</em>c")
        self.assertEqual(r("(_x_)"), "(<em>x</em>)")

    def test_code_span_suppresses_markup(self):
        self.assertEqual(r("`a<b`"), "<code>a&lt;b</code>")
        self.assertEqual(r("`*x* \\*`"), "<code>*x* \\*</code>")
        self.assertEqual(r("**`x` and [l](u)**"),
                         '<strong><code>x</code> and <a href="u">l</a></strong>')

    def test_unterminated_and_double_backticks_literal(self):
        self.assertEqual(r("a ` b"), "a ` b")
        self.assertEqual(r("a `` b"), "a `` b")

    def test_backslash_escapes(self):
        self.assertEqual(r("\\*not em\\*"), "*not em*")
        self.assertEqual(r("\\_ \\[ \\] \\( \\) \\# \\`"), "_ [ ] ( ) # `")
        self.assertEqual(r("C:\\\\dir"), "C:\\dir")
        self.assertEqual(r("\\d and end\\"), "\\d and end\\")
        self.assertEqual(r("\\<b>"), "\\&lt;b&gt;")

    def test_escaped_delimiter_inside_emphasis(self):
        self.assertEqual(r("*a\\**"), "<em>a*</em>")

    def test_link_basic_and_inline_markup_in_text(self):
        self.assertEqual(r("[a](http://x.y/z)"), '<a href="http://x.y/z">a</a>')
        self.assertEqual(r("[**b** `c`](u)"), '<a href="u"><strong>b</strong> <code>c</code></a>')

    def test_link_url_attribute_escaping(self):
        self.assertEqual(r('[x](a?b=1&c="2")'), '<a href="a?b=1&amp;c=&quot;2&quot;">x</a>')

    def test_link_text_with_escaped_bracket(self):
        self.assertEqual(r("[a\\]b](u)"), '<a href="u">a]b</a>')
        self.assertEqual(r("[`a]b`](u)"), '<a href="u"><code>a]b</code></a>')

    def test_non_links_keep_bracket_literal(self):
        self.assertEqual(r("[x] (u)"), "[x] (u)")
        self.assertEqual(r("[x](a b)"), "[x](a b)")
        self.assertEqual(r("[x](u"), "[x](u")
        self.assertEqual(r("\\[x](u)"), "[x](u)")

    def test_link_inside_emphasis_and_empty_parts(self):
        self.assertEqual(r("*see [a](u)*"), '<em>see <a href="u">a</a></em>')
        self.assertEqual(r("[](u)"), '<a href="u"></a>')
        self.assertEqual(r("[x]()"), '<a href=""">x</a>'.replace('"""', '"'))
