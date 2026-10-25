# schemalite

A validator for a small subset of JSON Schema, standard library only (Python 3.10, no pip installs).
Instances and schemas are plain Python values as produced by `json.load` (dict, list, str, int,
float, bool, None).

## Shared types: `schemalite/errors.py` (already written, do not change)
- `ValidationError` is a frozen dataclass `(path: str, keyword: str, message: str)`. `path` is a
  JSON pointer into the **instance** (`""` is the root).
- `SchemaError(Exception)` is raised for a malformed or unresolvable schema.

## `schemalite/pointer.py` (RFC 6901)
- `escape(token: str) -> str`: `~` becomes `~0` and `/` becomes `~1`; the input `~1` must come out as `~01`.
- `unescape(token: str) -> str`: `~1` becomes `/`, `~0` becomes `~`; `~01` is therefore `~1`. A `~`
  not followed by `0` or `1` raises `ValueError`.
- `build(tokens) -> str`: `""` for no tokens, otherwise `/` + the escaped `str(token)` of each
  token joined by `/`. Tokens may be str or int.
- `append(pointer: str, token) -> str`: pointer for a child, `pointer + "/" + escape(str(token))`.
- `parse(pointer: str) -> list[str]`: `""` gives `[]`; otherwise the pointer must start with `/`
  (else `ValueError`) and each segment is unescaped. `"/"` gives `[""]`.
- `resolve(doc, pointer)`: follows the tokens through `doc`. A dict is indexed by the token. A list
  is indexed only by a token matching `0` or a non-zero digit followed by digits (no sign, no
  leading zeros, no `-`) that is in range. Anything else (missing key, bad or out-of-range index,
  descending into a scalar) raises `KeyError`. A pointer with invalid syntax raises `ValueError`.

## `schemalite/keywords.py`
Helpers:
- `is_number(x)`: int or float, but never bool. `is_integer(x)`: an int that is not a bool, or a
  float with an integral value (`1.0` is an integer, `1.5` and `inf` are not).
- `is_type(instance, name) -> bool` for the names `string`, `number`, `integer`, `boolean`, `null`,
  `array`, `object`. A bool is neither a number nor an integer. Any other name raises `SchemaError`.
- `json_equal(a, b) -> bool`: JSON equality. `1 == 1.0` is true, but a bool equals only a bool
  (`True != 1`, `False != 0`, `True == True`). Lists compare element-wise in order, dicts by equal
  key sets and `json_equal` values, applied recursively (so `[1] == [1.0]` but `[True] != [1]`).

Group functions. Each is `check_x(instance, schema) -> list[tuple[str, str]]` where `schema` is a
dict; it returns `(keyword, message)` pairs, one per violated keyword, in the order the keywords
are listed below, and `[]` when everything holds. Messages are non-empty strings (wording is free).
A keyword that is absent from `schema` is skipped. These functions are non-recursive: they never
look into child values (`items`, `properties`, ... are handled in `validator.py`).

- `check_type`: `type` is a name or a non-empty list of names; the instance passes if it matches
  any. Unknown name, empty list or other value: `SchemaError`.
- `check_enum_const`: `enum` (must be a list, else `SchemaError`; passes if any member is
  `json_equal` to the instance), then `const` (`json_equal`; `"const": null` is a real constraint).
- `check_numeric`: `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`.
  Only applies when `is_number(instance)`; otherwise returns `[]`. `exclusiveMinimum`/`Maximum` are
  numbers (draft-6 style), not booleans. A bound that is not `is_number` raises `SchemaError`.
  `multipleOf` must be a number greater than 0 (else `SchemaError`). If the instance and
  `multipleOf` are both ints, test `instance % m == 0`. Otherwise let `q = instance / m`: the
  instance is a multiple when `q` is finite and `abs(q - round(q)) <= 1e-9 * max(1, abs(q))`.
  A non-finite `q` is not a multiple. So `0.3` is a multiple of `0.1`, and `0.35` is not.
- `check_string`: `minLength`, `maxLength`, `pattern`. Only applies to str. Lengths count Python
  code points (`len`) and must be ints >= 0 (not bool), else `SchemaError`. `pattern` uses
  `re.search` (not anchored); an invalid regex or non-string pattern raises `SchemaError`.
- `check_array`: `minItems`, `maxItems`, `uniqueItems`. Only applies to list. The counts are ints
  >= 0 (not bool), else `SchemaError`. `uniqueItems: true` fails when any two items are
  `json_equal` (so `[1, 1.0]` and `[{"a": 1}, {"a": 1.0}]` are duplicates, `[1, true]` is not);
  it is reported once. `uniqueItems: false` is a no-op.
- `check_object`: `minProperties`, `required`. Only applies to dict. `minProperties` is an int >= 0.
  `required` must be a list of strings (else `SchemaError`); one pair is returned **per missing
  name**, in the order of the `required` list.

## `schemalite/validator.py`
`validate(instance, schema) -> list[ValidationError]` and `is_valid(instance, schema) -> bool`.
The schema must be a dict, else `SchemaError`. Keywords are evaluated in exactly this order, and
errors are returned in that order (no sorting):

`$ref`, `type`, `enum`, `const`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`,
`multipleOf`, `minLength`, `maxLength`, `pattern`, `minItems`, `maxItems`, `uniqueItems`, `items`,
`minProperties`, `required`, `properties`, `additionalProperties`, `allOf`, `anyOf`, `oneOf`, `not`.

Unknown keywords are ignored. Every error from a group function becomes a `ValidationError` at the
current instance path with that keyword. A `type` mismatch does **not** stop other keywords from
being checked.

- `items`: a schema (dict, else `SchemaError`) applied to every element when the instance is a list,
  in index order; child errors have path `<path>/<index>`.
- `properties`: a dict of name -> schema. For each name **in schema order** that is present in the
  instance (dict), validate the value; child path is `append(path, name)` (escaped).
- `additionalProperties`: applies to instance keys not named in `properties`, in instance order.
  `true` does nothing. `false` yields one error per extra key, keyword `additionalProperties`, at
  that key's child path. A dict is a schema applied to each extra value (errors at child paths).
  Anything else is a `SchemaError`.
- `allOf`: a non-empty list of schemas; all are evaluated in order and their errors (same path)
  are concatenated in order.
- `anyOf`: a non-empty list. Subschemas are evaluated in order and evaluation **stops at the first
  one that is valid**. If none is valid, report exactly one error at the current path, keyword
  `anyOf` (the subschemas' own errors are discarded).
- `oneOf`: a non-empty list. **All** subschemas are evaluated. Unless exactly one is valid, report
  exactly one error at the current path, keyword `oneOf`.
- `not`: a schema. If the instance is valid against it, report one error, keyword `not`.
  `allOf`/`anyOf`/`oneOf` with an empty or non-list value raise `SchemaError`; a non-dict
  subschema raises `SchemaError`.
- `$ref`: a string of the form `#/definitions/<name>` (name is a JSON-pointer token, so `~1` etc.
  work), resolved with `pointer.resolve` against the **root** schema passed to `validate`. A ref
  that does not start with `#/definitions/`, is not a string, does not resolve, or resolves to a
  non-dict raises `SchemaError`. When `$ref` is present all sibling keywords are ignored. Errors
  from the target schema keep the current instance path. Recursive schemas work (a tree schema
  whose `children` items `$ref` back to it is fine). If the same `$ref` string is re-entered while
  still being evaluated **at the same instance path** (no progress was made through the instance,
  e.g. `a -> a`, `a -> b -> a`, or `a -> allOf[a]`), raise `SchemaError`.
- SchemaErrors are raised lazily: only for schemas and keywords that are actually evaluated. In
  particular a malformed or unresolvable subschema after a valid `anyOf` branch is never touched,
  and keywords that do not apply to the instance's type are not checked for well-formedness
  (except `type`, which is always checked). `validate` raises; it never returns a partial list.
- `is_valid(instance, schema)` is `not validate(instance, schema)`.

## `schemalite/cli.py`
`main(argv=None) -> int` (argv excludes the program name; default `sys.argv[1:]`) and
`python -m schemalite SCHEMA.json INSTANCE.json`.
- Loads both files as UTF-8 JSON, validates, and prints one line per error to stdout:
  `<path> <keyword>: <message>`, where `<path>` is `/` when the error path is `""`, else the path
  as is. Exit code 0 when valid (prints nothing), 1 when there are errors.
- Exit code 2, with `error: <message>` as a single line on stderr and nothing on stdout, for:
  wrong number of arguments (message starts `usage:`), an unreadable file, invalid JSON in either
  file, or a `SchemaError`.
