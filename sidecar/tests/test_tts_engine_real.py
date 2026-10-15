"""The engine against the real int8 model and the real bundle — the properties a fake cannot show.

Skipped, loudly, without the inputs: ./scripts/build-espeak.sh builds the bundle, and
MUSAEUM_TTS_MODELS must name a directory holding the two pinned model files.
"""

import base64
import os
import time

import pytest

from tts import models
from tts.engine import VOICES, SpeechEngine
from tts.lexicon import Entry
from tts.phonemize import find_espeak

MODEL_DIR = os.environ.get("MUSAEUM_TTS_MODELS", "")
READY = bool(MODEL_DIR) and models.model_status(MODEL_DIR)["ready"] and find_espeak() is not None
pytestmark = pytest.mark.skipif(
    not READY, reason="needs the espeak bundle and MUSAEUM_TTS_MODELS=<dir with the two pinned model files>"
)

SENTENCE = "The key was heavier than he remembered, and warm, as though someone had only just let go of it."


@pytest.fixture(scope="module")
def eng():
    return SpeechEngine()


def seconds(out):
    return len(base64.b64decode(out["pcm"])) / 2 / out["sample_rate"]


@pytest.mark.parametrize("voice", VOICES)
def test_every_voice_speaks_a_plausible_sentence(eng, voice):
    out = eng.synthesize(model_dir=MODEL_DIR, text=SENTENCE, voice=voice, speed=1.0, lexicon=[])
    assert out["sample_rate"] == 24000
    assert 3.0 < seconds(out) < 12.0  # eighteen words
    assert abs(seconds(out) * 1000 - out["duration_ms"]) < 5


def test_a_repeat_call_is_byte_identical(eng):
    a = eng.synthesize(model_dir=MODEL_DIR, text=SENTENCE, voice="af_heart", speed=1.0, lexicon=[])
    b = eng.synthesize(model_dir=MODEL_DIR, text=SENTENCE, voice="af_heart", speed=1.0, lexicon=[])
    assert a["pcm"] == b["pcm"]


def test_the_lexicon_changes_the_audio(eng):
    plain = eng.synthesize(model_dir=MODEL_DIR, text="Hegel wrote.", voice="af_heart", speed=1.0, lexicon=[])
    fixed = eng.synthesize(
        model_dir=MODEL_DIR, text="Hegel wrote.", voice="af_heart", speed=1.0, lexicon=[Entry("Hegel", "HAY-gul")]
    )
    assert plain["pcm"] != fixed["pcm"] and plain["lexicon_version"] != fixed["lexicon_version"]


def test_a_very_long_single_sentence_is_audio_not_a_crash(eng):
    # ~1,200 characters with no full stop: past the 510-phoneme limit, so kokoro-onnx must batch it.
    clause = "and then the committee, having considered the matter at length, resolved to defer it "
    text = ("It was resolved that " + clause * 14).strip() + "."
    assert len(text) > 1100
    out = eng.synthesize(model_dir=MODEL_DIR, text=text, voice="af_heart", speed=1.0, lexicon=[])
    assert seconds(out) > 20


@pytest.mark.parametrize("text", ["†", "***", "[12]", "• •", "😀", "...", "—", "?", "“”", "( )"])
def test_text_with_nothing_to_say_is_silence(eng, text):
    out = eng.synthesize(model_dir=MODEL_DIR, text=text, voice="af_heart", speed=1.0, lexicon=[])
    assert out["pcm"] == "" and out["duration_ms"] == 0


def test_the_first_sentence_after_loading_is_fast_enough(eng):
    eng._model = None  # cold
    t = time.time()
    eng.synthesize(model_dir=MODEL_DIR, text="Hello there.", voice="af_heart", speed=1.0, lexicon=[])
    cold = time.time() - t
    t = time.time()
    eng.synthesize(model_dir=MODEL_DIR, text="Hello there.", voice="af_heart", speed=1.0, lexicon=[])
    warm = time.time() - t
    print(f"cold {cold:.2f}s warm {warm:.2f}s")  # recorded in the plan annex (spec AC21's engine half)
    assert cold < 2.0 and warm < 1.0


@pytest.mark.parametrize("text", ["Hi.", "A", "a.", "I", "O"])
def test_a_single_real_word_is_still_spoken(eng, text):
    out = eng.synthesize(model_dir=MODEL_DIR, text=text, voice="af_heart", speed=1.0, lexicon=[])
    assert out["duration_ms"] > 0 and out["pcm"] != ""
