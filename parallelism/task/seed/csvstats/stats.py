"""Descriptive statistics and grouping. See README.md."""


def describe(values):
    raise NotImplementedError


def percentile(values, q):
    raise NotImplementedError


def group_by(rows, key):
    raise NotImplementedError


def aggregate(rows, group, column, funcs):
    raise NotImplementedError
