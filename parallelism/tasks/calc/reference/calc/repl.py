import math

from .evaluator import Environment, evaluate
from .parser import parse


def run(source, env=None):
    if env is None:
        env = Environment()
    result = None
    for stmt in parse(source):
        result = evaluate(stmt, env)
    return result


def format_value(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    return repr(value)
