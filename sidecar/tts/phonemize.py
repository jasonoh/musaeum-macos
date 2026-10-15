"""The pronunciation front end (spec D2): espeak-ng, the bundle we build, and Kokoro's own tokenizer.

`find_espeak` resolves the bundle the way `reflow/vision.find_helper` resolves the
Swift helper: one relative path that a dev tree and a packaged app agree on.
`sidecar/tts/phonemize.py` is `Contents/Resources/sidecar/tts/phonemize.py` in a
bundle, so `parents[2]` is `Contents/Resources` there and the repo root in
development, and `helpers/bin/espeak` sits under both. `MUSAEUM_ESPEAK_DIR`
overrides it for an experiment or a test.

The pip `espeakng-loader` wheel is deliberately *not* used: its binary has a build
machine's data path compiled in (see `scripts/build-espeak.sh`).
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .errors import TtsError

_REBUILD = "the pronunciation data is missing — run scripts/build-espeak.sh"


class PhonemizerUnavailable(TtsError):
    """No usable espeak bundle."""


@dataclass(frozen=True)
class EspeakPaths:
    lib: str
    #: The directory that *contains* `espeak-ng-data` — `espeak_Initialize`'s `path`.
    share: str


def find_espeak() -> Optional[EspeakPaths]:
    env = os.environ.get("MUSAEUM_ESPEAK_DIR")
    base = Path(env) if env else Path(__file__).resolve().parents[2] / "helpers" / "bin" / "espeak"
    lib = base / "lib" / "libespeak-ng.dylib"
    share = base / "share"
    # `phontab` is the file espeak exits the process over when it cannot read it, so
    # its presence is checked here, where a refusal is cheap, not discovered inside C.
    if lib.is_file() and (share / "espeak-ng-data" / "phontab").is_file():
        return EspeakPaths(str(lib), str(share))
    return None


class Phonemizer:
    def __init__(self, paths: Optional[EspeakPaths] = None) -> None:
        paths = paths or find_espeak()
        if paths is None:
            raise PhonemizerUnavailable(_REBUILD)
        from kokoro_onnx.config import EspeakConfig
        from kokoro_onnx.tokenizer import Tokenizer

        self.paths = paths
        self._tokenizer = Tokenizer(EspeakConfig(lib_path=paths.lib, data_path=paths.share))

    def phonemes(self, text: str, lang: str = "en-us") -> str:
        """IPA for `text`, already filtered to what Kokoro's vocabulary holds."""
        return self._tokenizer.phonemize(text, lang)


_lock = threading.Lock()
_shared: Optional[Phonemizer] = None


def get_phonemizer() -> Phonemizer:
    """The process-wide instance: espeak-ng holds global state, so one is the right number."""
    global _shared
    with _lock:
        if _shared is None:
            _shared = Phonemizer()
        return _shared
