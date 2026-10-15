"""The pronunciation lexicon: whole-word matching, possessives, respellings, and hostile entries."""

import pytest

from tts.lexicon import Entry, Lexicon, lexicon_version, possessive_suffix, respelling_to_phonemes
from tts.phonemize import find_espeak


class Fake:
    """Deterministic and visible: the 'phonemes' of text are its uppercase."""

    def phonemes(self, text, lang="en-us"):
        return text.strip().upper()


def run(entries, text):
    return Lexicon(entries, Fake()).phonemes(text)


def test_a_matched_word_is_spliced_in_and_the_rest_is_phonemized():
    ph, applied = run([Entry("Hegel", "hay-gul")], "What Hegel calls reason")
    assert ph == "WHAT HAYGUL CALLS REASON"
    assert applied == [Entry("Hegel", "hay-gul")]


def test_punctuation_attaches_to_the_word_before_it():
    ph, _ = run([Entry("Kojève", "ko-ZHEV")], "a point Kojève, reading")
    assert ph == "A POINT KOZHEV, READING"


def test_matching_is_whole_word_and_case_sensitive():
    ph, applied = run([Entry("Hegel", "hay-gul")], "Hegelian thought, and hegel, and Neo-Hegel")
    assert "HEGELIAN" in ph  # not read as Hegel + ian
    assert "HEGEL," in ph  # lower-case "hegel" is plain text, not the name
    assert ph.count("HAYGUL") == 1  # only the "Hegel" in "Neo-Hegel" was replaced
    assert [e.word for e in applied] == ["Hegel"]


@pytest.mark.parametrize("apostrophe", ["'", "’"])
def test_a_possessive_uses_the_base_words_entry(apostrophe):
    ph, applied = run([Entry("Okafor", "oh-KAH-for")], f"Dr. Okafor{apostrophe}s team")
    assert ph.startswith("DR.")
    assert "OHKAHFORz" in ph  # the base entry, then the possessive sound
    assert len(applied) == 1


@pytest.mark.parametrize(
    "phonemes, expected",
    [
        ("hˈeɪɡəl", "z"),  # after a vowel
        ("ɑːkæfɚ", "z"),
        ("kˈæt", "s"),  # after a voiceless consonant
        ("tˈɒf", "s"),
        ("bˈʌs", "ɪz"),  # after a sibilant
        ("pˈɛtʃ", "ɪz"),
        ("mˈɪstɪʒ", "ɪz"),
    ],
)
def test_possessive_suffix_follows_the_last_sound(phonemes, expected):
    assert possessive_suffix(phonemes) == expected


def test_hostile_and_sloppy_entries_never_raise():
    entries = [
        Entry("C++", "see plus plus"),  # regex metacharacters
        Entry("", "nothing"),  # empty word
        Entry("Ghost", ""),  # empty respelling
        Entry("Bob", "bahb"),
        Entry("Bob", "bobb"),  # duplicate: the later one wins
        Entry("(", "x"),  # an unbalanced paren must be escaped, not compiled
    ]
    ph, applied = run(entries, "C++ and Bob and Ghost")
    assert "SEEPLUSPLUS" in ph
    assert "BOBB" in ph and "BAHB" not in ph
    assert "GHOST" in ph
    assert {e.word for e in applied} == {"C++", "Bob"}


def test_no_entries_is_the_plain_phonemizer():
    assert run([], "Just  this") == ("JUST  THIS".strip(), [])


def test_version_depends_on_what_applied_not_on_what_was_listed():
    a, b = Entry("Hegel", "hay-gul"), Entry("Okafor", "oh-KAH-for")
    assert lexicon_version([a, b]) == lexicon_version([b, a])
    assert lexicon_version([a]) != lexicon_version([a, b])
    assert lexicon_version([Entry("Hegel", "hay-gull")]) != lexicon_version([a])
    assert len(lexicon_version([])) == 16


needs_espeak = pytest.mark.skipif(find_espeak() is None, reason="./scripts/build-espeak.sh")


@needs_espeak
def test_a_respelling_puts_the_stress_on_the_capitalised_part():
    from tts.phonemize import get_phonemizer

    p = get_phonemizer()
    first = respelling_to_phonemes(p, "HAY-gul")
    second = respelling_to_phonemes(p, "hay-GUL")
    assert first.count("ˈ") == 1 and second.count("ˈ") == 1
    assert first.index("ˈ") < second.index("ˈ")  # stress moved to the later syllable
    assert first.startswith("h")


@needs_espeak
def test_a_lower_case_respelling_stresses_the_first_part():
    from tts.phonemize import get_phonemizer

    ph = respelling_to_phonemes(get_phonemizer(), "hay-gul")
    assert ph.count("ˈ") == 1 and ph.index("ˈ") == 1


@needs_espeak
def test_an_empty_respelling_is_rejected_clearly():
    from tts.phonemize import get_phonemizer

    with pytest.raises(ValueError, match="empty"):
        respelling_to_phonemes(get_phonemizer(), "  -  ")


def test_a_separator_only_respelling_is_ignored_not_raised():
    ph, applied = run([Entry("Hegel", "---"), Entry("Kant", " - ")], "Hegel and Kant")
    assert ph == "HEGEL AND KANT"
    assert applied == []


def test_the_respelling_cache_never_serves_a_freed_phonemizers_value():
    import gc

    from tts import lexicon

    class Other:
        def phonemes(self, text, lang="en-us"):
            return text.lower()

    gc.collect()
    before = len(lexicon._respelled)
    fake = Fake()
    assert respelling_to_phonemes(fake, "hay-gul") == "HAYGUL"
    del fake
    gc.collect()
    assert len(lexicon._respelled) == before  # nothing outlives the phonemizer it belongs to
    other = Other()
    assert respelling_to_phonemes(other, "hay-gul") == "haygul"
    assert respelling_to_phonemes(Fake(), "hay-gul") == "HAYGUL"


def test_the_longer_entry_wins_over_its_prefix():
    ph, applied = run([Entry("Hegel", "hay-gul"), Entry("Hegel Kant", "kahnt")], "Hegel Kant wrote")
    assert ph == "KAHNT WROTE"
    assert [e.word for e in applied] == ["Hegel Kant"]
