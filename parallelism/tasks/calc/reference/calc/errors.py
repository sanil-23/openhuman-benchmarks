class CalcError(Exception):
    def __init__(self, message, pos=None):
        super().__init__(message)
        self.message = message
        self.pos = pos


class CalcSyntaxError(CalcError):
    def __init__(self, message, pos):
        super().__init__(message, pos)


class CalcNameError(CalcError):
    pass


class CalcZeroDivisionError(CalcError):
    pass


class CalcTypeError(CalcError):
    pass
