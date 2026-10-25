"""Shared exception and error record types. See README.md."""

from dataclasses import dataclass


class SchemaError(Exception):
    """The schema is malformed or contains an unresolvable reference."""


@dataclass(frozen=True)
class ValidationError:
    path: str
    keyword: str
    message: str
