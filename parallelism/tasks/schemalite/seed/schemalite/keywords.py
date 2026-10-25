"""Keyword checks. See README.md."""


def is_number(x):
    raise NotImplementedError


def is_integer(x):
    raise NotImplementedError


def is_type(instance, name):
    raise NotImplementedError


def json_equal(a, b):
    raise NotImplementedError


def check_type(instance, schema):
    raise NotImplementedError


def check_enum_const(instance, schema):
    raise NotImplementedError


def check_numeric(instance, schema):
    raise NotImplementedError


def check_string(instance, schema):
    raise NotImplementedError


def check_array(instance, schema):
    raise NotImplementedError


def check_object(instance, schema):
    raise NotImplementedError
