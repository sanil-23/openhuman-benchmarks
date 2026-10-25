import math

from .errors import CalcNameError, CalcTypeError, CalcZeroDivisionError
from .parser import Assign, Binary, Call, Compare, Num, Unary, Var


def _arity(name, got, lo, hi):
    if got < lo or (hi is not None and got > hi):
        if hi is None:
            exp = "at least %d" % lo
        elif lo == hi:
            exp = "%d" % lo
        else:
            exp = "%d to %d" % (lo, hi)
        raise CalcTypeError("wrong number of arguments for '%s': expected %s, got %d" % (name, exp, got))


def _min(*a):
    return min(a)


def _max(*a):
    return max(a)


def _sqrt(x):
    if x < 0:
        raise CalcTypeError("sqrt() argument must be non-negative")
    return math.sqrt(x)


# name -> (min args, max args or None, function)
BUILTINS = {
    "min": (1, None, _min),
    "max": (1, None, _max),
    "abs": (1, 1, abs),
    "round": (1, 2, round),
    "sqrt": (1, 1, _sqrt),
    "sum": (0, None, lambda *a: sum(a)),
}


class Environment:
    def __init__(self, variables=None):
        self.variables = {"pi": math.pi, "e": math.e}
        if variables:
            self.variables.update(variables)
        self.functions = {name: spec for name, spec in BUILTINS.items()}


def _div_guard(fn):
    try:
        return fn()
    except ZeroDivisionError:
        raise CalcZeroDivisionError("division by zero") from None


def _binary(op, a, b):
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op == "/":
        return _div_guard(lambda: a / b)
    if op == "//":
        return _div_guard(lambda: a // b)
    if op == "%":
        return _div_guard(lambda: a % b)
    if op == "**":
        r = _div_guard(lambda: a ** b)
        if isinstance(r, complex):
            raise CalcTypeError("result is not a real number")
        return r
    raise AssertionError(op)


_CMP = {
    "==": lambda a, b: a == b,
    "!=": lambda a, b: a != b,
    "<": lambda a, b: a < b,
    "<=": lambda a, b: a <= b,
    ">": lambda a, b: a > b,
    ">=": lambda a, b: a >= b,
}


def evaluate(node, env):
    if isinstance(node, Num):
        return node.value
    if isinstance(node, Var):
        if node.name not in env.variables:
            raise CalcNameError("undefined variable '%s'" % node.name)
        return env.variables[node.name]
    if isinstance(node, Unary):
        v = evaluate(node.operand, env)
        return -v if node.op == "-" else +v
    if isinstance(node, Binary):
        return _binary(node.op, evaluate(node.left, env), evaluate(node.right, env))
    if isinstance(node, Compare):
        return _CMP[node.op](evaluate(node.left, env), evaluate(node.right, env))
    if isinstance(node, Assign):
        v = evaluate(node.value, env)
        env.variables[node.name] = v
        return v
    if isinstance(node, Call):
        if node.name not in env.functions:
            raise CalcNameError("undefined function '%s'" % node.name)
        lo, hi, fn = env.functions[node.name]
        args = [evaluate(a, env) for a in node.args]
        _arity(node.name, len(args), lo, hi)
        return fn(*args)
    raise TypeError("unknown node %r" % (node,))
