"""Source HTML → the plain text a description is stored as.

Two of the three places that supply a description hand over HTML: an EPUB's
OPF (`<dc:description>`, routinely a `<p>`/`<br>` fragment) and Calibre's
`comments` column (HTML by construction). Google Books sends plain text, for
which this is a no-op.

A stored description is plain text whose paragraph breaks are newlines — the
detail panel renders it with `whitespace-pre-line`. A block boundary that is
dropped rather than turned into a newline welds two paragraphs onto one line
("…for a new generation of women.It started with the Sh*t I Do List."), and
markup that is not stripped at all reaches the panel verbatim. Measured
against the real library before this rule existed: 2,781 of 6,462 books held
`<p>` in the stored description and 1,320 held `<br>`.

Both extractors call this rather than each carrying its own strip, so the two
cannot disagree about what a description is.
"""

import html
import re
from typing import Optional

# A structural boundary — the end of a paragraph, line or list item. It has to
# survive as a newline here. Inline tags (`i`, `b`, `strong`, `span`, `a`) are
# emphasis *inside* a paragraph and are dropped without a break; so is an
# opening tag, which would otherwise turn one boundary into a blank line.
_BLOCK_BREAK = re.compile(
    r"(?i)<\s*(?:br|hr|/p|/div|/li|/ul|/ol|/tr|/h[1-6]|/blockquote|/section)\s*/?\s*>"
)

# A tag has to *look* like one — `<` then a letter (or `</` then a letter) —
# so a description that legitimately reads "5 < 6 and 7 > 2" is left alone.
_TAG = re.compile(r"</?[a-zA-Z][^>]*>")

# An escape depth no real description reaches: three levels is the deepest
# measured in the library, and the loop stops as soon as a pass changes
# nothing, so plain text costs one pass whatever this is set to.
MAX_PASSES = 4


def html_to_text(fragment: Optional[str]) -> str:
    """Plain text for a description that arrived as HTML.

    Paragraph structure is preserved as newlines; everything else about the
    markup is dropped. Plain text passes through unchanged.
    """
    if not fragment:
        return ""

    # Repeat until the text stops changing (bounded): a description can arrive
    # double- or triple-escaped — the real library holds a
    # `<p>&amp;lt;p&amp;gt;Award-winning cookbook author…` whose innermost tag
    # only surfaces on the third pass — and any pass short of stable leaves
    # markup visible, which is the defect this exists to remove. It
    # over-resolves absurdly deep `&amp;amp;…` chains, which is the trade for
    # never showing a reader `&#8212;`.
    text = fragment
    for _ in range(MAX_PASSES):
        before = text
        text = _BLOCK_BREAK.sub("\n", text)
        text = _TAG.sub("", text)
        text = html.unescape(text)
        if text == before:
            break

    text = text.replace("\xa0", " ")  # &nbsp; is a space, not a line character
    text = re.sub(r"[ \t]*\n[ \t]*", "\n", text)  # no trailing spaces per line
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()
