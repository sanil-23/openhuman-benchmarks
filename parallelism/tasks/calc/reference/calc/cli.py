import sys

from .errors import CalcError
from .repl import format_value, run


def main(argv=None, stdin=None, stdout=None, stderr=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr
    if len(argv) != 1:
        print("usage: python -m calc EXPR | -", file=stderr)
        return 2
    source = stdin.read() if argv[0] == "-" else argv[0]
    try:
        value = run(source)
    except CalcError as exc:
        msg = "error: %s" % exc.message
        if exc.pos is not None:
            msg += " (at %d)" % exc.pos
        print(msg, file=stderr)
        return 2
    if value is not None:
        print(format_value(value), file=stdout)
    return 0
