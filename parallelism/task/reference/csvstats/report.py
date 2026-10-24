import json


def _cell(v):
    if v is None:
        return ""
    if isinstance(v, float):
        return f"{v:.2f}"
    return str(v)


def render_table(rows, columns=None):
    if not rows and columns is None:
        return ""
    cols = columns or list(rows[0].keys())
    num = {c: all(isinstance(r.get(c), (int, float)) or r.get(c) is None for r in rows) for c in cols}
    cells = [[_cell(r.get(c)) for c in cols] for r in rows]
    w = [max(3, len(c), *(len(row[i]) for row in cells)) for i, c in enumerate(cols)]

    def fmt(vals, right):
        return "| " + " | ".join(v.rjust(w[i]) if right[i] else v.ljust(w[i]) for i, v in enumerate(vals)) + " |"

    right = [num[c] for c in cols]
    lines = [fmt(cols, [False] * len(cols))]
    lines.append("| " + " | ".join(("-" * (w[i] - 1) + ":") if right[i] else (":" + "-" * (w[i] - 1)) for i in range(len(cols))) + " |")
    lines += [fmt(row, right) for row in cells]
    return "\n".join(lines) + "\n"


def render_json(rows):
    return json.dumps(rows, indent=2, sort_keys=False) + "\n"
