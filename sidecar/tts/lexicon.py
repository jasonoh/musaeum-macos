"""The pronunciation lexicon (spec D8): words a book spells that espeak-ng cannot read.

An entry is `{ word, sounds_like }` — what a person typed ("HAY-gul"), never IPA. The
phonemes are derived here, with the bundled espeak, so the library's file stays
human-readable and does not freeze a phonemizer version into it. The mechanism
(splice hand-written phonemes at the word boundary, phonemize the rest, hand Kokoro
the whole) was listened to on four voices on 2026-10-15 and judged correct and
natural; the *derivation from a respelling* is the substitution not yet listened to
(spec AC24).
"""

from __future__ import annotations

import hashlib
import json
import re
import weakref
from dataclasses import dataclass
from typing import Any, Optional

_STRESS_MARKS = "ˈˌ"
_SIBILANT = set("szʃʒ")  # a trailing "tʃ" / "dʒ" ends in ʃ / ʒ, so they are covered
_VOICELESS = set("ptkfθ")
# A part that begins with one of these attaches to the part before it, without a space.
_ATTACHES_LEFT = ",.;:!?…)"


@dataclass(frozen=True)
class Entry:
    word: str
    sounds_like: str


def possessive_suffix(phonemes: str) -> str:
    last = phonemes.rstrip()[-1:]
    if last in _SIBILANT:
        return "ɪz"
    if last in _VOICELESS:
        return "s"
    return "z"


# Cached per phonemizer *instance*, weakly: an `id()` key can alias a freed object's, and
# serve a dead Fake's phonemes to the real phonemizer. An object that cannot be weakly
# referenced is simply not cached.
_respelled: "weakref.WeakKeyDictionary[Any, dict[tuple[str, str], str]]" = weakref.WeakKeyDictionary()


def _parts(sounds_like: str) -> list[str]:
    return [p for p in re.split(r"[-\s]+", sounds_like.strip()) if p]


def respelling_to_phonemes(phonemizer: Any, sounds_like: str, lang: str = "en-us") -> str:
    """"HAY-gul" → phonemes. The part in CAPITALS keeps its stress; with none, the first does."""
    try:
        cache = _respelled.setdefault(phonemizer, {})
    except TypeError:
        cache = None
    if cache is not None and (lang, sounds_like) in cache:
        return cache[(lang, sounds_like)]
    parts = _parts(sounds_like)
    if not parts:
        raise ValueError("a respelling cannot be empty")
    stressed = next((i for i, p in enumerate(parts) if p.isupper()), 0)
    out = []
    for i, part in enumerate(parts):
        ph = phonemizer.phonemes(part.lower(), lang)
        if i != stressed:
            ph = "".join(c for c in ph if c not in _STRESS_MARKS)
        out.append(ph)
    result = "".join(out)
    if cache is not None:
        cache[(lang, sounds_like)] = result
    return result


def _join(parts: list[str]) -> str:
    out = ""
    for part in parts:
        part = part.strip()
        if not part:
            continue
        out += part if (not out or part[0] in _ATTACHES_LEFT) else " " + part
    return out


class Lexicon:
    def __init__(self, entries: list[Entry], phonemizer: Any, lang: str = "en-us") -> None:
        self._ph = phonemizer
        self._lang = lang
        self._by_word: dict[str, Entry] = {}
        for entry in entries:
            word = entry.word.strip()
            if word and _parts(entry.sounds_like):
                self._by_word[word] = Entry(word, entry.sounds_like)  # a later duplicate wins
        self._pattern: Optional[re.Pattern[str]] = None
        if self._by_word:
            # Longest first, so `Hegelian` is never half-eaten by `Hegel`; `(?!\w)` is what
            # keeps `Hegelian` from matching `Hegel` at all; the optional 's is the possessive.
            alts = "|".join(re.escape(w) for w in sorted(self._by_word, key=len, reverse=True))
            self._pattern = re.compile(rf"(?<!\w)({alts})(?:['’]s)?(?!\w)")

    def phonemes(self, text: str) -> tuple[str, list[Entry]]:
        applied: dict[str, Entry] = {}
        parts: list[str] = []
        pos = 0
        if self._pattern:
            for m in self._pattern.finditer(text):
                before = text[pos : m.start()]
                if before.strip():
                    parts.append(self._ph.phonemes(before, self._lang))
                entry = self._by_word[m.group(1)]
                ph = respelling_to_phonemes(self._ph, entry.sounds_like, self._lang)
                if m.group(0) != m.group(1):
                    ph += possessive_suffix(ph)
                parts.append(ph)
                applied[entry.word] = entry
                pos = m.end()
        tail = text[pos:]
        if tail.strip():
            parts.append(self._ph.phonemes(tail, self._lang))
        return _join(parts), list(applied.values())


def lexicon_version(applied: list[Entry]) -> str:
    """A stable hash of the entries that *applied* — what a rendered file's stamp will need."""
    ordered = sorted((e.word, e.sounds_like) for e in applied)
    return hashlib.sha256(json.dumps(ordered, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]
