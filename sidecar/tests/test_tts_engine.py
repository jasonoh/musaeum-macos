"""The engine's contract, decided without a model: shapes, limits, lifecycle, and the quiet failures."""

import base64
import threading
import time

import numpy as np
import pytest

from tts import engine
from tts.engine import EngineError, SpeechEngine, synthesize_rpc
from tts.lexicon import Entry


class FakePhonemizer:
    def phonemes(self, text, lang="en-us"):
        return text.strip().upper()


class FakeModel:
    def __init__(self):
        self.calls = []

    def create(self, phonemes, *, voice, speed, lang, is_phonemes):
        self.calls.append({"phonemes": phonemes, "voice": voice, "speed": speed, "lang": lang, "is_phonemes": is_phonemes})
        return np.full(2400, 0.5, dtype=np.float32), 24000  # 100 ms


class FakeTimer:
    instances = []

    def __init__(self, interval, fn):
        self.interval, self.fn, self.started, self.cancelled, self.daemon = interval, fn, False, False, False
        FakeTimer.instances.append(self)

    def start(self):
        self.started = True

    def cancel(self):
        self.cancelled = True


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


@pytest.fixture
def parts():
    FakeTimer.instances = []
    model, clock, loads = FakeModel(), Clock(), []

    def loader(model_dir):
        loads.append(model_dir)
        return model

    eng = SpeechEngine(loader=loader, phonemizer=FakePhonemizer, timer=FakeTimer, clock=clock)
    return eng, model, clock, loads


def say(eng, **kw):
    args = dict(model_dir="/m", text="Hello there.", voice="af_heart", speed=1.0, lexicon=[])
    args.update(kw)
    return eng.synthesize(**args)


def test_the_result_is_mono_s16_pcm_at_24khz(parts):
    eng, *_ = parts
    out = say(eng)
    pcm = base64.b64decode(out["pcm"])
    assert out["sample_rate"] == 24000 and out["duration_ms"] == 100
    assert len(pcm) == 2400 * 2
    assert np.frombuffer(pcm, dtype="<i2")[0] == int(0.5 * 32767)


def test_a_repeat_call_is_byte_identical(parts):
    eng, *_ = parts
    assert say(eng)["pcm"] == say(eng)["pcm"]


def test_an_unknown_voice_is_refused(parts):
    eng, *_ = parts
    with pytest.raises(EngineError, match="voice"):
        say(eng, voice="af_sky")


def test_speed_is_clamped_to_kokoros_own_bounds(parts):
    eng, model, *_ = parts
    say(eng, speed=5.0)
    say(eng, speed=0.1)
    assert [c["speed"] for c in model.calls] == [2.0, 0.5]


def test_british_voices_ask_for_british_phonemes(parts):
    eng, model, *_ = parts
    say(eng, voice="bf_emma")
    say(eng, voice="am_michael")
    assert [c["lang"] for c in model.calls] == ["en-gb", "en-us"]
    assert all(c["is_phonemes"] for c in model.calls)


def test_the_text_is_normalised_then_the_lexicon_is_applied(parts):
    eng, model, *_ = parts
    out = say(eng, text="Hegel paid $2.1 billion.", lexicon=[Entry("Hegel", "hay-gul")])
    assert model.calls[0]["phonemes"] == "HAYGUL PAID 2 POINT 1 BILLION DOLLARS."
    assert out["lexicon_version"] != say(eng, text="Hegel paid $2.1 billion.")["lexicon_version"]


def test_text_with_nothing_to_say_is_silence_not_an_error(parts):
    eng, model, *_ = parts
    eng._get_phonemizer = lambda: type("E", (), {"phonemes": lambda s, t, l="en-us": ""})()
    out = say(eng, text="†")
    assert out["pcm"] == "" and out["duration_ms"] == 0
    assert model.calls == []  # the model was never asked


def test_a_model_that_rejects_unspeakable_phonemes_is_also_silence(parts):
    eng, model, *_ = parts

    def boom(*a, **k):
        raise ValueError("Nothing to synthesize, '†' produced no phonemes")

    model.create = boom
    out = say(eng, text="†")
    assert out["pcm"] == "" and out["duration_ms"] == 0


def test_any_other_model_error_is_not_swallowed(parts):
    eng, model, *_ = parts

    def boom(*a, **k):
        raise ValueError("Speed should be between 0.5 and 2.0")

    model.create = boom
    with pytest.raises(ValueError):
        say(eng)


def test_the_model_loads_once_and_a_timer_is_armed_each_call(parts):
    eng, _, _, loads = parts
    say(eng)
    say(eng)
    assert loads == ["/m"]
    assert FakeTimer.instances[0].cancelled and FakeTimer.instances[-1].started
    assert FakeTimer.instances[-1].interval == 300 and FakeTimer.instances[-1].daemon is True
    assert FakeTimer.instances[-1].fn == eng.release_if_idle  # the timer really calls the release


def test_the_model_is_released_after_the_idle_period_and_loads_again(parts):
    eng, _, clock, loads = parts
    say(eng)
    clock.now += 299
    assert eng.release_if_idle() is False
    clock.now += 2
    assert eng.release_if_idle() is True
    say(eng)
    assert loads == ["/m", "/m"]


def test_release_never_lands_under_a_running_synthesis(parts):
    eng, model, clock, _ = parts
    started, finish = threading.Event(), threading.Event()
    real = model.create

    def slow(*a, **k):
        started.set()
        finish.wait(5)
        return real(*a, **k)

    model.create = slow
    t = threading.Thread(target=lambda: say(eng))
    t.start()
    assert started.wait(5)
    clock.now += 10_000  # long past idle
    # The idle timer's call must come back *while the synthesis is still running*: it only tries the lock.
    # Run it on its own thread so a blocking acquire shows up as "has not returned", not as a hung test.
    result, returned = [], threading.Event()

    def timer_fires():
        result.append(eng.release_if_idle())
        returned.set()

    r = threading.Thread(target=timer_fires)
    r.start()
    came_back = returned.wait(1)  # the worker is still blocked on `finish`
    finish.set()
    t.join(5)
    r.join(5)
    assert came_back, "release_if_idle waited for the running synthesis instead of declining"
    assert result == [False]
    assert eng._model is not None


def test_a_failed_load_is_a_sentence_and_the_next_call_retries(parts):
    _, model, clock, _ = parts
    attempts = []

    def flaky(model_dir):
        attempts.append(1)
        if len(attempts) == 1:
            raise FileNotFoundError("gone")
        return model

    eng = SpeechEngine(loader=flaky, phonemizer=FakePhonemizer, timer=FakeTimer, clock=clock)
    with pytest.raises(EngineError, match="could not be loaded"):
        say(eng)
    assert say(eng)["duration_ms"] == 100 and len(attempts) == 2


def test_the_rpc_turns_a_refusal_into_an_error_member_and_a_bug_into_a_raise(monkeypatch):
    class Boom:
        def synthesize(self, **kw):
            raise EngineError("The voice is not downloaded yet")

    monkeypatch.setattr(engine, "get_engine", lambda: Boom())
    assert synthesize_rpc({"model_dir": "/m", "text": "hi"}) == {"error": "The voice is not downloaded yet"}

    class Bug:
        def synthesize(self, **kw):
            raise KeyError("oops")

    monkeypatch.setattr(engine, "get_engine", lambda: Bug())
    with pytest.raises(KeyError):
        synthesize_rpc({"model_dir": "/m", "text": "hi"})


def test_the_rpc_reads_snake_case_lexicon_entries_and_skips_malformed_ones(monkeypatch):
    seen = {}

    class Spy:
        def synthesize(self, **kw):
            seen.update(kw)
            return {"ok": True}

    monkeypatch.setattr(engine, "get_engine", lambda: Spy())
    synthesize_rpc(
        {
            "model_dir": "/m",
            "text": "hi",
            "lexicon": [{"word": "Hegel", "sounds_like": "hay-gul"}, "junk", {"word": 3}, {"word": "X"}],
        }
    )
    assert seen["lexicon"] == [Entry("Hegel", "hay-gul")]
    assert seen["voice"] == "af_heart" and seen["speed"] == 1.0


@pytest.mark.parametrize("text", ["...", "\u2014", "?", "\u201c\u201d", "( )"])
def test_punctuation_only_text_is_silence_and_the_model_is_not_asked(parts, text):
    eng, model, *_ = parts
    eng._get_phonemizer = lambda: type("P", (), {"phonemes": lambda s, t, l="en-us": t})()
    out = say(eng, text=text)
    assert out["pcm"] == "" and out["duration_ms"] == 0
    assert model.calls == []


@pytest.mark.parametrize("text", ["Hi.", "A", "a.", "I", "O"])
def test_short_real_words_are_not_mistaken_for_silence(parts, text):
    eng, model, *_ = parts
    assert say(eng, text=text)["duration_ms"] == 100
    assert len(model.calls) == 1


def test_a_silent_call_after_a_load_still_leaves_a_timer_armed(parts):
    eng, model, *_ = parts
    say(eng)  # loads
    before = len(FakeTimer.instances)
    eng._get_phonemizer = lambda: type("P", (), {"phonemes": lambda s, t, l="en-us": ""})()
    say(eng, text="\u2020")
    assert len(FakeTimer.instances) == before  # silence never touches the model, the earlier timer stands
    assert FakeTimer.instances[-1].started and not FakeTimer.instances[-1].cancelled


def test_a_model_that_says_nothing_on_first_use_is_still_released(parts):
    eng, model, *_ = parts

    def nothing(*a, **k):
        raise ValueError("Nothing to synthesize")

    model.create = nothing
    say(eng)
    assert eng._model is not None
    assert FakeTimer.instances[-1].started and not FakeTimer.instances[-1].cancelled


def test_a_raising_create_still_arms_the_timer(parts):
    eng, model, *_ = parts

    def boom(*a, **k):
        raise ValueError("Speed should be between 0.5 and 2.0")

    model.create = boom
    with pytest.raises(ValueError):
        say(eng)
    assert eng._model is not None
    assert FakeTimer.instances[-1].started and not FakeTimer.instances[-1].cancelled


def test_a_real_timer_releases_the_model_after_the_idle_period():
    model = FakeModel()
    eng = SpeechEngine(loader=lambda d: model, phonemizer=FakePhonemizer, idle_seconds=0.05)
    say(eng)
    assert eng._model is not None
    deadline = time.monotonic() + 5
    while eng._model is not None and time.monotonic() < deadline:
        time.sleep(0.01)  # bounded poll; the timer thread does the release
    assert eng._model is None
