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


def normalize_text(text: str) -> str:
    return _DECIMAL.sub(" point ", _CURRENCY.sub(_currency, text))
