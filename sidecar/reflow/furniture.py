"""Page furniture — one rule, read from both sides of the pass.

The pipeline drops a block out of the flowing text; the gate holds the same line
out of G2's evidence, because counting the words a *correct* drop removed is how
the artifact of a broken rule still passed the gate. The two used to carry the
rule twice — `layout.mark_running_heads` over Vision's regions, `gate._emit` over
the text layer's own lines — and the copies drifted: the *tier* they last agreed
on asked a question about the whole book (how often does this digit-normalized
key repeat?) from a function that sees one page, and its verdict moved between
two runs over the same source. The artifact stopped reproducing itself, which is
the one thing D9's stamp rests on.

So the rule lives here once, as predicates over plain numbers and strings, and
each caller hands it what it has. Nothing here counts anything.

**What the corpus says the furniture is** (measured 2026-10-13 over the layout
records of the six books of `scripts/pdf-reflow-probe.py`, *Universe* — a
535-page textbook — being the instance to engineer against; the counts are the
blocks this rule drops):

| Shape | Universe | Modernist | Politics | the two papers |
| --- | --- | --- | --- | --- |
| a letter-spaced running head in the band | 382 | 48 | 3 | 0 |
| anything in the page's own outer margin | 453 | 40 | 0 | 0 |

*Universe* carried ~500 blocks of printer's furniture in its flowing text — the
Cengage legal footer on 61% of its pages, a letter-spaced running head with the
page number welded into its tail, its part dividers — and both shapes are
properties of the line itself. That is the point of them: a running head names
its own chapter (`C H A PT E R 3 CYC L ES O F TH E SU N A N D M OO N 39`), so no
book-wide key reaches half the pages, and the block the pass builds for the
Cengage footer varies page to page (the text layer's two lines zipped in a
varying order) — 244 footer paragraphs, 77 normalized variants, the commonest on
38 of 534 text pages, against the 267 a half-share needs. Repetition cannot be
loosened into a repair here; it has to be dropped, and the shape read instead.
Run 4 of the corpus probe drops 835 blocks from *Universe*'s 13,030 and reads
`gate.furniture_census` at zero for every text book.
"""

from __future__ import annotations

BAND = 0.08  # of the page height, top and bottom: where printer's marks sit
MAX_CHARS = 80  # a band line up to here is furniture when the *book* repeats it
MARGIN = 0.025  # the page's own outer strip, below the bottom text margin
LETTER_SPACED_WORDS = 3  # one-character words that make a line letter-spaced
LETTER_SPACED_SHARE = 0.4
LETTER_SPACED_CHARS = 12


def letter_spaced(text: str) -> bool:
    """Is this line set out letter by letter — the shape a running head has?

    A designed running head is set in letter-spaced capitals and the text layer
    stores the extra gaps as real spaces, so the line arrives as a run of
    one-character words: `C H A PT E R 3 CYC L ES O F TH E SU N A N D M OO N 39`
    is 14 of its 22 words one character long, and *Universe*'s part dividers
    (`PA RT 1 TH E S KY`, `AC KN OW L E DG M E NTS`) only 3 of 7. The floor is
    three words and two-fifths of them, and the second number is what makes the
    first safe: the shape is a property of the line rather than a count of it,
    which is what a book-wide key could not be.

    Measured on the corpus 2026-10-12, and it is why the caller must still test
    the band. At this floor the test takes 147 more in-band blocks in *Universe*
    (every one a part divider or an acknowledgement heading) and 27 more in
    *Modernist Cuisine* (every one of its `VOLUME 1 · HISTORY AND FUNDAMENTALS`
    running heads, in settings with one more break than three words would need),
    and **not one block in the other four books** — while of *Universe*'s 252
    letter-spaced blocks the 17 outside the band are content: an equation
    (`V = V1.04 × 10° = 1020 m/s`), a figure key (`Star a Ari b CM`), and a page
    whose own text layer reads as one long smear.
    """
    words = text.split()
    if len(text) < LETTER_SPACED_CHARS or not words:
        return False
    singles = sum(1 for word in words if len(word) == 1)
    return singles >= LETTER_SPACED_WORDS and singles >= LETTER_SPACED_SHARE * len(words)


def in_band(top: float, bottom: float, page_bottom: float, page_top: float) -> bool:
    """Does this box reach into the page's top or bottom 8%?"""
    height = page_top - page_bottom
    if height <= 0:
        return False
    return top >= page_bottom + (1 - BAND) * height or bottom <= page_bottom + BAND * height


def in_margin(top: float, bottom: float, page_bottom: float, page_top: float) -> bool:
    """Does this box lie wholly inside the page's own outer strip?

    Below the bottom text margin, or above the top one. A book prints its legal
    notice there and nothing else: the strip is outside the column a reader
    reads, so prose does not reach it. Measured 2026-10-12 — the strip is what
    separates *Universe*'s 315 footer blocks (their tops at 1.9–2.3% of the page)
    from the two *Modernist Cuisine* paragraphs that merely end low on their
    pages (tops at 2.7%), which the wider 8% band cannot.
    """
    height = page_top - page_bottom
    if height <= 0:
        return False
    return top <= page_bottom + MARGIN * height or bottom >= page_top - MARGIN * height


def shaped(top: float, bottom: float, page_bottom: float, page_top: float, text: str) -> bool:
    """Is this line printer's work *whatever the book does*? No count is asked.

    Two shapes, each measured against the corpus rather than assumed:

    - a **running head**, i.e. a letter-spaced line in the band;
    - **anything the page prints in its own outer margin** — below the bottom
      text margin or above the top one. A book sets prose inside its margins and
      its legal notices outside them, and the corpus bears that out: every one of
      the 184 blocks lying wholly inside those strips on the 2026-10-12 corpus is
      furniture — *Universe*'s 138 footer fragments (`Copyright 2012 Cengage Le
      deemed that`) and *Modernist Cuisine*'s 46 one-line running heads and their
      page numbers (`VOLUME 1 · HISTORY AND FUNDAMENTALS`, `FOOD AND HEALTH`) —
      while all three books that print nothing there measure zero.

    Both are in the band by the time they answer: the margin is inside it, and
    the head's test is the band itself. What is *not* here is the tier's
    question — whether the book repeats the line — which is what could not be
    answered from one page and could not be reproduced from one run to the next.
    """
    text = text.strip()
    if not text or not in_band(top, bottom, page_bottom, page_top):
        return False
    return letter_spaced(text) or in_margin(top, bottom, page_bottom, page_top)
