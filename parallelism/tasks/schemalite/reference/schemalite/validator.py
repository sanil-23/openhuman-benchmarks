"""Schema validation."""

from . import keywords as kw
from . import pointer
from .errors import SchemaError, ValidationError


def _subschema(s, what):
    if not isinstance(s, dict):
        raise SchemaError("%s must be a schema object" % what)
    return s


def _schema_list(schema, key):
    v = schema[key]
    if not isinstance(v, list) or not v:
        raise SchemaError("%s must be a non-empty list" % key)
    return v


def _pairs(path, pairs):
    return [ValidationError(path, k, m) for k, m in pairs]


def _eval(instance, schema, path, root, active):
    _subschema(schema, "schema")
    if "$ref" in schema:
        ref = schema["$ref"]
        prefix = "#/definitions/"
        if not isinstance(ref, str) or not ref.startswith(prefix):
            raise SchemaError("unsupported $ref %r" % (ref,))
        key = (ref, path)
        if key in active:
            raise SchemaError("$ref cycle without progress: %s" % ref)
        try:
            target = pointer.resolve(root, ref[1:])
        except (KeyError, ValueError):
            raise SchemaError("unresolvable $ref %s" % ref)
        _subschema(target, "$ref target")
        active.add(key)
        try:
            return _eval(instance, target, path, root, active)
        finally:
            active.discard(key)

    errs = []
    errs += _pairs(path, kw.check_type(instance, schema))
    errs += _pairs(path, kw.check_enum_const(instance, schema))
    errs += _pairs(path, kw.check_numeric(instance, schema))
    errs += _pairs(path, kw.check_string(instance, schema))
    errs += _pairs(path, kw.check_array(instance, schema))

    if "items" in schema:
        sub = _subschema(schema["items"], "items")
        if isinstance(instance, list):
            for i, el in enumerate(instance):
                errs += _eval(el, sub, pointer.append(path, i), root, active)

    errs += _pairs(path, kw.check_object(instance, schema))

    props = schema.get("properties")
    if "properties" in schema:
        if not isinstance(props, dict):
            raise SchemaError("properties must be an object")
        if isinstance(instance, dict):
            for name, sub in props.items():
                if name in instance:
                    errs += _eval(instance[name], sub, pointer.append(path, name), root, active)

    if "additionalProperties" in schema:
        ap = schema["additionalProperties"]
        if not isinstance(ap, (bool, dict)):
            raise SchemaError("additionalProperties must be a boolean or a schema")
        if isinstance(instance, dict) and ap is not True:
            known = props if isinstance(props, dict) else {}
            for name, val in instance.items():
                if name in known:
                    continue
                child = pointer.append(path, name)
                if ap is False:
                    errs.append(ValidationError(child, "additionalProperties", "additional property %r is not allowed" % name))
                else:
                    errs += _eval(val, ap, child, root, active)

    if "allOf" in schema:
        for sub in _schema_list(schema, "allOf"):
            errs += _eval(instance, _subschema(sub, "allOf item"), path, root, active)

    if "anyOf" in schema:
        for sub in _schema_list(schema, "anyOf"):
            if not _eval(instance, _subschema(sub, "anyOf item"), path, root, active):
                break
        else:
            errs.append(ValidationError(path, "anyOf", "value matches none of the anyOf schemas"))

    if "oneOf" in schema:
        n = sum(
            1
            for sub in _schema_list(schema, "oneOf")
            if not _eval(instance, _subschema(sub, "oneOf item"), path, root, active)
        )
        if n != 1:
            errs.append(ValidationError(path, "oneOf", "value matches %d of the oneOf schemas, expected exactly 1" % n))

    if "not" in schema:
        if not _eval(instance, _subschema(schema["not"], "not"), path, root, active):
            errs.append(ValidationError(path, "not", "value must not match the schema"))

    return errs


def validate(instance, schema):
    return _eval(instance, schema, "", schema, set())


def is_valid(instance, schema):
    return not validate(instance, schema)
