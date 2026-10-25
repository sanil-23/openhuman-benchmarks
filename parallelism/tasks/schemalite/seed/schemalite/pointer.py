"""JSON pointer helpers (RFC 6901). See README.md."""


def escape(token):
    raise NotImplementedError


def unescape(token):
    raise NotImplementedError


def build(tokens):
    raise NotImplementedError


def append(pointer, token):
    raise NotImplementedError


def parse(pointer):
    raise NotImplementedError


def resolve(doc, pointer):
    raise NotImplementedError
