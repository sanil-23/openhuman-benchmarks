import argparse
import sys

from .reader import parse_csv
from .report import render_json, render_table
from .stats import aggregate


def main(argv=None):
    p = argparse.ArgumentParser(prog="csvstats")
    p.add_argument("file")
    p.add_argument("--group-by")
    p.add_argument("--column", required=True)
    p.add_argument("--stats", default="count,mean,min,max")
    p.add_argument("--format", choices=["table", "json"], default="table")
    try:
        a = p.parse_args(argv)
    except SystemExit as e:
        return 2 if e.code else 0
    try:
        text = sys.stdin.read() if a.file == "-" else open(a.file, encoding="utf-8").read()
        rows = parse_csv(text)
        for col in filter(None, [a.group_by, a.column]):
            if rows and col not in rows[0]:
                raise ValueError(f"unknown column: {col}")
        if a.group_by:
            out = aggregate(rows, a.group_by, a.column, a.stats.split(","))
        else:
            out = aggregate([{**r, "all": "all"} for r in rows], "all", a.column, a.stats.split(","))
    except (OSError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    sys.stdout.write(render_json(out) if a.format == "json" else render_table(out))
    return 0
