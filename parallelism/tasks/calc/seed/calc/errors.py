"""Error types. See README.md."""


class CalcError(Exception):
    pass


class CalcSyntaxError(CalcError):
    pass


class CalcNameError(CalcError):
    pass


class CalcZeroDivisionError(CalcError):
    pass


class CalcTypeError(CalcError):
    pass
