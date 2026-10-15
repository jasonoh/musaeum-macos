"""The pronunciation front end: the bundle is found, used, and refused clearly when missing."""

import shutil
from pathlib import Path

import pytest

from tts.errors import TtsError
from tts.phonemize import Phonemizer, PhonemizerUnavailable, find_espeak

needs_espeak = pytest.mark.skipif(
    find_espeak() is None, reason="build the espeak bundle first: ./scripts/build-espeak.sh"
)


def test_an_unavailable_phonemizer_is_a_tts_error():
    assert issubclass(PhonemizerUnavailable, TtsError)


def test_missing_bundle_is_a_clear_refusal_not_a_crash(tmp_path, monkeypatch):
    monkeypatch.setenv("MUSAEUM_ESPEAK_DIR", str(tmp_path))
    assert find_espeak() is None
    with pytest.raises(PhonemizerUnavailable, match="build-espeak"):
        Phonemizer()


@needs_espeak
def test_data_moved_aside_is_noticed_before_espeak_can_exit(tmp_path, monkeypatch):
    # The pip wheel's failure was espeak calling exit() on a missing phontab. The
    # check that keeps that out of this process is `find_espeak` insisting on the file.
    paths = find_espeak()
    bundle = Path(paths.lib).parents[1]
    shutil.copytree(bundle, tmp_path / "espeak")
    shutil.rmtree(tmp_path / "espeak" / "share" / "espeak-ng-data")
    monkeypatch.setenv("MUSAEUM_ESPEAK_DIR", str(tmp_path / "espeak"))
    assert find_espeak() is None


@needs_espeak
@pytest.mark.parametrize(
    "word, expected",
    [
        ("Hegel", "hˈɛdʒəl"),  # the mispronunciation the lexicon exists to fix: HEDGE-ul
        ("Kojève", "kˈoʊdʒv"),
        ("Okafor's", "ˈɑːkæfɚz"),
    ],
)
def test_the_bundled_library_reads_names(word, expected):
    assert Phonemizer().phonemes(word) == expected


@needs_espeak
def test_british_voices_get_british_phonemes():
    assert Phonemizer().phonemes("schedule", "en-gb") != Phonemizer().phonemes("schedule", "en-us")
