import unittest

from csvstats.reader import parse_csv


class ReaderTests(unittest.TestCase):
    def test_basic_and_inference(self):
        rows = parse_csv("a,b,c,d\n1,2.5,x,\n")
        self.assertEqual(rows, [{"a": 1, "b": 2.5, "c": "x", "d": None}])
        self.assertIsInstance(rows[0]["a"], int)

    def test_quotes_commas_newlines(self):
        rows = parse_csv('name,note\n"Smith, J","line1\nline2"\n"say ""hi""",ok\n')
        self.assertEqual(rows[0], {"name": "Smith, J", "note": "line1\nline2"})
        self.assertEqual(rows[1]["name"], 'say "hi"')

    def test_crlf_and_blank_lines(self):
        self.assertEqual(len(parse_csv("a\r\n1\r\n\r\n2\r\n")), 2)

    def test_quoted_number_stays_string(self):
        rows = parse_csv('a,b\n"007",007\n')
        self.assertEqual(rows[0], {"a": "007", "b": 7})

    def test_strip_unquoted_only(self):
        rows = parse_csv('a,b\n  hi  ,"  hi  "\n')
        self.assertEqual(rows[0], {"a": "hi", "b": "  hi  "})

    def test_wrong_field_count_reports_record(self):
        with self.assertRaisesRegex(ValueError, "3"):
            parse_csv("a,b\n1,2\n1\n")

    def test_no_trailing_newline_and_empty(self):
        self.assertEqual(parse_csv("a\n5"), [{"a": 5}])
        self.assertEqual(parse_csv(""), [])


if __name__ == "__main__":
    unittest.main()
