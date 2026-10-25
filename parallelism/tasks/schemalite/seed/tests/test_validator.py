import unittest

from schemalite import SchemaError, ValidationError, is_valid, validate


def pk(errors):
    return [(e.path, e.keyword) for e in errors]


class ValidatorTests(unittest.TestCase):
    def test_valid_returns_empty_list(self):
        self.assertEqual(validate({"a": 1}, {"type": "object"}), [])
        self.assertTrue(is_valid(1, {"type": "integer"}))
        self.assertFalse(is_valid("x", {"type": "integer"}))

    def test_error_record_shape(self):
        errs = validate(1, {"type": "string"})
        self.assertEqual(len(errs), 1)
        self.assertIsInstance(errs[0], ValidationError)
        self.assertEqual((errs[0].path, errs[0].keyword), ("", "type"))
        self.assertTrue(errs[0].message)

    def test_schema_must_be_dict(self):
        for bad in (True, [], "x", None):
            with self.assertRaises(SchemaError):
                validate(1, bad)

    def test_type_mismatch_does_not_stop_other_keywords(self):
        errs = validate("abc", {"type": "integer", "minLength": 5, "enum": [1]})
        self.assertEqual(pk(errs), [("", "type"), ("", "enum"), ("", "minLength")])

    def test_keyword_order_is_fixed_not_schema_order(self):
        schema = {"required": ["a"], "minProperties": 2, "type": "array"}
        self.assertEqual(pk(validate({}, schema)), [("", "type"), ("", "minProperties"), ("", "required")])
        schema = {"not": {"type": "object"}, "properties": {"a": {"type": "string"}}, "type": "array"}
        self.assertEqual(
            pk(validate({"a": 1}, schema)),
            [("", "type"), ("/a", "type"), ("", "not")],
        )

    def test_items_paths_and_order(self):
        schema = {"uniqueItems": True, "items": {"type": "integer", "minimum": 0}}
        errs = validate([1, -1, "x", 1], schema)
        self.assertEqual(
            pk(errs),
            [("", "uniqueItems"), ("/1", "minimum"), ("/2", "type")],
        )

    def test_properties_in_schema_order_and_escaping(self):
        schema = {"properties": {"z": {"type": "string"}, "a/b": {"type": "string"}, "m~n": {"type": "string"}}}
        errs = validate({"m~n": 1, "a/b": 2, "z": 3}, schema)
        self.assertEqual(pk(errs), [("/z", "type"), ("/a~1b", "type"), ("/m~0n", "type")])

    def test_required_one_error_per_name_at_object_path(self):
        schema = {"properties": {"x": {"required": ["k"]}}}
        errs = validate({"x": {}}, {"required": ["q", "r"], **schema})
        self.assertEqual(pk(errs), [("", "required"), ("", "required"), ("/x", "required")])

    def test_additional_properties_false_per_key(self):
        schema = {"properties": {"a": {}}, "additionalProperties": False}
        errs = validate({"z": 1, "a": 1, "y/": 2}, schema)
        self.assertEqual(pk(errs), [("/z", "additionalProperties"), ("/y~1", "additionalProperties")])
        self.assertEqual(validate({"a": 1}, schema), [])

    def test_additional_properties_schema(self):
        schema = {"properties": {"a": {"type": "string"}}, "additionalProperties": {"type": "integer"}}
        errs = validate({"a": 1, "b": "x", "c": 2}, schema)
        self.assertEqual(pk(errs), [("/a", "type"), ("/b", "type")])
        self.assertEqual(validate({"b": 1}, {"additionalProperties": True}), [])
        with self.assertRaises(SchemaError):
            validate({"b": 1}, {"additionalProperties": 1})

    def test_all_of_concatenates_in_order(self):
        schema = {"allOf": [{"type": "string"}, {"minLength": 3}, {"pattern": "^x"}]}
        self.assertEqual(pk(validate(5, schema)), [("", "type")])
        self.assertEqual(pk(validate("ab", schema)), [("", "minLength"), ("", "pattern")])

    def test_any_of_single_error_and_short_circuit(self):
        schema = {"anyOf": [{"type": "string", "minLength": 9}, {"type": "integer", "minimum": 5}]}
        self.assertEqual(pk(validate(1, schema)), [("", "anyOf")])
        self.assertEqual(validate(7, schema), [])
        # evaluation stops at the first valid branch, later branches are never touched
        lazy = {"anyOf": [{"type": "string"}, {"$ref": "#/definitions/missing"}, {"type": "bogus"}]}
        self.assertEqual(validate("x", lazy), [])
        with self.assertRaises(SchemaError):
            validate(1, lazy)
        with self.assertRaises(SchemaError):
            validate(1, {"anyOf": []})

    def test_one_of_exactly_one(self):
        schema = {"oneOf": [{"type": "integer"}, {"minimum": 0}]}
        self.assertEqual(pk(validate(-1, schema)), [])
        self.assertEqual(pk(validate(1, schema)), [("", "oneOf")])
        self.assertEqual(pk(validate("s", {"oneOf": [{"type": "integer"}, {"minimum": 0}]})), [("", "oneOf")])
        # all branches are evaluated, so a bad later branch raises even if an earlier one matched
        with self.assertRaises(SchemaError):
            validate(1, {"oneOf": [{"type": "integer"}, {"$ref": "#/definitions/nope"}]})

    def test_not(self):
        self.assertEqual(pk(validate("a", {"not": {"type": "string"}})), [("", "not")])
        self.assertEqual(validate(1, {"not": {"type": "string"}}), [])
        with self.assertRaises(SchemaError):
            validate(1, {"not": []})

    def test_nested_errors_inside_combinator_use_instance_path(self):
        schema = {"properties": {"a": {"allOf": [{"type": "string"}], "anyOf": [{"type": "null"}]}}}
        self.assertEqual(pk(validate({"a": 1}, schema)), [("/a", "type"), ("/a", "anyOf")])

    def test_ref_inside_properties_reports_instance_path(self):
        schema = {
            "definitions": {"name": {"type": "string", "minLength": 2}},
            "properties": {"first": {"$ref": "#/definitions/name"}, "list": {"items": {"$ref": "#/definitions/name"}}},
        }
        errs = validate({"first": "a", "list": ["ok", 3, "b"]}, schema)
        self.assertEqual(pk(errs), [("/first", "minLength"), ("/list/1", "type"), ("/list/2", "minLength")])

    def test_ref_ignores_siblings_and_unescapes_name(self):
        schema = {"definitions": {"a/b": {"type": "string"}}, "$ref": "#/definitions/a~1b", "minimum": 100}
        self.assertEqual(validate(5, schema)[0].keyword, "type")
        self.assertEqual(len(validate(5, schema)), 1)
        self.assertEqual(validate("s", schema), [])

    def test_ref_errors(self):
        for ref in ["#/definitions/nope", "#", "#/properties/a", "other.json#/definitions/a", 5, "#/definitions/n/x"]:
            schema = {"definitions": {"n": 3}, "$ref": ref}
            with self.assertRaises(SchemaError, msg=ref):
                validate(1, schema)
        with self.assertRaises(SchemaError):
            validate(1, {"definitions": {"n": 3}, "$ref": "#/definitions/n"})

    def test_recursive_ref_tree(self):
        schema = {
            "definitions": {
                "node": {
                    "type": "object",
                    "required": ["v"],
                    "properties": {"v": {"type": "integer"}, "kids": {"type": "array", "items": {"$ref": "#/definitions/node"}}},
                }
            },
            "$ref": "#/definitions/node",
        }
        good = {"v": 1, "kids": [{"v": 2, "kids": [{"v": 3}]}, {"v": 4}]}
        self.assertEqual(validate(good, schema), [])
        bad = {"v": 1, "kids": [{"v": 2, "kids": [{"v": "x"}, {}]}]}
        self.assertEqual(pk(validate(bad, schema)), [("/kids/0/kids/0/v", "type"), ("/kids/0/kids/1", "required")])

    def test_ref_cycles_without_progress(self):
        d = {
            "a": {"$ref": "#/definitions/a"},
            "b": {"$ref": "#/definitions/c"},
            "c": {"$ref": "#/definitions/b"},
            "d": {"allOf": [{"$ref": "#/definitions/d"}]},
        }
        for name in "abcd":
            with self.assertRaises(SchemaError, msg=name):
                validate({"x": 1}, {"definitions": d, "$ref": "#/definitions/" + name})

    def test_same_ref_at_deeper_path_is_not_a_cycle(self):
        schema = {
            "definitions": {"list": {"anyOf": [{"type": "null"}, {"properties": {"next": {"$ref": "#/definitions/list"}}}]}},
            "$ref": "#/definitions/list",
        }
        self.assertEqual(validate({"next": {"next": None}}, schema), [])

    def test_lazy_schema_errors(self):
        # malformed keyword values only matter when the keyword applies to the instance
        self.assertEqual(validate("s", {"minimum": "bad", "minItems": -1}), [])
        with self.assertRaises(SchemaError):
            validate(1, {"minimum": "bad"})
        self.assertEqual(validate({}, {"properties": {"a": {"type": "bogus"}}}), [])
        with self.assertRaises(SchemaError):
            validate(1, {"type": "bogus"})
