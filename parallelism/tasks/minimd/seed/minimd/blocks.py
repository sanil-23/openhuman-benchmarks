"""Block parsing into a small AST. See README.md."""
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class Heading:
    level: int
    text: str


@dataclass
class Paragraph:
    text: str


@dataclass
class CodeBlock:
    code: str
    lang: Optional[str] = None


@dataclass
class Rule:
    pass


@dataclass
class BlockQuote:
    paragraphs: List[Paragraph] = field(default_factory=list)


@dataclass
class ListItem:
    text: str
    sublist: Optional["ListBlock"] = None


@dataclass
class ListBlock:
    ordered: bool
    items: List[ListItem] = field(default_factory=list)


def parse_blocks(text):
    raise NotImplementedError
