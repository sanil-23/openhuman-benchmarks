"""Block parsing into a small AST. See README.md."""
import re
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


HEADING_RE = re.compile(r"^(#{1,6})(?: +(.*))?$")
RULE_RE = re.compile(r"^(?:-{3,}|\*{3,})$")
ITEM_RE = re.compile(r"^( *)([-*+]|\d+\.) +(\S.*)$")


def _heading(line):
    m = HEADING_RE.match(line)
    if not m:
        return None
    text = (m.group(2) or "").strip()
    text = re.sub(r"(^|\s+)#+$", "", text).strip()
    return Heading(len(m.group(1)), text)


def _top_item(line):
    m = ITEM_RE.match(line)
    return m if m and m.group(1) == "" else None


def _starts_block(line):
    return bool(
        _heading(line) or line.startswith("```") or RULE_RE.match(line)
        or line.startswith(">") or _top_item(line)
    )


def _paragraphs(lines):
    paras, cur = [], []
    for ln in lines:
        if ln.strip() == "":
            if cur:
                paras.append(Paragraph("\n".join(cur)))
                cur = []
        else:
            cur.append(ln.strip())
    if cur:
        paras.append(Paragraph("\n".join(cur)))
    return paras


def parse_blocks(text):
    lines = [ln[:-1] if ln.endswith("\r") else ln for ln in text.split("\n")]
    if lines and lines[-1] == "":
        lines.pop()
    blocks = []
    i, n = 0, len(lines)
    while i < n:
        raw = lines[i]
        line = raw.rstrip()
        if line.strip() == "":
            i += 1
            continue
        h = _heading(line)
        if h:
            blocks.append(h)
            i += 1
            continue
        if line.startswith("```"):
            info = line[3:].strip()
            lang = info.split()[0] if info else None
            i += 1
            code = []
            while i < n and lines[i].rstrip() != "```":
                code.append(lines[i])
                i += 1
            i += 1  # closing fence (or past EOF)
            blocks.append(CodeBlock("".join(c + "\n" for c in code), lang))
            continue
        if RULE_RE.match(line):
            blocks.append(Rule())
            i += 1
            continue
        if line.startswith(">"):
            inner = []
            while i < n and lines[i].startswith(">"):
                s = lines[i][1:]
                if s.startswith(" "):
                    s = s[1:]
                inner.append(s)
                i += 1
            blocks.append(BlockQuote(_paragraphs(inner)))
            continue
        m = _top_item(line)
        if m:
            ordered = m.group(2)[0].isdigit()
            items = []
            while i < n:
                m = ITEM_RE.match(lines[i].rstrip())
                if not m:
                    break
                indent = len(m.group(1))
                is_num = m.group(2)[0].isdigit()
                if indent == 0:
                    if is_num != ordered:
                        break
                    items.append(ListItem(m.group(3).strip()))
                elif indent >= 2:
                    cur = items[-1]
                    if cur.sublist is None:
                        cur.sublist = ListBlock(is_num, [])
                    cur.sublist.items.append(ListItem(m.group(3).strip()))
                else:
                    break
                i += 1
            blocks.append(ListBlock(ordered, items))
            continue
        para = [line.strip()]
        i += 1
        while i < n and lines[i].strip() != "" and not _starts_block(lines[i].rstrip()):
            para.append(lines[i].strip())
            i += 1
        blocks.append(Paragraph("\n".join(para)))
    return blocks
