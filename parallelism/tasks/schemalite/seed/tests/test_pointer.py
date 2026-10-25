import unittest

from schemalite import pointer


class PointerTests(unittest.TestCase):
    def test_escape_unescape_roundtrip(self):
        self.assertEqual(pointer.escape("a/b~c"), "a~1b~0c")
        self.assertEqual(pointer.escape("~1"), "~01")
        self.assertEqual(pointer.unescape("~01"), "~1")
        self.assertEqual(pointer.unescape("a~1b~0c"), "a/b~c")
        for s in ["", "/", "~", "~~//~1~0", "plain"]:
            self.assertEqual(pointer.unescape(pointer.escape(s)), s)

    def test_unescape_rejects_bad_tilde(self):
        for bad in ["~", "~2", "a~"]:
            with self.assertRaises(ValueError):
                pointer.unescape(bad)

    def test_build_and_append(self):
        self.assertEqual(pointer.build([]), "")
        self.assertEqual(pointer.build(["a", 0, "b/c"]), "/a/0/b~1c")
        self.assertEqual(pointer.build([""]), "/")
        self.assertEqual(pointer.append("", "x~"), "/x~0")
        self.assertEqual(pointer.append("/a", 3), "/a/3")

    def test_parse(self):
        self.assertEqual(pointer.parse(""), [])
        self.assertEqual(pointer.parse("/"), [""])
        self.assertEqual(pointer.parse("/a~1b/0//c"), ["a/b", "0", "", "c"])
        with self.assertRaises(ValueError):
            pointer.parse("a/b")

    def test_resolve_dict_and_list(self):
        doc = {"a": [10, {"b/c": 5}], "": "empty", "m~n": 1}
        self.assertIs(pointer.resolve(doc, ""), doc)
        self.assertEqual(pointer.resolve(doc, "/a/0"), 10)
        self.assertEqual(pointer.resolve(doc, "/a/1/b~1c"), 5)
        self.assertEqual(pointer.resolve(doc, "/"), "empty")
        self.assertEqual(pointer.resolve(doc, "/m~0n"), 1)

    def test_resolve_failures_are_keyerror(self):
        doc = {"a": [1, 2], "s": "str"}
        for p in ["/zz", "/a/2", "/a/-", "/a/01", "/a/+1", "/a/x", "/s/0", "/a/0/1"]:
            with self.assertRaises(KeyError, msg=p):
                pointer.resolve(doc, p)
        with self.assertRaises(ValueError):
            pointer.resolve(doc, "a")
