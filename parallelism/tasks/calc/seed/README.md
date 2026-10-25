# calc

A small expression language and command line calculator, standard library only (Python 3.10, no pip installs).

```
$ python -m calc "1 + 2 * 3"
7
$ python -m calc "x = 4; x ** 2 / 8"
2.0
```

## Modules

### `calc/errors.py`
- `CalcError(Exception)` is the base class. It has `.message` (str) and `.pos` (0-based int, or `None` when
  no position is known). `str(err)` is the message.
- `CalcSyntaxError(message, pos)`: always has a position. Subclass of `CalcError`.
- `CalcNameError`, `CalcZeroDivisionError`, `CalcTypeError`: subclasses of `CalcError` constructed as
  `Cls(message)`; their `.pos` is `None`.

### `calc/lexer.py`
`tokenize(source: str) -> list[Token]` where `Token` is a frozen dataclass `Token(kind, text, pos)`
(`pos` is the 0-based index of the first character of the token). The list always ends with an `EOF`
token whose text is `""` and whose pos is `len(source)`.

| kind     | text                                                              |
|----------|-------------------------------------------------------------------|
| `NUMBER` | the raw text, underscores included (`1_000`, `2.5`, `1e3`, `1.5E-2`) |
| `IDENT`  | `[A-Za-z_][A-Za-z0-9_]*`                                           |
| `OP`     | one of `+ - * / // % **  == != < <= > >=` (longest match wins)      |
| `LPAREN` / `RPAREN` / `COMMA` | `(` / `)` / `,`                              |
| `ASSIGN` | `=` (a single `=`; `==` is an `OP`)                                |
| `SEP`    | `;` or a newline `\n` (statement separators)                       |
| `EOF`    | end of input                                                       |

- Spaces, tabs and `\r` between tokens are skipped. Newlines are never skipped: they are `SEP` tokens.
- Number syntax: digits, optionally `.` followed by digits, optionally an exponent `e`/`E`, an optional
  sign and digits. Underscores are allowed only between two digits (`1_000`, `1_0.2_5`). There are no
  leading-dot or trailing-dot numbers: `.5` fails on the `.` as an unexpected character, and `1.` is an invalid number (see next rule).
- A number that is directly followed by a letter, `_` or `.` after the number has been matched (`2x`,
  `1_`, `1__0`, `1e`, `1.5.2`, `1.`) raises `CalcSyntaxError("invalid number", pos)` where `pos` is the start
  of the number.
- Any other character raises `CalcSyntaxError("unexpected character '<c>'", pos)` where `<c>` is the
  character as formatted by Python's `%r` (so `$` gives `'$'`) and pos is its index. This includes a lone `!`.

### `calc/parser.py`
`parse(source: str) -> list` returns a list of statements (empty for empty/blank input). Statements are
separated by one or more `SEP` tokens; empty statements (`1;;2`, a trailing newline) are ignored.
AST nodes are plain (non-frozen) dataclasses, compared by value:

| node | fields |
|------|--------|
| `Num` | `value` (an `int` when the text has no `.`/exponent, else a `float`; underscores removed) |
| `Var` | `name` |
| `Unary` | `op` (`"+"` or `"-"`), `operand` |
| `Binary` | `op` (`+ - * / // % **`), `left`, `right` |
| `Compare` | `op` (`== != < <= > >=`), `left`, `right` |
| `Call` | `name`, `args` (a `list`) |
| `Assign` | `name`, `value` |

Grammar, loosest binding first (parentheses add no node; they only group):

| level | construct | associativity |
|-------|-----------|---------------|
| 1 | `name = expr` (statement level only) | n/a |
| 2 | `== != < <= > >=` | **not chainable** |
| 3 | `+ -` (binary) | left |
| 4 | `* / // %` | left |
| 5 | `+ -` (unary prefix) | right (`- -3`) |
| 6 | `**` | right |
| 7 | numbers, names, `f(a, b)`, `( expr )` | |

- `**` binds tighter than a unary minus on its left: `-2**2` is `Unary('-', Binary('**', 2, 2))`.
  The right operand of `**` may itself be unary: `2**-1` is `Binary('**', 2, Unary('-', 1))`, and
  `2**3**2` is `2**(3**2)`.
- Assignment is only recognised when a statement starts with `IDENT` followed by `ASSIGN`. It produces
  `Assign(name, value)` and its value is a comparison-level expression, so `x = 1 < 2` is fine.
  An assignment anywhere else, and `x = y = 1`, is an error (see below).
- Call arguments are comparison-level expressions separated by commas; `f()` has zero arguments.
- Errors are `CalcSyntaxError` with these exact messages and positions:
  - an expression was expected but the next token is `EOF` or `SEP`: `unexpected end of input`, at that token's pos;
  - an expression was expected and the next token is anything else, or a complete statement is
    followed by something other than `SEP`/`EOF`: `unexpected token '<text>'` at that token
    (so `1 2`, `x = y = 1`, `f(1,)`, `1(2)` and `(1))` all fail this way);
  - a `)` was required (closing a group or a call) but another token was found: `expected ')'` at that token
    (at `len(source)` for end of input);
  - a second comparison operator after a comparison (`1 < 2 < 3`, `a == b != c`):
    `chained comparison is not supported`, positioned at the **second** operator.
  - lexer errors propagate unchanged.
- Newlines always end a statement, even inside parentheses: `(1 +\n2)` is a syntax error.

### `calc/evaluator.py`
`Environment(variables=None)` has `.variables` (dict) and `.functions` (dict). Variables start as
`pi` and `e` (from `math`) plus a copy of any `variables` passed in. Functions and variables live in
separate namespaces (`max = 3` does not break `max(1, 2)`).
`evaluate(node, env)` returns the value of one node, mutating `env.variables` for `Assign`
(an assignment's value is the assigned value).

Numbers:
- `+ - *` follow Python on `int`/`float`; an `int` result stays `int`.
- `/` always gives a `float` (`4 / 2` is `2.0`).
- `//` is floor division (`7 // -2` is `-4`; `7.5 // 2` is `3.0`) and `%` has Python's sign semantics
  (`-7 % 3` is `2`, `7 % -3` is `-2`). Both stay `int` for two ints.
- `**`: `int ** non-negative int` is an `int`; with a negative int exponent it is a `float` (`2 ** -1` is `0.5`).
- Comparisons return a Python `bool` (`1 < 2` is `True`, not `1`), using Python semantics.

Built-in functions (the name is looked up first, then the arguments are evaluated left to right, then
the argument count is checked):
- `min(a, ...)`, `max(a, ...)`: at least 1 argument.
- `abs(x)`: exactly 1. `sqrt(x)`: exactly 1, always returns a `float` (`sqrt(16)` is `4.0`).
- `round(x)` or `round(x, n)`: Python's `round` (banker's rounding: `round(2.5)` is `2`, and `round(7)` is the `int` 7).
- `sum(a, ...)`: any number of arguments; `sum()` is `0`.

Errors (all subclasses of `CalcError`, `.pos` is `None`):
- `CalcNameError("undefined variable 'x'")` for a `Var` not in `env.variables` (a bare function name such as
  `max` is an undefined variable too); `CalcNameError("undefined function 'f'")` for a call to a name not in `env.functions`
  (so `pi(1)` is an undefined function).
- `CalcZeroDivisionError("division by zero")` for `/`, `//`, `%` with a zero right operand, and for `0 ** -1`.
- `CalcTypeError` for:
  - wrong argument count: `wrong number of arguments for 'NAME': expected N, got M`, where N is
    `1` / `at least 1` / `1 to 2` depending on the function's allowed range (`min`, `max`: `at least 1`;
    `round`: `1 to 2`; `abs`, `sqrt`: `1`);
  - `sqrt` of a negative number: `sqrt() argument must be non-negative`;
  - any `**` whose result would be complex (a negative base with a non-integer exponent, e.g. `(-8) ** 0.5`):
    `result is not a real number`.

### `calc/repl.py`
- `run(source, env=None) -> value or None` parses `source`, evaluates every statement in order in one
  shared `Environment` (a new one when `env` is `None`) and returns the value of the last statement,
  or `None` when there are no statements. Errors propagate.
- `format_value(value) -> str`: `bool` gives `true` / `false`, `int` gives `str(value)`, `float` gives `repr(value)`
  (`2.0`, `0.1`, `1000.0`).

### `calc/cli.py`
`main(argv=None, stdin=None, stdout=None, stderr=None) -> int` (`argv` excludes the program name; the
streams default to `sys.stdin/stdout/stderr`). `python -m calc` calls it.
- Exactly one argument is expected. If it is `-`, the program is the whole of stdin; otherwise the
  argument itself is the program. It prints `format_value(result)` plus a newline to stdout and returns 0. When the program
  has no statements nothing is printed and 0 is returned.
- On any `CalcError` it prints `error: <message> (at <pos>)` to stderr (just `error: <message>` when
  `pos` is `None`) and returns 2. Nothing is printed to stdout.
- With the wrong number of arguments it prints `usage: python -m calc EXPR | -` to stderr and returns 2.

## Examples

| source | result |
|--------|--------|
| `-2**2` | `-4` |
| `2**3**2` | `512` |
| `7 // -2` | `-4` |
| `-7 % 3` | `2` |
| `1_000 + 1` | `1001` |
| `1e3` | `1000.0` |
| `1 < 2` | `True` (printed `true`) |
| `x = 3; x * 2` | `6` |
| `max(1, 2) + min(4)` | `6` |
| `1 < 2 < 3` | `CalcSyntaxError('chained comparison is not supported', 6)` |
| `3 $ 4` | `CalcSyntaxError("unexpected character '$'", 2)` |
