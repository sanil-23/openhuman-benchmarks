"""Command line entry point. See README.md."""
import sys

from .render import convert


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) > 1:
        print("error: usage: python -m minimd [FILE|-]", file=sys.stderr)
        return 2
    src = args[0] if args else "-"
    try:
        if src == "-":
            text = sys.stdin.read()
        else:
            with open(src, encoding="utf-8") as f:
                text = f.read()
    except OSError as e:
        print("error: cannot read %s: %s" % (src, e.strerror or e), file=sys.stderr)
        return 2
    sys.stdout.write(convert(text))
    return 0
