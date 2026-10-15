"""espeak reads `3.5 million` as "three. five million"; these rewrite what it gets wrong.

Dates (`3/4/2021`) and clock times (`5:30 p.m.`) are known gaps, listed in the plan's
Review Focus and the spec, and are deliberately passed through untouched.
"""

import pytest

from tts.normalize import normalize_text


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("roughly 3.5 million patients", "roughly 3 point 5 million patients"),
        ("Version 2.0 shipped", "Version 2 point 0 shipped"),
        ("Chapter 3.5 Methods", "Chapter 3 point 5 Methods"),
        ("It cost $2.1 billion.", "It cost 2 point 1 billion dollars."),
        ("It cost $4.50 today", "It cost 4 dollars and 50 cents today"),
        ("It cost $4.05 today", "It cost 4 dollars and 5 cents today"),
        ("It cost $1 today", "It cost 1 dollar today"),
        ("It cost $12 today", "It cost 12 dollars today"),
        ("It cost $1,250 today", "It cost 1250 dollars today"),
        ("It cost $5 million", "It cost 5 million dollars"),
        ("She paid $5, then left", "She paid 5 dollars, then left"),
    ],
)
def test_numbers_and_amounts_become_words(raw, expected):
    assert normalize_text(raw) == expected


@pytest.mark.parametrize(
    "untouched",
    [
        "In 1987. The trial began.",  # a period after a number is a sentence end, not a decimal
        "See Chapter 9. Next, the results.",
        "1,200 patients were enrolled",
        "She said no. He left.",
        "The meeting is on 3/4/2021 at 5:30 p.m.",  # known gaps, recorded not hidden
        "",
    ],
)
def test_everything_else_passes_through(untouched):
    assert normalize_text(untouched) == untouched


@pytest.mark.parametrize("raw", ["***", "* * *", "*", "[12]", "[1,2]", "[1, 2]", "[3-5]", "[3–5]", "\U0001F600", "❤️", "\U0001F468‍\U0001F469‍\U0001F467", "\U0001F44D\U0001F3FD"])
def test_nothing_to_say_becomes_empty(raw):
    assert normalize_text(raw) == ""


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("Text.[12] More", "Text. More"),
        ("Text [12] more", "Text more"),
        ("Text [1, 2], more", "Text, more"),
        ("claim[3–5] holds", "claim holds"),
        ("It ended.\n\n* * *\n\nThen it began.", "It ended.\n\n\n\nThen it began."),
        ("a word* here", "a word here"),
        ("Well done \U0001F600 friend", "Well done friend"),
        ("Hi\U0001F44B️ there", "Hi there"),
    ],
)
def test_removals_heal_the_whitespace_they_leave(raw, expected):
    assert normalize_text(raw) == expected


@pytest.mark.parametrize(
    "untouched",
    [
        "As he said [sic] here",
        "Per [Hegel] and [Hegel, 1807]",
        "[12 monkeys]",
        "1,200 patients were enrolled",
        "She paid 5 x 3 for it",
        "Kojève read Hegel — “quoted” – café naïve †",
        "Done   with  odd   spacing",
    ],
)
def test_removals_leave_other_text_byte_identical(untouched):
    assert normalize_text(untouched) == untouched
