import unittest

from schemalite import keywords as kw
from schemalite.errors import SchemaError


def kws(pairs):
    return [k for k, _ in pairs]


class TypeTests(unittest.TestCase):
    def test_bool_is_not_number_or_integer(self):
        self.assertFalse(kw.is_number(True))
        self.assertFalse(kw.is_integer(False))
        self.assertFalse(kw.is_type(True, "number"))
        self.assertFalse(kw.is_type(True, "integer"))
        self.assertTrue(kw.is_type(True, "boolean"))
        self.assertFalse(kw.is_type(1, "boolean"))

    def test_integral_float_is_integer(self):
        self.assertTrue(kw.is_type(1.0, "integer"))
        self.assertTrue(kw.is_type(-3, "integer"))
        self.assertFalse(kw.is_type(1.5, "integer"))
        self.assertFalse(kw.is_type(float("inf"), "integer"))
        self.assertTrue(kw.is_type(1, "number"))

    def test_other_types_and_unknown(self):
        self.assertTrue(kw.is_type(None, "null"))
        self.assertTrue(kw.is_type([], "array"))
        self.assertTrue(kw.is_type({}, "object"))
        self.assertTrue(kw.is_type("", "string"))
        with self.assertRaises(SchemaError):
            kw.is_type(1, "float")

    def test_check_type_list(self):
        self.assertEqual(kw.check_type(None, {"type": ["string", "null"]}), [])
        self.assertEqual(kws(kw.check_type(3, {"type": ["string", "null"]})), ["type"])
        self.assertEqual(kw.check_type(3, {}), [])
        with self.assertRaises(SchemaError):
            kw.check_type(3, {"type": []})
        with self.assertRaises(SchemaError):
            kw.check_type(3, {"type": ["integer", "nope"]})


class EqualityTests(unittest.TestCase):
    def test_json_equal(self):
        self.assertTrue(kw.json_equal(1, 1.0))
        self.assertFalse(kw.json_equal(True, 1))
        self.assertFalse(kw.json_equal(0, False))
        self.assertTrue(kw.json_equal(True, True))
        self.assertTrue(kw.json_equal([1, {"a": 2.0}], [1.0, {"a": 2}]))
        self.assertFalse(kw.json_equal([True], [1]))
        self.assertFalse(kw.json_equal({"a": 1}, {"a": 1, "b": 2}))
        self.assertFalse(kw.json_equal([1, 2], [2, 1]))
        self.assertFalse(kw.json_equal("1", 1))

    def test_enum_and_const(self):
        s = {"enum": [1, "a", None, [1, 2]]}
        self.assertEqual(kw.check_enum_const(1.0, s), [])
        self.assertEqual(kw.check_enum_const(None, s), [])
        self.assertEqual(kw.check_enum_const([1.0, 2], s), [])
        self.assertEqual(kws(kw.check_enum_const(True, s)), ["enum"])
        self.assertEqual(kws(kw.check_enum_const("b", s)), ["enum"])
        self.assertEqual(kws(kw.check_enum_const(1, {"const": None})), ["const"])
        self.assertEqual(kw.check_enum_const(None, {"const": None}), [])
        self.assertEqual(kws(kw.check_enum_const(2, {"enum": [1], "const": 3})), ["enum", "const"])
        with self.assertRaises(SchemaError):
            kw.check_enum_const(1, {"enum": 1})


class NumericTests(unittest.TestCase):
    def test_bounds(self):
        s = {"minimum": 2, "maximum": 5, "exclusiveMinimum": 2, "exclusiveMaximum": 5}
        self.assertEqual(kws(kw.check_numeric(2, s)), ["exclusiveMinimum"])
        self.assertEqual(kws(kw.check_numeric(5.0, s)), ["exclusiveMaximum"])
        self.assertEqual(kw.check_numeric(3, s), [])
        self.assertEqual(kws(kw.check_numeric(1, s)), ["minimum", "exclusiveMinimum"])
        self.assertEqual(kws(kw.check_numeric(9, s)), ["maximum", "exclusiveMaximum"])

    def test_non_numbers_skipped_and_bad_bounds(self):
        self.assertEqual(kw.check_numeric(True, {"minimum": 5}), [])
        self.assertEqual(kw.check_numeric("a", {"minimum": 5}), [])
        with self.assertRaises(SchemaError):
            kw.check_numeric(1, {"minimum": "0"})
        with self.assertRaises(SchemaError):
            kw.check_numeric(1, {"exclusiveMaximum": True})

    def test_multiple_of(self):
        self.assertEqual(kw.check_numeric(0.3, {"multipleOf": 0.1}), [])
        self.assertEqual(kw.check_numeric(10, {"multipleOf": 2.5}), [])
        self.assertEqual(kws(kw.check_numeric(0.35, {"multipleOf": 0.1})), ["multipleOf"])
        self.assertEqual(kws(kw.check_numeric(7, {"multipleOf": 2})), ["multipleOf"])
        self.assertEqual(kw.check_numeric(1e300, {"multipleOf": 1e-300}), [("multipleOf", kw.check_numeric(1e300, {"multipleOf": 1e-300})[0][1])])
        for bad in (0, -1, "2", True):
            with self.assertRaises(SchemaError):
                kw.check_numeric(4, {"multipleOf": bad})


class StringArrayObjectTests(unittest.TestCase):
    def test_string_keywords(self):
        self.assertEqual(kw.check_string("\U0001F600\U0001F600", {"maxLength": 2}), [])
        self.assertEqual(kws(kw.check_string("\U0001F600", {"minLength": 2})), ["minLength"])
        self.assertEqual(kw.check_string("xxabcxx", {"pattern": "abc"}), [])
        self.assertEqual(kws(kw.check_string("ab", {"pattern": "^abc$"})), ["pattern"])
        self.assertEqual(kw.check_string(5, {"minLength": 10}), [])
        for bad in ({"pattern": "("}, {"pattern": 3}, {"minLength": -1}, {"maxLength": 1.5}, {"minLength": True}):
            with self.assertRaises(SchemaError, msg=bad):
                kw.check_string("abc", bad)

    def test_unique_items_semantics(self):
        u = {"uniqueItems": True}
        self.assertEqual(kws(kw.check_array([1, 1.0], u)), ["uniqueItems"])
        self.assertEqual(kw.check_array([1, True, 0, False], u), [])
        self.assertEqual(kws(kw.check_array([{"a": [1]}, {"a": [1.0]}], u)), ["uniqueItems"])
        self.assertEqual(kw.check_array([[1], [True]], u), [])
        self.assertEqual(kws(kw.check_array([1, 2, 3, 2.0], u)), ["uniqueItems"])
        self.assertEqual(kw.check_array([1, 1], {"uniqueItems": False}), [])

    def test_array_counts_in_order(self):
        s = {"minItems": 3, "maxItems": 1, "uniqueItems": True}
        self.assertEqual(kws(kw.check_array([1, 1], s)), ["minItems", "maxItems", "uniqueItems"])
        self.assertEqual(kw.check_array("ab", {"minItems": 5}), [])
        with self.assertRaises(SchemaError):
            kw.check_array([], {"maxItems": -1})

    def test_object_required_one_per_missing(self):
        s = {"minProperties": 3, "required": ["b", "a", "c"]}
        pairs = kw.check_object({"a": 1}, s)
        self.assertEqual(kws(pairs), ["minProperties", "required", "required"])
        self.assertIn("'b'", pairs[1][1] + "'b'")
        self.assertEqual(kw.check_object([], s), [])
        with self.assertRaises(SchemaError):
            kw.check_object({}, {"required": "a"})
        with self.assertRaises(SchemaError):
            kw.check_object({}, {"required": [1]})
