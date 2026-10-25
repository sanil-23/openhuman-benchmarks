import unittest

from minimd.blocks import (BlockQuote, CodeBlock, Heading, ListBlock, ListItem,
                           Paragraph, Rule, parse_blocks as p)


class BlockTests(unittest.TestCase):
    def test_headings_levels_and_closing_hashes(self):
        self.assertEqual(p("# A\n###### F\n## Title ##\n# C#\n#\n"),
                         [Heading(1, "A"), Heading(6, "F"), Heading(2, "Title"),
                          Heading(1, "C#"), Heading(1, "")])

    def test_not_headings(self):
        self.assertEqual(p("#hello"), [Paragraph("#hello")])
        self.assertEqual(p("####### seven"), [Paragraph("####### seven")])

    def test_paragraphs_join_with_newline_and_split_on_blank(self):
        self.assertEqual(p("a\n  b  \n\n\nc\r\nd\r\n"), [Paragraph("a\nb"), Paragraph("c\nd")])

    def test_rule(self):
        self.assertEqual(p("---\n*****\n"), [Rule(), Rule()])
        self.assertEqual(p("--\n- -x"), [Paragraph("--"), ListBlock(False, [ListItem("-x")])])

    def test_rule_and_heading_interrupt_paragraph(self):
        self.assertEqual(p("a\n---\nb\n# h\nc"),
                         [Paragraph("a"), Rule(), Paragraph("b"), Heading(1, "h"), Paragraph("c")])

    def test_fenced_code_with_lang(self):
        self.assertEqual(p("```python\nx = 1\n\n  # not a heading\n```\n"),
                         [CodeBlock("x = 1\n\n  # not a heading\n", "python")])

    def test_fence_without_lang_and_empty(self):
        self.assertEqual(p("```\n```"), [CodeBlock("", None)])
        self.assertEqual(p("```\n- a\n> b\n```\nafter"),
                         [CodeBlock("- a\n> b\n", None), Paragraph("after")])

    def test_unterminated_fence_closes_at_eof(self):
        self.assertEqual(p("para\n```js\nlet a;\n\nlet b;\n"),
                         [Paragraph("para"), CodeBlock("let a;\n\nlet b;\n", "js")])
        self.assertEqual(p("```\nx"), [CodeBlock("x\n", None)])

    def test_blockquote_paragraphs(self):
        self.assertEqual(p("> a\n> b\n>\n>c\n\nafter"),
                         [BlockQuote([Paragraph("a\nb"), Paragraph("c")]), Paragraph("after")])

    def test_blockquote_ends_without_lazy_continuation_and_is_flat(self):
        self.assertEqual(p("> a\nb"), [BlockQuote([Paragraph("a")]), Paragraph("b")])
        self.assertEqual(p("> # h\n> - x"), [BlockQuote([Paragraph("# h\n- x")])])

    def test_unordered_list_any_bullet(self):
        self.assertEqual(p("- a\n* b\n+ c"),
                         [ListBlock(False, [ListItem("a"), ListItem("b"), ListItem("c")])])

    def test_ordered_list_numbers_ignored(self):
        self.assertEqual(p("1. a\n7. b\n10. c"),
                         [ListBlock(True, [ListItem("a"), ListItem("b"), ListItem("c")])])

    def test_kind_change_starts_new_list(self):
        self.assertEqual(p("- a\n1. b\n2. c\n- d"),
                         [ListBlock(False, [ListItem("a")]),
                          ListBlock(True, [ListItem("b"), ListItem("c")]),
                          ListBlock(False, [ListItem("d")])])

    def test_nested_sublist(self):
        self.assertEqual(p("- a\n  - b\n    1. c\n- d\n  1. e"),
                         [ListBlock(False, [
                             ListItem("a", ListBlock(False, [ListItem("b"), ListItem("c")])),
                             ListItem("d", ListBlock(True, [ListItem("e")]))])])

    def test_blank_line_and_plain_line_end_a_list(self):
        self.assertEqual(p("- a\n\n- b"), [ListBlock(False, [ListItem("a")]),
                                          ListBlock(False, [ListItem("b")])])
        self.assertEqual(p("- a\nplain"), [ListBlock(False, [ListItem("a")]), Paragraph("plain")])

    def test_non_items(self):
        self.assertEqual(p("-a"), [Paragraph("-a")])
        self.assertEqual(p(" - a"), [Paragraph("- a")])
        self.assertEqual(p("x\n  - a"), [Paragraph("x\n- a")])
        self.assertEqual(p("  - a"), [Paragraph("- a")])

    def test_list_interrupts_paragraph_and_text_is_raw(self):
        self.assertEqual(p("intro\n- **b** `c`"),
                         [Paragraph("intro"), ListBlock(False, [ListItem("**b** `c`")])])

    def test_empty_input(self):
        self.assertEqual(p(""), [])
        self.assertEqual(p("\n\n  \n"), [])
