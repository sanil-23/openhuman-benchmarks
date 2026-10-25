"""Command line interface."""

import json
import sys

from .errors import SchemaError
from .validator import validate


def _fail(msg):
    print("error: " + msg, file=sys.stderr)
    return 2


def _load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main(argv=None):
    args = sys.argv[1:] if argv is None else list(argv)
    if len(args) != 2:
        return _fail("usage: python -m schemalite SCHEMA.json INSTANCE.json")
    try:
        schema = _load(args[0])
        instance = _load(args[1])
    except OSError as e:
        return _fail("cannot read file: %s" % e)
    except ValueError as e:
        return _fail("invalid JSON: %s" % e)
    try:
        errors = validate(instance, schema)
    except SchemaError as e:
        return _fail("schema error: %s" % e)
    for e in errors:
        print("%s %s: %s" % (e.path or "/", e.keyword, e.message))
    return 1 if errors else 0
