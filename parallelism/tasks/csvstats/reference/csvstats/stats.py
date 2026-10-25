import math


def _nums(values):
    return [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]


def percentile(values, q):
    xs = sorted(_nums(values))
    if not xs:
        raise ValueError("percentile of empty data")
    if not 0 <= q <= 100:
        raise ValueError("q must be within [0, 100]")
    pos = (len(xs) - 1) * q / 100
    lo = math.floor(pos)
    hi = math.ceil(pos)
    return float(xs[lo] + (xs[hi] - xs[lo]) * (pos - lo))


def describe(values):
    xs = _nums(values)
    if not xs:
        return {"count": 0}
    n = len(xs)
    mean = sum(xs) / n
    sd = math.sqrt(sum((x - mean) ** 2 for x in xs) / (n - 1)) if n > 1 else 0.0
    return {"count": n, "mean": mean, "median": percentile(xs, 50), "stdev": sd, "min": min(xs), "max": max(xs)}


def group_by(rows, key):
    out = {}
    for r in rows:
        k = r.get(key)
        out.setdefault("(none)" if k is None else k, []).append(r)
    return out


def _func(name, xs):
    if name == "count":
        return len(xs)
    if name == "sum":
        return sum(xs)
    if name in ("mean", "median", "min", "max", "stdev"):
        return describe(xs).get(name)
    if name.startswith("p") and name[1:].isdigit():
        return percentile(xs, int(name[1:])) if xs else None
    raise ValueError(f"unknown stat: {name}")


def aggregate(rows, group, column, funcs):
    for f in funcs:
        _func(f, [])
    out = []
    for k, grp in group_by(rows, group).items():
        xs = _nums([r.get(column) for r in grp])
        row = {group: k}
        for f in funcs:
            row[f"{column}_{f}"] = _func(f, xs)
        out.append(row)
    return out
