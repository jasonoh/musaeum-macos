"""Speech synthesis (spec D1, D3): text → phonemes → Kokoro-82M int8 → 24 kHz s16 PCM.

Three behaviours here were measured rather than assumed (2026-10-15, M-series, CPU):
the model is +167 MB resident and 316 MB after its first sentence, loads in 0.3–0.4 s,
and runs at about 13× realtime — so it is loaded on use and dropped after five idle
minutes, and the first sentence of a session is the only slow one.

`kokoro-onnx` 0.6.1 batches input longer than its 510-phoneme limit itself (its
`_split_phonemes`, at punctuation then word boundaries), so there is no chunker here.
Neither of the two pinned models reports phoneme durations (`has_timings` is False),
which is why highlighting is per sentence.
"""

from __future__ import annotations

import base64
import threading
import time
from typing import Any, Callable, Optional

from . import models
from .errors import TtsError
from .lexicon import Entry, Lexicon, lexicon_version
from .normalize import normalize_text
from .phonemize import find_espeak, get_phonemizer

SAMPLE_RATE = 24_000
IDLE_SECONDS = 300
VOICES = ("af_heart", "af_bella", "bf_emma", "bm_george", "am_michael")
# Kokoro's own bounds. The app's 0.8–1.5 is a user-interface range, validated upstream.
SPEED_MIN, SPEED_MAX = 0.5, 2.0
_NOTHING = ("Nothing to synthesize", "No phonemes")


class EngineError(TtsError):
    """A refusal fit to show a person."""


def load_kokoro(model_dir: str) -> Any:
    from kokoro_onnx import Kokoro
    from kokoro_onnx.config import EspeakConfig

    models.verify(model_dir)
    paths = find_espeak()
    if paths is None:
        # `get_phonemizer` has already raised for this, but a loader is called on its own too.
        raise EngineError("the pronunciation data is missing — run scripts/build-espeak.sh")
    return Kokoro(
        f"{model_dir}/{models.MODEL_FILE}",
        f"{model_dir}/{models.VOICES_FILE}",
        espeak_config=EspeakConfig(lib_path=paths.lib, data_path=paths.share),
    )


def _silence(version: str) -> dict:
    return {"sample_rate": SAMPLE_RATE, "pcm": "", "duration_ms": 0, "lexicon_version": version}


class SpeechEngine:
    def __init__(
        self,
        *,
        loader: Callable[[str], Any] = load_kokoro,
        phonemizer: Callable[[], Any] = get_phonemizer,
        idle_seconds: float = IDLE_SECONDS,
        timer: Callable[..., Any] = threading.Timer,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._loader = loader
        self._get_phonemizer = phonemizer
        self._idle = idle_seconds
        self._timer_factory = timer
        self._clock = clock
        # Held for a whole synthesis, so the idle timer — which only ever *tries* the lock —
        # cannot drop the model under a call in flight (review focus 5).
        self._lock = threading.Lock()
        self._model: Any = None
        self._model_dir: Optional[str] = None
        self._timer: Any = None
        self._last_used = 0.0

    def _model_for(self, model_dir: str) -> Any:
        if self._model is not None and self._model_dir == model_dir:
            return self._model
        self._model = None
        try:
            self._model = self._loader(model_dir)
        except models.ModelProblem as exc:
            raise EngineError(str(exc)) from exc
        except TtsError:
            raise
        except Exception as exc:  # noqa: BLE001 — a load failure is a sentence, and the next call retries
            raise EngineError(f"The voice could not be loaded: {exc}") from exc
        self._model_dir = model_dir
        return self._model

    def _touch(self) -> None:
        self._last_used = self._clock()
        if self._timer is not None:
            self._timer.cancel()
        self._timer = self._timer_factory(self._idle, self.release_if_idle)
        self._timer.daemon = True
        self._timer.start()

    def release_if_idle(self) -> bool:
        if not self._lock.acquire(blocking=False):
            return False
        try:
            if self._model is None or self._clock() - self._last_used < self._idle:
                return False
            self._model = None
            self._model_dir = None
            return True
        finally:
            self._lock.release()

    def synthesize(self, *, model_dir: str, text: str, voice: str, speed: float, lexicon: list[Entry]) -> dict:
        if voice not in VOICES:
            raise EngineError(f"Unknown voice: {voice}")
        speed = min(max(float(speed), SPEED_MIN), SPEED_MAX)
        lang = "en-gb" if voice.startswith("b") else "en-us"
        with self._lock:
            phonemizer = self._get_phonemizer()
            phonemes, applied = Lexicon(lexicon, phonemizer, lang).phonemes(normalize_text(text))
            version = lexicon_version(applied)
            # Punctuation survives phonemizing (Kokoro's vocabulary has it) and the model voices it as
            # a breath or a click; a line with no letter in it has nothing to say.
            if not any(c.isalpha() for c in phonemes):
                return _silence(version)
            try:
                model = self._model_for(model_dir)
                try:
                    samples, rate = model.create(phonemes, voice=voice, speed=speed, lang=lang, is_phonemes=True)
                except ValueError as exc:
                    if any(marker in str(exc) for marker in _NOTHING):
                        return _silence(version)
                    raise
            finally:
                # Whatever happened, a resident model always has a timer behind it.
                if self._model is not None:
                    self._touch()
            pcm = (samples * 32767.0).clip(-32768, 32767).astype("<i2").tobytes()
            return {
                "sample_rate": int(rate),
                "pcm": base64.b64encode(pcm).decode("ascii"),
                "duration_ms": round(len(samples) / rate * 1000),
                "lexicon_version": version,
            }


_engine: Optional[SpeechEngine] = None
_engine_lock = threading.Lock()


def get_engine() -> SpeechEngine:
    global _engine
    with _engine_lock:
        if _engine is None:
            _engine = SpeechEngine()
        return _engine


def _entries(raw: Any) -> list[Entry]:
    out = []
    for item in raw or []:
        if isinstance(item, dict) and isinstance(item.get("word"), str) and isinstance(item.get("sounds_like"), str):
            out.append(Entry(item["word"], item["sounds_like"]))
    return out


def synthesize_rpc(params: dict) -> dict:
    """The RPC body. A refusal answers `{ "error": ... }`; a bug raises, like every other method."""
    try:
        return get_engine().synthesize(
            model_dir=params["model_dir"],
            text=params["text"],
            voice=params.get("voice", "af_heart"),
            speed=params.get("speed", 1.0),
            lexicon=_entries(params.get("lexicon")),
        )
    except TtsError as exc:
        return {"error": str(exc)}
