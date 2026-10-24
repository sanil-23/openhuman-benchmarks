# csvstats

A small CSV statistics tool, standard library only (Python 3.10, no pip installs).

## Modules

### `csvstats/reader.py`
`parse_csv(text: str) -> list[dict]`
- First row is the header. Fields are comma separated.
- RFC 4180 quoting: a field may be wrapped in `"`; inside, `""` is a literal quote, and commas and
  newlines are part of the field. `\r\n` and `\n` both end a record. Blank lines are skipped.
- A row with the wrong number of fields raises `ValueError` whose message contains the 1-based
  record number (header is record 1).
- Values are type-inferred per cell: integer text -> `int`, other numeric text -> `float`,
  empty (after stripping) -> `None`, everything else stays `str` (stripped of surrounding spaces
  unless it was quoted). `"007"` unquoted is the int 7; quoted `"007"` stays the string `007`.

### `csvstats/stats.py`
- `describe(values) -> dict` ignores `None` and non-numeric values. Returns keys `count`, `mean`,
  `median`, `stdev` (sample, n-1; `0.0` when count < 2), `min`, `max`. With no usable values returns
  `{"count": 0}` only.
- `percentile(values, q) -> float` with `0 <= q <= 100`, linear interpolation between closest ranks
  (the same as numpy's default). Raises `ValueError` for empty input or q out of range.
- `group_by(rows, key) -> dict` preserves first-seen order of groups; rows missing the key or with a
  `None` key go in the group `"(none)"`.
- `aggregate(rows, group, column, funcs) -> list[dict]` one output row per group, with the column
  `group` plus one column per entry of `funcs`. A func is `count`, `sum`, `mean`, `median`, `min`,
  `max`, `stdev` or `pNN` (e.g. `p90`). Output columns are named `<column>_<func>`.
  Unknown funcs raise `ValueError`.

### `csvstats/report.py`
`render_table(rows, columns=None) -> str` renders a GitHub markdown table. Floats are shown with
2 decimals, `None` as an empty cell, numbers right-aligned (`---:`), text left-aligned (`:---`).
Header cells are aligned like their column. Column widths fit the widest cell (minimum 3). `columns` defaults to the keys of the first row.
`render_json(rows) -> str` is `json.dumps(rows, indent=2, sort_keys=False)` plus a trailing newline.

### `csvstats/cli.py`
`python -m csvstats FILE [--group-by COL] --column COL [--stats mean,p90] [--format table|json]`
- `--stats` defaults to `count,mean,min,max`. Without `--group-by` all rows form one group named `all`.
- Reads from stdin when FILE is `-`.
- Errors (missing file, unknown column, bad stat) print `error: <message>` to stderr and exit 2.
- Prints the rendered result to stdout and exits 0.
