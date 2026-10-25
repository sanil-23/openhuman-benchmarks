# minimd

A converter from a small Markdown subset to HTML, standard library only (Python 3.10, no pip installs).
The pipeline is: `parse_blocks` (text -> AST) -> `render_blocks` (AST -> HTML), with `render_inline`
turning the raw text inside a block into HTML spans.

## Modules

### `minimd/inline.py`
`render_inline(text: str) -> str` renders one string of inline markup. It never adds block tags.

**Escaping.** In ordinary text `&` -> `&amp;`, `<` -> `&lt;`, `>` -> `&gt;`. Quotes are NOT escaped in
text. Inside a link `href`, the same three plus `"` -> `&quot;`.
`a < b & c` -> `a &lt; b &amp; c`

**Backslash escapes.** `\` followed by one of ``\ ` * _ [ ] ( ) #`` produces that character literally
(and it never starts or ends any markup); the backslash disappears. A backslash before any other
character (or at the end of the text) is kept as is.
`\*not em\*` -> `*not em*`   `\d` -> `\d`   `C:\\dir` -> `C:\dir`

**Code spans.** A backtick starts a code span that ends at the next backtick. The content is HTML
escaped and otherwise literal: no markup, no backslash escapes, no stripping.
`` `a<b` `` -> `<code>a&lt;b</code>`   `` `*x* \* ` `` -> `<code>*x* \*</code>`
A backtick with no closing backtick is a literal backtick. Two adjacent backticks (` `` `) are two
literal backticks (there are no empty code spans).

**Emphasis.** `**x**` and `__x__` give `<strong>x</strong>`; `*x*` and `_x_` give `<em>x</em>`.
- An opening delimiter must be followed by a non-whitespace character. A closing delimiter must be
  preceded by a non-whitespace character, and the content between them must not be empty.
  `2 * 3 * 4` stays literal. `**` alone stays literal.
- A `_` or `__` opener must not be preceded by a letter or digit, and a `_` or `__` closer must not be
  followed by a letter or digit (so `snake_case_name` stays literal). `*` has no such restriction:
  `a*b*c` -> `a<em>b</em>c`.
- A delimiter of two characters is tried before one of the same character. The closer is the first
  matching delimiter that is allowed to close. Spans nest: `**a *b* c**` ->
  `<strong>a <em>b</em> c</strong>`, `*a **b** c*` -> `<em>a <strong>b</strong> c</em>`,
  `***x***` -> `<strong><em>x</em></strong>`.
- A delimiter that finds no closer is literal text (kept as written).
- Code spans and escaped characters inside the span are handled as above, so `*a `*` b*` is an `<em>`
  containing a code span, and `*a\**` -> `<em>a*</em>`.

**Links.** `[text](url)` -> `<a href="url">text</a>`.
- The link text is itself rendered with `render_inline` (so it may contain emphasis, code, escapes).
- The end of the text is the first `]` that is not backslash-escaped and not inside a code span, so
  `[a\]b](u)` -> `<a href="u">a]b</a>`.
- The `]` must be immediately followed by `(`; the url runs up to the first `)` and must not contain
  whitespace. The url is used as written (no backslash processing) but HTML-attribute escaped:
  `[x](a?b=1&c="2")` -> `<a href="a?b=1&amp;c=&quot;2&quot;">x</a>`. An empty url or empty text is allowed.
- Anything that does not fit this shape leaves the `[` as a literal character: `[x] (u)` -> `[x] (u)`.
- Emphasis does not span a link boundary from the outside in: delimiters inside the link text only
  pair with each other.

### `minimd/blocks.py`
`parse_blocks(text: str) -> list` returns a list of blocks using the dataclasses already defined in the
file. Text fields hold the RAW inline source (not rendered).

Preprocessing: split on `\n`; a trailing `\r` on a line is dropped; a final empty piece caused by a
trailing newline is ignored. A line is blank when it is empty after `strip()`. Trailing whitespace on
a line is ignored when classifying it. Blank lines separate blocks and produce nothing themselves.

- **Heading** `Heading(level, text)`: 1 to 6 `#` at column 0 followed by at least one space (or by the
  end of the line). The text is the rest, stripped, with an optional closing run of `#` removed when it
  is preceded by whitespace (or is the entire text), then stripped again.
  `## Title ##` -> `Heading(2, "Title")`; `# C#` -> `Heading(1, "C#")`; `#` -> `Heading(1, "")`.
  `#hello` and seven or more `#` are ordinary paragraph text.
- **Rule** `Rule()`: a line that is exactly three or more `-` or exactly three or more `*` (a single
  repeated character, nothing else on the line). `---`, `*****`.
- **Fenced code** `CodeBlock(code, lang)`: a line starting with three backticks opens a fence. `lang` is
  the first word after the backticks (`None` when there is none). The block holds every following line
  verbatim (blank lines and leading spaces included) up to a line that is exactly three backticks
  (trailing whitespace allowed). `code` is each line followed by `"\n"`; an empty fence has `code == ""`.
  If the input ends before a closing fence, the block simply ends at the end of the input (it still
  counts as a code block, and nothing is lost).
  Nothing inside a fence is interpreted as any other block.
- **Blockquote** `BlockQuote(paragraphs)`: consecutive lines starting with `>` at column 0. Remove the
  `>` and one following space if present; the remaining lines are split on blank lines (a bare `>` is
  blank) into paragraphs, each with its lines stripped and joined by `"\n"`. The quote ends at the first
  line that does not start with `>` (no lazy continuation). A quote holds paragraphs only; its inner
  text is NOT parsed for headings, lists, etc.
- **Lists** `ListBlock(ordered, items)` with `ListItem(text, sublist)`: an item line is: optional
  leading spaces, a marker (`-`, `*`, `+`, or digits followed by `.`), at least one space, then text
  (non-empty). A top-level item has no indentation. `ordered` is true when the first item's marker is
  numeric (the numbers themselves are ignored). A top-level item whose kind (ordered or not) differs
  from the list's ends that list and starts a new one; the bullet character itself (`-` vs `*` vs `+`)
  does not matter. An item line indented by 2 or more spaces directly continues the preceding top-level
  item as a sub-item: all of an item's sub-items form one `sublist` (any indentation of 2 or more means
  the same single level; its `ordered` follows its first sub-item). A line indented by exactly one space
  is not an item. A list ends at a blank line or at any line that is not an item line (no lazy
  continuation). A marker line indented by 2+ spaces when no list is open is ordinary paragraph text.
  The item text is stripped.
- **Paragraph** `Paragraph(text)`: any other run of lines. Each line is stripped and the lines are joined
  with `"\n"`. A paragraph ends at a blank line or at a line that would start any other block (heading,
  fence, rule, quote, or top-level list item).
  `a\nb` -> `Paragraph("a\nb")`.

### `minimd/render.py`
`render_blocks(blocks) -> str`: every block is rendered as below, each followed by a single `"\n"`
(so a non-empty result ends with a newline, and no blocks gives `""`). No indentation anywhere. Inline
text goes through `render_inline`.

| block | HTML |
| --- | --- |
| `Heading(2, "Hi")` | `<h2>Hi</h2>` |
| `Paragraph` | `<p>…</p>` (embedded `\n` kept) |
| `Rule` | `<hr>` |
| `CodeBlock` | `<pre><code>CODE</code></pre>`, or `<pre><code class="language-LANG">CODE</code></pre>` when `lang` is set. CODE is the `code` field HTML-escaped (`&`,`<`,`>`), with no inline processing; it already ends with `\n` so the closing tag follows on the next line. The lang is attribute-escaped. |
| `BlockQuote` | `<blockquote>` on its own line, then each paragraph as a `<p>` line, then `</blockquote>` (an empty quote is just the two tag lines) |
| `ListBlock` | `<ul>` or `<ol>` line, one `<li>…</li>` line per item, closing tag line |

An item with a sublist is written over several lines: `<li>TEXT` (no closing tag), then the nested
list lines, then `</li>`. Example for `- a\n  - b\n- c`:

```
<ul>
<li>a
<ul>
<li>b</li>
</ul>
</li>
<li>c</li>
</ul>
```

`convert(text: str) -> str` is `render_blocks(parse_blocks(text))`.

### `minimd/cli.py`
`python -m minimd [FILE|-]` converts FILE (UTF-8) and writes the HTML to stdout exactly as `convert`
returns it (no extra newline), exit code 0. With no argument or `-` it reads stdin. A missing or
unreadable file, or more than one argument, prints a single line starting with `error: ` to stderr
(for an unreadable file the line contains the file name), prints nothing to stdout, and exits 2.
`main(argv=None)` takes the argument list (default `sys.argv[1:]`) and returns the exit code.
