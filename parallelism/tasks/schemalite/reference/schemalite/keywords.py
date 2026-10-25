"""Keyword checks."""

import math
import re

from .errors import SchemaError


def is_number(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def is_integer(x):
    if isinstance(x, bool):
        return False
    if isinstance(x, int):
        return True
    return isinstance(x, float) and x.is_integer()


_TYPES = {
    "string": lambda x: isinstance(x, str),
    "number": is_number,
    "integer": is_integer,
    "boolean": lambda x: isinstance(x, bool),
    "null": lambda x: x is None,
    "array": lambda x: isinstance(x, list),
    "object": lambda x: isinstance(x, dict),
}


def is_type(instance, name):
    if not isinstance(name, str) or name not in _TYPES:
        raise SchemaError("unknown type %r" % (name,))
    return _TYPES[name](instance)


def json_equal(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if is_number(a) and is_number(b):
        return a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(json_equal(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(json_equal(a[k], b[k]) for k in a)
    if type(a) is not type(b):
        return False
    return a == b


def check_type(instance, schema):
    if "type" not in schema:
        return []
    t = schema["type"]
    names = t if isinstance(t, list) else [t]
    if not names:
        raise SchemaError("type list must not be empty")
    ok = [is_type(instance, n) for n in names]
    if any(ok):
        return []
    return [("type", "expected %s" % " or ".join(map(str, names)))]


def check_enum_const(instance, schema):
    out = []
    if "enum" in schema:
        if not isinstance(schema["enum"], list):
            raise SchemaError("enum must be a list")
        if not any(json_equal(instance, m) for m in schema["enum"]):
            out.append(("enum", "value is not one of the allowed values"))
    if "const" in schema:
        if not json_equal(instance, schema["const"]):
            out.append(("const", "value does not equal the required constant"))
    return out


def _num(schema, key):
    v = schema[key]
    if not is_number(v):
        raise SchemaError("%s must be a number" % key)
    return v


def _count(schema, key):
    v = schema[key]
    if not isinstance(v, int) or isinstance(v, bool) or v < 0:
        raise SchemaError("%s must be a non-negative integer" % key)
    return v


def _multiple(x, m):
    if isinstance(x, int) and isinstance(m, int):
        return x % m == 0
    try:
        q = x / m
    except OverflowError:
        return False
    if not math.isfinite(q):
        return False
    return abs(q - round(q)) <= 1e-9 * max(1, abs(q))


def check_numeric(instance, schema):
    if not is_number(instance):
        return []
    out = []
    if "minimum" in schema and instance < _num(schema, "minimum"):
        out.append(("minimum", "%s is less than the minimum %s" % (instance, schema["minimum"])))
    if "maximum" in schema and instance > _num(schema, "maximum"):
        out.append(("maximum", "%s is greater than the maximum %s" % (instance, schema["maximum"])))
    if "exclusiveMinimum" in schema and instance <= _num(schema, "exclusiveMinimum"):
        out.append(("exclusiveMinimum", "%s is not greater than %s" % (instance, schema["exclusiveMinimum"])))
    if "exclusiveMaximum" in schema and instance >= _num(schema, "exclusiveMaximum"):
        out.append(("exclusiveMaximum", "%s is not less than %s" % (instance, schema["exclusiveMaximum"])))
    if "multipleOf" in schema:
        m = _num(schema, "multipleOf")
        if m <= 0:
            raise SchemaError("multipleOf must be greater than 0")
        if not _multiple(instance, m):
            out.append(("multipleOf", "%s is not a multiple of %s" % (instance, m)))
    return out


def check_string(instance, schema):
    if not isinstance(instance, str):
        return []
    out = []
    if "minLength" in schema and len(instance) < _count(schema, "minLength"):
        out.append(("minLength", "string is shorter than %d" % schema["minLength"]))
    if "maxLength" in schema and len(instance) > _count(schema, "maxLength"):
        out.append(("maxLength", "string is longer than %d" % schema["maxLength"]))
    if "pattern" in schema:
        pat = schema["pattern"]
        if not isinstance(pat, str):
            raise SchemaError("pattern must be a string")
        try:
            rx = re.compile(pat)
        except re.error as e:
            raise SchemaError("invalid pattern %r: %s" % (pat, e))
        if not rx.search(instance):
            out.append(("pattern", "string does not match pattern %r" % pat))
    return out


def check_array(instance, schema):
    if not isinstance(instance, list):
        return []
    out = []
    if "minItems" in schema and len(instance) < _count(schema, "minItems"):
        out.append(("minItems", "array has fewer than %d items" % schema["minItems"]))
    if "maxItems" in schema and len(instance) > _count(schema, "maxItems"):
        out.append(("maxItems", "array has more than %d items" % schema["maxItems"]))
    if schema.get("uniqueItems") is True:
        dup = any(
            json_equal(instance[i], instance[j])
            for i in range(len(instance))
            for j in range(i + 1, len(instance))
        )
        if dup:
            out.append(("uniqueItems", "array items are not unique"))
    return out


def check_object(instance, schema):
    if not isinstance(instance, dict):
        return []
    out = []
    if "minProperties" in schema and len(instance) < _count(schema, "minProperties"):
        out.append(("minProperties", "object has fewer than %d properties" % schema["minProperties"]))
    if "required" in schema:
        req = schema["required"]
        if not isinstance(req, list) or not all(isinstance(r, str) for r in req):
            raise SchemaError("required must be a list of strings")
        for name in req:
            if name not in instance:
                out.append(("required", "missing required property %r" % name))
    return out
