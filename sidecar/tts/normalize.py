"""Rewrite the few number shapes espeak-ng reads wrongly, before it sees the text.

Measured 2026-10-15 with the bundled library: `3.5 million` → "three. five million"
(the point is taken for a sentence end) and `$2.1 billion` → "two dollars. one
billion". `2.0` happens to come out right, and is rewritten anyway so there is one
rule. Everything not named here is passed through unchanged — this is a patch for two
measured failures, not a text-to-speech normalizer, and the known gaps (dates, clock
times, ordinals) are recorded in the spec rather than half-handled.
"""

from __future__ import annotations

import re

_MAGNITUDE = r"(?:thousand|million|billion|trillion)"
# \d{1,3}(?:,\d{3})* before \d+, so "$5, then" keeps its comma (the comma is not part of the number).
_CURRENCY = re.compile(
    r"\$(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s+(" + _MAGNITUDE + r"))?", re.IGNORECASE
)
_DECIMAL = re.compile(r"(?<=\d)\.(?=\d)")

# Text with nothing to say must be silent, not spoken (measured 2026-10-15: `***` is read
# "asterisk asterisk asterisk", `[12]` "twelve", an emoji by its name).
_ASTERISK = r"\*"
_CITATION = r"\[\s*\d+(?:\s*[,\-\u2013]\s*\d+)*\s*\]"
# Pictographs (U+1F000-1FAFF, which includes skin-tone modifiers; misc symbols and
# dingbats U+2600-27BF) with any variation selector / zero-width joiner attached.
_EMOJI = r"[\U0001F000-\U0001FAFF\u2600-\u27BF][\uFE0F\u200D]*"
_TOKEN = "|".join((_ASTERISK, _CITATION, _EMOJI))
# A run of tokens (so `* * *` is one match) with the whitespace on either side captured.
_REMOVABLE = re.compile(r"(\s*)(?:" + _TOKEN + r")(?:\s*(?:" + _TOKEN + r"))*(\s*)")


def _dollars(whole: str) -> str:
    return f"{whole} dollar" if whole == "1" else f"{whole} dollars"


def _currency(match: re.Match[str]) -> str:
    whole = match.group(1).replace(",", "")
    fraction = match.group(2)
    magnitude = match.group(3)
    if magnitude:
        number = f"{whole} point {fraction}" if fraction else whole
        return f"{number} {magnitude} dollars"
    if fraction is None:
        return _dollars(whole)
    if len(fraction) == 2:
        cents = int(fraction)
        if cents == 0:
            return _dollars(whole)
        return f"{_dollars(whole)} and {cents} {'cent' if cents == 1 else 'cents'}"
    return f"{whole} point {fraction} dollars"


def _drop(match: re.Match[str]) -> str:
    """Remove a run of nothing-to-say tokens and heal only the whitespace around it."""
    left, right = match.group(1), match.group(2)
    if "\n" in left or "\n" in right:
        return left + right
    if match.start() == 0 or match.end() == len(match.string):
        return ""
    if left and right:
        return " "
    if left and match.string[match.end()] in ".,;:!?)":
        return ""
    return left + right


def normalize_text(text: str) -> str:
    text = _REMOVABLE.sub(_drop, text)
    return _DECIMAL.sub(" point ", _CURRENCY.sub(_currency, text))
