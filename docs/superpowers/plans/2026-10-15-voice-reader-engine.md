# Voice reader — slices 1a, 1b, 1c (the engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local, offline speech engine behind one sidecar RPC (`tts_synthesize`) and a thin main-process bridge, with espeak-ng built and bundled by us, so that slice 2 (the reader) and slice 3 (the lexicon UI) have something to call.

**Architecture:** `sidecar/tts/` is a new Python package: text normalization → a pronunciation lexicon → espeak-ng phonemes → Kokoro-82M int8 → 24 kHz PCM. It runs on its own single-thread lane, loads the model on use and drops it after five idle minutes. espeak-ng is built from a pinned source release into `helpers/bin/espeak/` and rides the existing `helpers/bin` `extraResources` entry. `electron/main/services/tts.ts` validates and forwards, `ipc/tts.ts` is a thin `handle()` wrapper, and model download progress is a new broadcast event.

**Tech Stack:** Python 3.12 (`kokoro-onnx==0.6.1`, `onnxruntime==1.31.0`), CMake (espeak-ng 1.52.0), TypeScript/Electron main, vitest, pytest.

**Spec:** `docs/superpowers/specs/2026-10-15-voice-reader-design.md` (D1–D10, AC1–AC11). This plan **amends the spec in five places** it found by building (Task 12 applies them): the espeak data path is a run-time argument and nothing is baked in (D2), the bundle is 2.3 MB with English only (AC4), RPC members are snake_case (D3), `kokoro-onnx` already batches long input so the engine needs no chunker (D3), and a text-normalization step is added because espeak reads `3.5 million` as "three. five million" (new D3b). Slice 1b is split into **1b (sidecar)** and **1c (main bridge)** because the honest file count was 14, over the 10-file bound.

## Global Constraints

- Model: `kokoro-v1.0.int8.onnx`, **92,361,271 bytes**, sha256 `6e742170d309016e5891a994e1ce1559c702a2ccd0075e67ef7157974f6406cb`; voices file `voices-v1.0.bin`, **28,214,398 bytes**, sha256 `bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d`; both from `https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/`, stored under `userData/tts-models/`, never in the DMG.
- Voices: exactly `af_heart`, `af_bella`, `bf_emma`, `bm_george`, `am_michael`. Default `af_heart`. Speed 0.8–1.5, step 0.1, default 1.0 (the sidecar itself accepts Kokoro's 0.5–2.0).
- Output: mono, signed 16-bit little-endian, **24,000 Hz**. The model is dropped after **300 s** idle. Speech runs on its **own single-thread executor**, never the shared four.
- Pins in `sidecar/requirements.txt` are exact `==`, top-level packages only; this plan adds **exactly two** (`kokoro-onnx`, `onnxruntime`). Our code must not `import numpy` directly (it arrives transitively), so no third pin is needed.
- espeak-ng 1.52.0 source tarball sha256 `bb4338102ff3b49a81423da8a1a158b420124b055b60fa76cfb4b18677130a23`. The bundle ships **only** `en_dict` among the dictionaries. The pip `espeakng-loader` library is **never** loaded by our code.
- No SQLite migration, no `metadata.json`/`catalog.json` change, no new `musaeum://` host, no wire change (`docs/rest-api.md` untouched), no CSP change, **no edit to `vendor/`** (invariant 11).
- Business logic lives in `electron/main/services/`; IPC handlers are thin wrappers through `handle()` (invariant 8). No `any`; interfaces in `src/types/`.
- Prose in `.md` files is **not hard-wrapped** (one line per paragraph or bullet).
- Commits: end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. **Run `/verify` immediately before any commit that touches source** (not docs-only or tests-only commits), per the repo rule.
- Commands: pytest is `sidecar/.venv/bin/python -m pytest <path> -q`; the main-process suite is `npm test` (`npm test -- <file>` for one file); gates are `npm run typecheck && npm run lint && npm test` and the full pytest run. **Record the baseline counts before Task 1** (`npm test` and `pytest sidecar/tests -q`) — every later "no regression" claim is against them.
- Real-model and real-espeak tests **skip, loudly, when their inputs are absent** (the layout helper's precedent): the espeak bundle is built by `scripts/build-espeak.sh`; the model files are found through `MUSAEUM_TTS_MODELS` (a directory holding the two pinned files — `~/Downloads/musaeum-tts-bakeoff/models` has them today).

## Review Focus

The spec's acceptance criteria say what the engine must do; these are the inputs it will actually meet that no criterion names, most likely first. Each has a test in the task that owns the code.

1. **A number or amount in the text** (`3.5 million`, `$2.1 billion`, `$4.50`) — espeak reads a decimal point as a sentence end, so it says "three. five million". A reasonable listener expects "three point five million". Known and **not** handled, recorded as gaps rather than hidden: dates (`3/4/2021`), clock times (`5:30 p.m.`). → Task 5.
2. **Text with nothing to say** (`†`, `***`, a lone footnote marker `[12]` stripped to nothing, emoji) — the phonemizer drops what the model does not know, and `kokoro-onnx` then raises. The listener expects silence for that sentence and the book to carry on, not an error that stops playback. → Task 8.
3. **One very long sentence** (a 1,200-character run-on, a legal clause) — past 510 phonemes the model cannot take it whole. `kokoro-onnx` batches it; the expectation is audio, not a crash, and a plausible duration. → Task 8.
4. **A lexicon entry that is hostile or sloppy** (`C++`, an empty word, a duplicate, regex metacharacters, a word that is a prefix of another like `Hegel` and `Hegelian`) — the listener expects the entries that make sense to work and the rest to be ignored, never an exception and never `Hegelian` read as `Hegel`+`ian`. → Task 6.
5. **The idle timer firing while a sentence is being synthesized** — the model must not be released under a running call, or the next sentence fails for no visible reason. → Task 8.
6. **A download killed halfway, or a corrupted file already on disk** — the next press of Listen must recover, not wedge on a stale `.part` or trust a bad model. → Task 7.

---

## File structure

**Create**
- `scripts/build-espeak.sh` — builds and prunes the bundle into `helpers/bin/espeak/`.
- `sidecar/tts/__init__.py` — empty; makes the package.
- `sidecar/tts/errors.py` — `TtsError`, the one base class the RPC turns into `{ "error": ... }`.
- `sidecar/tts/phonemize.py` — finds the bundle; `Phonemizer`, the espeak front end.
- `sidecar/tts/normalize.py` — decimals and dollar amounts to words.
- `sidecar/tts/lexicon.py` — `Entry`, `Lexicon`, `respelling_to_phonemes`, `possessive_suffix`, `lexicon_version`.
- `sidecar/tts/models.py` — the pinned files, status, verify, download, cancel.
- `sidecar/tts/engine.py` — `SpeechEngine`, `synthesize_rpc`.
- `sidecar/tests/test_tts_phonemize.py`, `test_tts_normalize.py`, `test_tts_lexicon.py`, `test_tts_models.py`, `test_tts_engine.py`, `test_tts_engine_real.py`, `test_tts_lane.py`.
- `src/types/tts.types.ts` and `src/types/tts.types.test.ts`.
- `electron/main/services/tts.ts` and `tts.test.ts`.
- `electron/main/ipc/tts.ts`.
- `docs/invariants/voice-reader.md`.

**Modify**
- `sidecar/requirements.txt` (two pins), `sidecar/main.py` (imports, four methods, the lane), `.gitignore` (the build scratch), `electron-builder.yml` (a comment only), `test/invariants.test.ts` (one case), `src/types/api.types.ts` (the `tts` group, the event), `electron/preload/index.ts`, `electron/main/index.ts` (one registration), `CLAUDE.md` (one routing row and the dev quickstart), `docs/data-contracts.md`, `docs/invariants/files-and-deletion.md`, `docs/superpowers/specs/2026-10-15-voice-reader-design.md`, `tasks.md`.

---

# Slice 1a — the espeak gate

### Task 1: The two pins, installed in the dev venv

**Files:**
- Modify: `sidecar/requirements.txt`

**Interfaces:**
- Produces: `kokoro_onnx` and `onnxruntime` importable from `sidecar/.venv`.

- [ ] **Step 1: Record the baselines**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests -q 2>&1 | tail -3` and `npm test 2>&1 | tail -6`
Write the two pass counts into your notes; every later "no regression" is against them.

- [ ] **Step 2: Add the pins**

Append to `sidecar/requirements.txt` (the file already ends with `pypdfium2==5.13.0`):

```
kokoro-onnx==0.6.1
onnxruntime==1.31.0
```

- [ ] **Step 3: Install and prove the import**

Run: `sidecar/.venv/bin/pip install -r sidecar/requirements.txt 2>&1 | tail -2`
Run: `sidecar/.venv/bin/python -c "import kokoro_onnx, onnxruntime; print(onnxruntime.__version__)"`
Expected: `1.31.0`

- [ ] **Step 4: Confirm nothing that reads the requirements file broke**

Run: `npm test -- electron/main/services/python-env.test.ts 2>&1 | tail -6`
Expected: PASS (the marker hash is computed from the file's bytes, so it changes by design; no case pins a specific hash).

- [ ] **Step 5: Commit**

```bash
git add sidecar/requirements.txt
git commit -m "build(tts): pin kokoro-onnx and onnxruntime

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
(No `/verify` needed: no source changed.)

---

### Task 2: `scripts/build-espeak.sh`

**Files:**
- Create: `scripts/build-espeak.sh`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `helpers/bin/espeak/lib/libespeak-ng.dylib` (a plain file) and `helpers/bin/espeak/share/espeak-ng-data/` (core files + `en_dict` only). The directory that **contains** `espeak-ng-data` is `helpers/bin/espeak/share` — that is what `espeak_Initialize`'s `path` wants, and what Task 3 passes.

- [ ] **Step 1: Write the script**

```sh
#!/bin/sh
# Build the espeak-ng library the voice reader's pronunciation front end loads
# (spec D2, docs/superpowers/plans/2026-10-15-voice-reader-engine.md Task 2).
#
# Why this exists: the pip `espeakng-loader` wheel compiles a *build machine's*
# data path into its binary (`/Users/runner/work/...`), and espeak-ng calls exit()
# when it cannot read `phontab` there — measured on 0.1.51, 0.2.1 and 0.2.4, and no
# runtime path argument rescues it. A build of our own takes its data directory at
# run time (`espeak_Initialize`'s `path`), so the bundle is relocatable and nothing
# is baked in.
#
# Needs cmake, git and the network, and only to *build*: CMake's configure fetches a
# pinned `sonic` from GitHub even with USE_LIBSONIC=OFF. The app never needs any of
# it. GPL-3 (spec D2 → Licence); arm64 only, like the layout helper.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
version=1.52.0
sha256=bb4338102ff3b49a81423da8a1a158b420124b055b60fa76cfb4b18677130a23
work="${MUSAEUM_ESPEAK_WORK:-$root/helpers/.espeak-build}"
out="$root/helpers/bin/espeak"

mkdir -p "$work"
tarball="$work/espeak-ng-$version.tar.gz"
if [ ! -f "$tarball" ]; then
  curl -fsSL -o "$tarball" "https://github.com/espeak-ng/espeak-ng/archive/refs/tags/$version.tar.gz"
fi
echo "$sha256  $tarball" | shasum -a 256 -c -

rm -rf "$work/src" "$work/build" "$work/install"
mkdir -p "$work/src"
tar xzf "$tarball" -C "$work/src" --strip-components=1

cmake -S "$work/src" -B "$work/build" \
  -DBUILD_SHARED_LIBS=ON -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0 \
  -DCMAKE_INSTALL_PREFIX="$work/install" \
  -DUSE_MBROLA=OFF -DUSE_LIBSONIC=OFF -DUSE_LIBPCAUDIO=OFF \
  -DUSE_ASYNC=OFF -DUSE_SPEECHPLAYER=OFF -DUSE_KLATT=OFF
cmake --build "$work/build" -j 8
cmake --install "$work/build"

rm -rf "$out"
mkdir -p "$out/lib" "$out/share/espeak-ng-data"
# A plain file, not the symlink chain `cmake --install` makes: extraResources and
# codesign both prefer one. It is loaded by absolute path, so its install name
# (`@rpath/libespeak-ng.1.dylib`) never matters.
cp "$work/install/lib/libespeak-ng.1.52.0.dylib" "$out/lib/libespeak-ng.dylib"

# English only. The sentences we speak are English, and `ru_dict` alone is 8.5 of
# the full data's 19.8 MB; pruned, the whole bundle is ~2.3 MB.
data="$work/install/share/espeak-ng-data"
for entry in "$data"/*; do
  name="$(basename "$entry")"
  case "$name" in
    *_dict) [ "$name" = en_dict ] || continue ;;
  esac
  cp -R "$entry" "$out/share/espeak-ng-data/"
done
echo "built $out"
```

- [ ] **Step 2: Ignore the scratch directory**

In `.gitignore`, directly under the existing `helpers/bin/` line, add:

```
# The espeak-ng source and build tree, from scripts/build-espeak.sh
helpers/.espeak-build/
```

- [ ] **Step 3: Run it**

Run: `chmod +x scripts/build-espeak.sh && ./scripts/build-espeak.sh 2>&1 | tail -4`
Expected: ends with `built .../helpers/bin/espeak`.

- [ ] **Step 4: Check the layout and the size**

Run:
```bash
sidecar/.venv/bin/python - <<'EOF'
import os
base = "helpers/bin/espeak"
assert os.path.isfile(f"{base}/lib/libespeak-ng.dylib") and not os.path.islink(f"{base}/lib/libespeak-ng.dylib")
data = f"{base}/share/espeak-ng-data"
assert os.path.isfile(f"{data}/phontab") and os.path.isfile(f"{data}/en_dict")
dicts = sorted(n for n in os.listdir(data) if n.endswith("_dict"))
assert dicts == ["en_dict"], dicts
total = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(base) for f in fs)
print("bundle bytes", total)
assert total < 5_000_000, total
EOF
```
Expected: prints a number near `2300000` and exits 0.

- [ ] **Step 5: Measure reproducibility (AC1) — a measurement, not an assumption**

Run:
```bash
cp -R helpers/bin/espeak /tmp/espeak-first-build && ./scripts/build-espeak.sh >/dev/null 2>&1 && diff -r /tmp/espeak-first-build/share helpers/bin/espeak/share && echo "data identical" ; rm -rf /tmp/espeak-first-build
```
Expected: `data identical` (the compiled dictionaries are deterministic). **If `diff` reports differences, do not weaken the script:** record which files differ in the Task 12 spec amendment and change AC1 to "built from the pinned source, with the data checksums recorded in the annex" — the library binary itself is not required to be byte-identical.

- [ ] **Step 6: Commit**

```bash
git add scripts/build-espeak.sh .gitignore
git commit -m "build(tts): build and prune espeak-ng ourselves

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `phonemize.py` and its tests

**Files:**
- Create: `sidecar/tts/__init__.py` (empty), `sidecar/tts/errors.py`, `sidecar/tts/phonemize.py`
- Test: `sidecar/tests/test_tts_phonemize.py`

**Interfaces:**
- Produces: `TtsError`; `PhonemizerUnavailable(TtsError)`; `EspeakPaths(lib: str, share: str)`; `find_espeak() -> Optional[EspeakPaths]`; `class Phonemizer` with `.phonemes(text: str, lang: str = "en-us") -> str`; `get_phonemizer() -> Phonemizer` (process-wide, cached).

- [ ] **Step 1: Write the failing tests**

`sidecar/tests/test_tts_phonemize.py`:

```python
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests/test_tts_phonemize.py -q`
Expected: FAIL / error — `No module named 'tts'`.

- [ ] **Step 3: Write the implementation**

`sidecar/tts/__init__.py`: an empty file.

`sidecar/tts/errors.py`:

```python
"""One base class for every refusal the speech RPC turns into a sentence.

`synthesize_rpc` answers `{ "error": str(exc) }` for any `TtsError` and lets
everything else raise: a missing model or a missing pronunciation bundle is a normal
outcome the reader shows in one line, and a bug is not.
"""


class TtsError(Exception):
    """A refusal whose message is fit to show a person."""
```

`sidecar/tts/phonemize.py`:

```python
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
```

- [ ] **Step 4: Run to verify they pass**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests/test_tts_phonemize.py -q`
Expected: 7 passed (none skipped, since Task 2 built the bundle).

- [ ] **Step 5: Prove the "moved aside" case can fail**

Temporarily change `find_espeak`'s condition to drop the `phontab` check (`if lib.is_file():`), run the file again.
Expected: `test_data_moved_aside_is_noticed_before_espeak_can_exit` FAILS. Restore the check and re-run: PASS.

- [ ] **Step 6: Commit**

```bash
git add sidecar/tts sidecar/tests/test_tts_phonemize.py
git commit -m "feat(tts): the pronunciation front end, on the bundle we build

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
(New source under `sidecar/` and nothing wired in yet; run `/verify` first per the repo rule.)

---

### Task 4: The bundle rides `extraResources`, and the packaged-app proof

**Files:**
- Modify: `electron-builder.yml` (a comment), `test/invariants.test.ts` (one case)

**Interfaces:**
- Consumes: the `helpers/bin → helpers/bin` entry that already carries the layout helper; `helpers/bin/espeak/` is a subdirectory of it.

- [ ] **Step 1: Read the existing entry and its neighbours**

Run: `sed -n 54,66p electron-builder.yml` and `sed -n 1,57p test/invariants.test.ts`
Note how `invariants.test.ts` reads files and builds a `describe` (U1b's sandbox cases are the precedent).

- [ ] **Step 2: Write the failing test**

Add to `test/invariants.test.ts`, after the existing `describe` blocks, following that file's own import and file-reading idiom (reuse its helper, e.g. a `read(path)` / `readFileSync` already imported there — do not add a second reader):

```ts
describe('the bundled helpers (voice reader, spec D2)', () => {
  it('ships helpers/bin whole, so the espeak bundle travels with the layout helper', () => {
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    // One entry carries every helper. A narrower `from:` (the layout binary alone)
    // would leave the packaged app with no pronunciation data and no code defect to find.
    expect(yml).toMatch(/- from: helpers\/bin\n\s+to: helpers\/bin\n/)
  })
})
```
(If the file names its repo-root variable differently from `root`, or imports `readFileSync`/`join` differently, use what it already has.)

- [ ] **Step 3: Run**

Run: `npm test -- test/invariants.test.ts 2>&1 | tail -8`
Expected: PASS already (the entry exists). That is correct: this case pins a fact that was true by accident. Prove it can fail:

- [ ] **Step 4: Mutation check**

Change `to: helpers/bin` to `to: helpers` in `electron-builder.yml`, re-run the file.
Expected: the new case FAILS. Restore the line and re-run: PASS.

- [ ] **Step 5: Say in the comment that the entry now carries two things**

In `electron-builder.yml`, extend the comment above the `helpers/bin` entry by two lines (do not touch the entry itself):

```yaml
  # The espeak-ng pronunciation bundle (voice reader, spec D2) rides this same entry:
  # `scripts/build-espeak.sh` writes `helpers/bin/espeak/`, which `sidecar/tts/phonemize.py`
  # resolves by the same `parents[2]/helpers/bin` rule. ~2.3 MB.
```

- [ ] **Step 6: THE GATE — a packaged build phonemizes `Hegel` (AC3)**

This is the slice's decider; the unit tests above are not a substitute (the layout helper's lesson). Run, from the repo root:

```bash
./scripts/build-layout-helper.sh && ./scripts/build-espeak.sh >/dev/null 2>&1
npm run pack 2>&1 | tail -5
APP=$(ls -d dist/mac-arm64/*.app | head -1); echo "$APP"
ls "$APP/Contents/Resources/helpers/bin/espeak/lib/libespeak-ng.dylib" "$APP/Contents/Resources/helpers/bin/espeak/share/espeak-ng-data/phontab"
```
Expected: both files listed. **If either is missing, stop: the bundle is not shipping, and that is the finding.**

Then launch the packaged app on an isolated profile and let the first-launch bootstrap build its venv:

```bash
PROFILE=$(mktemp -d); echo "$PROFILE"
MUSAEUM_USER_DATA="$PROFILE" "$APP"/Contents/MacOS/* >/tmp/musaeum-pack.log 2>&1 &
APP_PID=$!
until [ -f "$PROFILE/sidecar-venv/.musaeum-requirements" ]; do sleep 5; done; echo "bootstrap done"
```
(The bootstrap pip-installs `requirements.txt`, which now includes `kokoro-onnx`, so this needs the network and takes a few minutes. If it never finishes, read `/tmp/musaeum-pack.log` before waiting longer.)

Then, from the packaged sidecar directory, with the managed venv's interpreter:

```bash
cd "$APP/Contents/Resources/sidecar" && "$PROFILE/sidecar-venv/bin/python" -I -c "
import sys; sys.path.insert(0, '.')
from tts.phonemize import Phonemizer, find_espeak
print(find_espeak())
print(Phonemizer().phonemes('Hegel'))
"
kill $APP_PID
```
Expected: the first line shows paths **inside** `…/Contents/Resources/helpers/bin/espeak/`, and the second line is `hˈɛdʒəl`.

Also record the growth: `sidecar/.venv/bin/python -c "import os,sys;b=sys.argv[1];print(sum(os.path.getsize(os.path.join(d,f)) for d,_,fs in os.walk(b) for f in fs))" "$APP/Contents/Resources/helpers/bin/espeak"` — expected under 5,000,000.

- [ ] **Step 7: Write down what you saw**

Append a short "Slice 1a — gate result" section to this plan file under the "Task 4" heading with: the date, the `Hegel` output verbatim, the packaged path printed by `find_espeak()`, and the byte count. **If the gate failed, write what failed, commit that note, and stop: this is an escalation under `CLAUDE.md`, not a reason to improvise a fallback.**

- [ ] **Step 8: Commit**

```bash
git add electron-builder.yml test/invariants.test.ts docs/superpowers/plans/2026-10-15-voice-reader-engine.md
git commit -m "test(tts): pin the helper entry that ships the pronunciation bundle, and record the packaged-app gate

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

# Slice 1b — the engine, in the sidecar

### Task 5: Text normalization

**Files:**
- Create: `sidecar/tts/normalize.py`
- Test: `sidecar/tests/test_tts_normalize.py`

**Interfaces:**
- Produces: `normalize_text(text: str) -> str`. Decimals between digits become " point "; dollar amounts become words. Everything else passes through **unchanged**.

- [ ] **Step 1: Write the failing tests**

```python
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
```

- [ ] **Step 2: Run to verify failure**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests/test_tts_normalize.py -q`
Expected: FAIL — `No module named 'tts.normalize'`.

- [ ] **Step 3: Write the implementation**

```python
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
```

- [ ] **Step 4: Run to verify they pass**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests/test_tts_normalize.py -q`
Expected: 17 passed.

- [ ] **Step 5: Confirm the fix against the real library (the reason this task exists)**

Run:
```bash
sidecar/.venv/bin/python -c "
import sys; sys.path.insert(0, 'sidecar')
from tts.phonemize import Phonemizer
from tts.normalize import normalize_text
p = Phonemizer()
for t in ['roughly 3.5 million patients', 'It cost \$2.1 billion.']:
    print(repr(t), '->', p.phonemes(normalize_text(t)))
"
```
Expected: the output contains `pɔɪnt` (the word "point") and **no** `. ` sentence break between the digits' phonemes.

- [ ] **Step 6: Commit**

```bash
git add sidecar/tts/normalize.py sidecar/tests/test_tts_normalize.py
git commit -m "feat(tts): read decimals and dollar amounts as words

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
(`/verify` first: new source.)

---

### Task 6: The lexicon

**Files:**
- Create: `sidecar/tts/lexicon.py`
- Test: `sidecar/tests/test_tts_lexicon.py`

**Interfaces:**
- Consumes: any object with `.phonemes(text: str, lang: str = "en-us") -> str` (the real `Phonemizer`, or a fake in tests).
- Produces:
  - `Entry(word: str, sounds_like: str)` — frozen dataclass.
  - `respelling_to_phonemes(phonemizer, sounds_like: str, lang: str = "en-us") -> str` — the part written in CAPITALS carries the stress (`HAY-gul`); with no capitals, the first part does.
  - `possessive_suffix(phonemes: str) -> str` — `"ɪz"` after a sibilant, `"s"` after a voiceless consonant, otherwise `"z"`.
  - `class Lexicon(entries, phonemizer, lang="en-us")` with `.phonemes(text) -> tuple[str, list[Entry]]` (the phoneme string and the entries that applied).
  - `lexicon_version(applied: list[Entry]) -> str` — a stable 16-hex-digit hash of the entries that applied, order-independent.

- [ ] **Step 1: Write the failing tests**

```python
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
```

- [ ] **Step 2: Run to verify failure**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests/test_tts_lexicon.py -q`
Expected: FAIL — `No module named 'tts.lexicon'`.

- [ ] **Step 3: Write the implementation**

```python
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


# Keyed by the phonemizer's identity too, so a test's fake never poisons the real one.
_respelled: dict[tuple[int, str, str], str] = {}


def respelling_to_phonemes(phonemizer: Any, sounds_like: str, lang: str = "en-us") -> str:
    """"HAY-gul" → phonemes. The part in CAPITALS keeps its stress; with none, the first does."""
    key = (id(phonemizer), lang, sounds_like)
    cached = _respelled.get(key)
    if cached is not None:
        return cached
    parts = [p for p in re.split(r"[-\s]+", sounds_like.strip()) if p]
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
    _respelled[key] = result
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
            if word and entry.sounds_like.strip():
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
```

- [ ] **Step 4: Run to verify they pass**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests/test_tts_lexicon.py -q`
Expected: all pass (the three `needs_espeak` cases run, since the bundle is built).

- [ ] **Step 5: Mutation check on the one rule most likely to be quietly wrong**

In `lexicon.py` change `(?!\w)` in the pattern to nothing (remove it), re-run.
Expected: `test_matching_is_whole_word_and_case_sensitive` FAILS (`Hegelian` gets split). Restore; re-run: PASS.

- [ ] **Step 6: Listen to the respelling-derived phonemes (AC24's input — Jason decides)**

Run a short script that renders the Hegel/Kojève sentence from the earlier listening test through `Lexicon` with `Entry("Hegel", "HAY-gul")`, `Entry("Kojève", "ko-ZHEV")` using the real phonemizer and the int8 model, writing `hegel-respelled-<voice>.wav` for `af_heart` and `bm_george` into `~/Downloads/musaeum-tts-bakeoff/out/`. Use this exact script (it needs `MUSAEUM_TTS_MODELS` exported; the engine lands in Task 8, so this step calls `kokoro_onnx` directly):

```bash
MUSAEUM_TTS_MODELS=$HOME/Downloads/musaeum-tts-bakeoff/models sidecar/.venv/bin/python - <<'EOF'
import os, sys; sys.path.insert(0, "sidecar")
import soundfile as sf
from kokoro_onnx import Kokoro
from kokoro_onnx.config import EspeakConfig
from tts.phonemize import get_phonemizer, find_espeak
from tts.lexicon import Entry, Lexicon
paths = find_espeak(); models = os.environ["MUSAEUM_TTS_MODELS"]
k = Kokoro(f"{models}/kokoro-v1.0.int8.onnx", f"{models}/voices-v1.0.bin", espeak_config=EspeakConfig(lib_path=paths.lib, data_path=paths.share))
text = "What Hegel calls the 'cunning of reason' is not a theodicy in disguise, a point Kojève, reading the Phenomenology in the 1930s, pressed with considerable force."
for voice in ("af_heart", "bm_george"):
    lang = "en-gb" if voice[0] == "b" else "en-us"
    ph, _ = Lexicon([Entry("Hegel", "HAY-gul"), Entry("Kojève", "ko-ZHEV")], get_phonemizer(), lang).phonemes(text)
    audio, sr = k.create(ph, voice=voice, is_phonemes=True)
    sf.write(os.path.expanduser(f"~/Downloads/musaeum-tts-bakeoff/out/hegel-respelled-{voice}.wav"), audio, sr)
    print(voice, "ok")
EOF
```
Then ask Jason to listen to the two files. **If `Hegel` or `Kojève` is wrong, the fix is in `respelling_to_phonemes`'s rule, not in the tests** — record what he heard in the Task 12 annex and adjust the rule (for instance, treating a doubled consonant as a stop) before slice 3 builds on it. This step does not block Task 7.

- [ ] **Step 7: Commit**

```bash
git add sidecar/tts/lexicon.py sidecar/tests/test_tts_lexicon.py
git commit -m "feat(tts): the pronunciation lexicon

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
(`/verify` first.)

---

### Task 7: Model files — status, verification, download, cancel

**Files:**
- Create: `sidecar/tts/models.py`
- Test: `sidecar/tests/test_tts_models.py`

**Interfaces:**
- Consumes: `TtsError`.
- Produces:
  - `ModelFile(name, size, sha256)`; `FILES` (the two pinned files); `MODEL_FILE`, `VOICES_FILE` (names); `RELEASE_URL`; `TOTAL_BYTES`.
  - `ModelProblem(TtsError)`.
  - `model_status(model_dir, files=FILES) -> {"ready": bool, "missing": [str], "total_bytes": int}` — cheap: existence and size only.
  - `verify(model_dir, files=FILES) -> None` — hashes each file (memoized by path/size/mtime) and raises `ModelProblem("The voice is not downloaded yet")` or `ModelProblem("The voice files are damaged — download them again")`.
  - `download_models(model_dir, *, job_id, notify, files=FILES, base_url=RELEASE_URL, chunk=65536) -> {"status": "ready"} | {"status": "cancelled"} | {"status": "failed", "error": str}`; progress is `notify("tts_model_progress", {"job_id", "file", "completed", "total"})` with `completed`/`total` in **bytes across all files**.
  - `cancel_download(job_id) -> {"cancelled": True}` — safe before the job starts (the cancel sticks).

- [ ] **Step 1: Write the failing tests**

```python
"""Model acquisition: pinned, verified, resumable-by-restart, cancelable, and quiet about failure."""

import hashlib
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from tts import models
from tts.models import ModelFile, ModelProblem

A = b"a" * 50_000
B = b"b" * 30_000


def sha(b):
    return hashlib.sha256(b).hexdigest()


FILES = (ModelFile("a.bin", len(A), sha(A)), ModelFile("b.bin", len(B), sha(B)))


@pytest.fixture
def server():
    served = {"a.bin": A, "b.bin": B}
    hits = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = served.get(self.path.lstrip("/"))
            hits.append(self.path)
            if body is None:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):  # keep pytest output clean
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}", served, hits
    httpd.shutdown()


def run(tmp_path, base, **kw):
    frames = []
    result = models.download_models(
        str(tmp_path / "m"),
        job_id=kw.pop("job_id", "job-1"),
        notify=lambda method, params: frames.append((method, params)),
        files=FILES,
        base_url=base,
        chunk=4096,
        **kw,
    )
    return result, frames


def test_the_pinned_files_match_the_spec():
    assert [f.name for f in models.FILES] == ["kokoro-v1.0.int8.onnx", "voices-v1.0.bin"]
    assert models.FILES[0].size == 92_361_271 and models.FILES[1].size == 28_214_398
    assert models.FILES[0].sha256 == "6e742170d309016e5891a994e1ce1559c702a2ccd0075e67ef7157974f6406cb"
    assert models.FILES[1].sha256 == "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d"
    assert models.TOTAL_BYTES == 92_361_271 + 28_214_398


def test_status_with_nothing_downloaded(tmp_path):
    s = models.model_status(str(tmp_path / "nope"), FILES)
    assert s == {"ready": False, "missing": ["a.bin", "b.bin"], "total_bytes": len(A) + len(B)}


def test_download_verifies_and_reports_progress(tmp_path, server):
    base, _, _ = server
    result, frames = run(tmp_path, base)
    assert result == {"status": "ready"}
    assert models.model_status(str(tmp_path / "m"), FILES)["ready"] is True
    assert frames and all(m == "tts_model_progress" for m, _ in frames)
    last = frames[-1][1]
    assert last["completed"] == last["total"] == len(A) + len(B) and last["job_id"] == "job-1"
    models.verify(str(tmp_path / "m"), FILES)  # does not raise


def test_a_good_file_already_on_disk_is_not_fetched_again(tmp_path, server):
    base, _, hits = server
    run(tmp_path, base)
    hits.clear()
    result, _ = run(tmp_path, base, job_id="job-2")
    assert result == {"status": "ready"} and hits == []


def test_a_corrupted_file_on_disk_is_replaced(tmp_path, server):
    base, _, hits = server
    run(tmp_path, base)
    (tmp_path / "m" / "a.bin").write_bytes(b"x" * len(A))  # right size, wrong bytes
    with pytest.raises(ModelProblem, match="damaged"):
        models.verify(str(tmp_path / "m"), FILES)
    hits.clear()
    result, _ = run(tmp_path, base, job_id="job-3")
    assert result == {"status": "ready"} and hits == ["/a.bin"]
    models.verify(str(tmp_path / "m"), FILES)


def test_a_server_that_sends_the_wrong_bytes_leaves_nothing_behind(tmp_path, server):
    base, served, _ = server
    served["a.bin"] = b"z" * len(A)
    result, _ = run(tmp_path, base)
    assert result["status"] == "failed" and "a.bin" in result["error"]
    assert sorted(p.name for p in (tmp_path / "m").iterdir()) == []  # no a.bin, no a.bin.part


def test_a_missing_file_is_a_failed_result_not_a_raise(tmp_path, server):
    base, served, _ = server
    del served["b.bin"]
    result, _ = run(tmp_path, base)
    assert result["status"] == "failed"
    assert (tmp_path / "m" / "a.bin").is_file()  # the good file is kept
    assert not (tmp_path / "m" / "b.bin.part").exists()


def test_a_stale_part_file_from_a_killed_run_does_not_wedge_the_next(tmp_path, server):
    base, _, _ = server
    (tmp_path / "m").mkdir()
    (tmp_path / "m" / "a.bin.part").write_bytes(b"half")
    result, _ = run(tmp_path, base)
    assert result == {"status": "ready"}
    assert not (tmp_path / "m" / "a.bin.part").exists()


def test_cancel_stops_the_download_and_removes_the_part(tmp_path, server):
    base, _, _ = server
    frames = []

    def notify(method, params):
        frames.append(params)
        models.cancel_download("job-9")

    result = models.download_models(
        str(tmp_path / "m"), job_id="job-9", notify=notify, files=FILES, base_url=base, chunk=1024
    )
    assert result == {"status": "cancelled"}
    assert not list((tmp_path / "m").glob("*.part"))
    assert not (tmp_path / "m" / "a.bin").exists()


def test_a_cancel_that_arrives_before_the_job_starts_still_sticks(tmp_path, server):
    base, _, hits = server
    models.cancel_download("job-early")
    result, _ = run(tmp_path, base, job_id="job-early")
    assert result == {"status": "cancelled"} and hits == []


def test_it_writes_only_under_the_model_directory(tmp_path, server):
    base, _, _ = server
    run(tmp_path, base)
    assert {p.name for p in tmp_path.iterdir()} == {"m"}
```

- [ ] **Step 2: Run to verify failure**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests/test_tts_models.py -q`
Expected: FAIL — `No module named 'tts.models'`.

- [ ] **Step 3: Write the implementation**

```python
"""The speech model's files (spec D4): pinned by size and sha256, downloaded on first use.

They come from the `thewh1teagle/kokoro-onnx` release `model-files-v1.0` into
`userData/tts-models/` — the caller passes that directory in, so this module reads no
configuration and is decided without Electron. They are *not* in the DMG: 120 MB would
more than double it for a feature a person may never open. The hashes are the hashes of
the files Jason's listening test used on 2026-10-15, so the voices he approved are the
voices this pins.
"""

from __future__ import annotations

import hashlib
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import requests

from .errors import TtsError

RELEASE_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"


@dataclass(frozen=True)
class ModelFile:
    name: str
    size: int
    sha256: str


FILES = (
    ModelFile(
        "kokoro-v1.0.int8.onnx",
        92_361_271,
        "6e742170d309016e5891a994e1ce1559c702a2ccd0075e67ef7157974f6406cb",
    ),
    ModelFile(
        "voices-v1.0.bin",
        28_214_398,
        "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
    ),
)
MODEL_FILE = FILES[0].name
VOICES_FILE = FILES[1].name
TOTAL_BYTES = sum(f.size for f in FILES)


class ModelProblem(TtsError):
    """The model is absent or damaged."""


class _Cancelled(Exception):
    pass


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def model_status(model_dir: str, files: tuple[ModelFile, ...] = FILES) -> dict:
    """Cheap by design — existence and size only; `verify` is the one that hashes."""
    base = Path(model_dir)
    missing = [
        f.name for f in files if not (base / f.name).is_file() or (base / f.name).stat().st_size != f.size
    ]
    return {"ready": not missing, "missing": missing, "total_bytes": sum(f.size for f in files)}


# (path, size, mtime_ns) → verified. A model is hashed once per process, not once per sentence.
_verified: set[tuple[str, int, int]] = set()


def verify(model_dir: str, files: tuple[ModelFile, ...] = FILES) -> None:
    base = Path(model_dir)
    for f in files:
        path = base / f.name
        if not path.is_file():
            raise ModelProblem("The voice is not downloaded yet")
        st = path.stat()
        key = (str(path), st.st_size, st.st_mtime_ns)
        if key in _verified:
            continue
        if st.st_size != f.size or _sha256(path) != f.sha256:
            raise ModelProblem("The voice files are damaged — download them again")
        _verified.add(key)


_cancels: dict[str, threading.Event] = {}
_cancels_lock = threading.Lock()


def _event(job_id: str) -> threading.Event:
    with _cancels_lock:
        return _cancels.setdefault(job_id, threading.Event())


def cancel_download(job_id: str) -> dict:
    """Safe before the job starts: the event is created by whichever side arrives first."""
    _event(job_id).set()
    return {"cancelled": True}


def download_models(
    model_dir: str,
    *,
    job_id: str,
    notify: Callable[[str, dict], None],
    files: tuple[ModelFile, ...] = FILES,
    base_url: str = RELEASE_URL,
    chunk: int = 1 << 16,
) -> dict:
    cancel = _event(job_id)
    base = Path(model_dir)
    total = sum(f.size for f in files)
    done = 0
    part: Path | None = None
    try:
        if cancel.is_set():
            raise _Cancelled
        base.mkdir(parents=True, exist_ok=True)
        for f in files:
            dest = base / f.name
            if dest.is_file() and dest.stat().st_size == f.size and _sha256(dest) == f.sha256:
                done += f.size
                continue
            part = dest.with_name(dest.name + ".part")
            h = hashlib.sha256()
            got = 0
            last = 0
            step = max(total // 100, 1)
            with requests.get(f"{base_url}/{f.name}", stream=True, timeout=30) as r, open(part, "wb") as out:
                r.raise_for_status()
                for block in r.iter_content(chunk):
                    if cancel.is_set():
                        raise _Cancelled
                    out.write(block)
                    h.update(block)
                    got += len(block)
                    if got - last >= step or got == f.size:
                        last = got
                        notify("tts_model_progress", {"job_id": job_id, "file": f.name, "completed": done + got, "total": total})
            if got != f.size or h.hexdigest() != f.sha256:
                raise ModelProblem(f"{f.name} did not download correctly — try again")
            os.replace(part, dest)
            part = None
            done += f.size
        return {"status": "ready"}
    except _Cancelled:
        return {"status": "cancelled"}
    except (requests.RequestException, OSError, ModelProblem) as exc:
        return {"status": "failed", "error": str(exc)}
    finally:
        if part is not None:
            part.unlink(missing_ok=True)
        # A leftover .part from a *previous*, killed run for a file we skipped is harmless;
        # one for a file we fetched was replaced above. Nothing else is cleaned.
        with _cancels_lock:
            _cancels.pop(job_id, None)
```

- [ ] **Step 4: Run to verify they pass**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests/test_tts_models.py -q`
Expected: 11 passed.

- [ ] **Step 5: Mutation checks**

(a) In `download_models` change `h.hexdigest() != f.sha256` to `False`, re-run → `test_a_server_that_sends_the_wrong_bytes_leaves_nothing_behind` FAILS. (b) Remove the `if cancel.is_set(): raise _Cancelled` before `base.mkdir`, re-run → `test_a_cancel_that_arrives_before_the_job_starts_still_sticks` FAILS. Restore both; all pass.

- [ ] **Step 6: Commit**

```bash
git add sidecar/tts/models.py sidecar/tests/test_tts_models.py
git commit -m "feat(tts): the pinned model files, verified, downloadable and cancelable

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
(`/verify` first.)

---

### Task 8: The engine and the RPC function

**Files:**
- Create: `sidecar/tts/engine.py`
- Test: `sidecar/tests/test_tts_engine.py`, `sidecar/tests/test_tts_engine_real.py`

**Interfaces:**
- Consumes: `normalize_text`, `Lexicon`/`Entry`/`lexicon_version`, `get_phonemizer`/`PhonemizerUnavailable`/`find_espeak`, `models.verify`/`ModelProblem`/`MODEL_FILE`/`VOICES_FILE`, `TtsError`.
- Produces:
  - `SAMPLE_RATE = 24_000`, `IDLE_SECONDS = 300`, `VOICES` (the five), `EngineError(TtsError)`.
  - `class SpeechEngine(loader=load_kokoro, phonemizer=get_phonemizer, idle_seconds=IDLE_SECONDS, timer=threading.Timer, clock=time.monotonic)` with `.synthesize(*, model_dir, text, voice, speed, lexicon) -> dict` and `.release_if_idle() -> bool`.
  - `synthesize_rpc(params: dict) -> dict` — params `model_dir, text, voice?, speed?, lexicon?` (`lexicon` = `[{ "word", "sounds_like" }]`); returns `{ "sample_rate", "pcm" (base64 of s16le), "duration_ms", "lexicon_version" }` or `{ "error": str }`.

- [ ] **Step 1: Write the failing unit tests (fake model, fake timer, fake clock)**

`sidecar/tests/test_tts_engine.py`:

```python
"""The engine's contract, decided without a model: shapes, limits, lifecycle, and the quiet failures."""

import base64
import threading

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
    assert eng.release_if_idle() is False  # the call in flight holds the lock
    finish.set()
    t.join(5)
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
```

- [ ] **Step 2: Run to verify failure**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests/test_tts_engine.py -q`
Expected: FAIL — `No module named 'tts.engine'`.

- [ ] **Step 3: Write the implementation**

`sidecar/tts/engine.py`:

```python
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
        self._lock = threading.RLock()
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
            if not phonemes.strip():
                return _silence(version)
            model = self._model_for(model_dir)
            try:
                samples, rate = model.create(phonemes, voice=voice, speed=speed, lang=lang, is_phonemes=True)
            except ValueError as exc:
                if any(marker in str(exc) for marker in _NOTHING):
                    return _silence(version)
                raise
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
```

- [ ] **Step 4: Run to verify they pass**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests/test_tts_engine.py -q`
Expected: 15 passed.

- [ ] **Step 5: Mutation checks on the three behaviours that fail silently**

(a) In `release_if_idle` replace `blocking=False` with `blocking=True` and re-run → `test_release_never_lands_under_a_running_synthesis` HANGS or FAILS (use `timeout 30`). Restore. (b) Delete the `try/except ValueError` block's `return _silence` branch (re-raise always) → `test_a_model_that_rejects_unspeakable_phonemes_is_also_silence` FAILS. Restore. (c) Change `"<i2"` to `"<i4"` → `test_the_result_is_mono_s16_pcm_at_24khz` FAILS. Restore; all pass.

- [ ] **Step 6: Write the real-model tests**

`sidecar/tests/test_tts_engine_real.py`:

```python
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


@pytest.mark.parametrize("text", ["†", "***", "[12]", "• •", "😀"])
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
```

- [ ] **Step 7: Run them against the real model**

Run: `MUSAEUM_TTS_MODELS=$HOME/Downloads/musaeum-tts-bakeoff/models sidecar/.venv/bin/python -m pytest sidecar/tests/test_tts_engine_real.py -q -s 2>&1 | tail -12`
Expected: all pass; the `-s` run prints `cold … warm …` — copy those two numbers into the annex.
**If a "nothing to say" case raises instead of returning silence, the engine's `_NOTHING` markers do not match `kokoro-onnx`'s actual message** — read the exception text, fix the marker in `engine.py`, and add that exact message to `test_text_with_nothing_to_say_is_silence`'s docstring. **If the long-sentence case fails,** do not add a chunker blindly: print the exception and the phoneme count first.

- [ ] **Step 8: Run without the inputs to prove the skip is loud**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests/test_tts_engine_real.py -q -rs 2>&1 | tail -4`
Expected: every case SKIPPED with the reason printed.

- [ ] **Step 9: Commit**

```bash
git add sidecar/tts/engine.py sidecar/tests/test_tts_engine.py sidecar/tests/test_tts_engine_real.py
git commit -m "feat(tts): the speech engine and its RPC body

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
(`/verify` first.)

---

### Task 9: Wire the four methods and the lane into `sidecar/main.py`

**Files:**
- Modify: `sidecar/main.py`
- Test: `sidecar/tests/test_tts_lane.py`

**Interfaces:**
- Consumes: `synthesize_rpc`, `model_status`, `download_models`, `cancel_download`.
- Produces: RPC methods `tts_synthesize`, `tts_model_status`, `tts_download_model`, `tts_cancel_download`; module-level `POOL` (4 threads, shared), `TTS_POOL` (1 thread), `lane_for(request)`, `dispatch(request)`.

- [ ] **Step 1: Write the failing test**

`sidecar/tests/test_tts_lane.py`:

```python
"""Speech has its own lane: a saturated shared pool must not make the voice stall (spec D3, AC7)."""

import threading
import time

import main


def _wait_for(sent, n=1, timeout=2.0):
    end = time.time() + timeout
    while len(sent) < n and time.time() < end:
        time.sleep(0.01)


def test_synthesis_is_answered_while_the_shared_pool_is_saturated(monkeypatch):
    sent = []
    monkeypatch.setattr(main, "send", sent.append)
    monkeypatch.setitem(main.METHODS, "tts_synthesize", lambda p: {"ok": True})
    gate = threading.Event()
    blockers = [main.POOL.submit(gate.wait) for _ in range(4)]
    try:
        main.dispatch({"id": 1, "method": "tts_synthesize", "params": {}})
        _wait_for(sent)
        assert sent and sent[0]["id"] == 1 and sent[0]["result"] == {"ok": True}
    finally:
        gate.set()
        for b in blockers:
            b.result(5)


def test_an_ordinary_method_does_queue_behind_the_saturated_pool(monkeypatch):
    # The control: without this, the test above would pass even if every method had its own lane.
    sent = []
    monkeypatch.setattr(main, "send", sent.append)
    monkeypatch.setitem(main.METHODS, "ordinary", lambda p: {"ok": True})
    gate = threading.Event()
    blockers = [main.POOL.submit(gate.wait) for _ in range(4)]
    try:
        main.dispatch({"id": 2, "method": "ordinary", "params": {}})
        time.sleep(0.2)
        assert sent == []
    finally:
        gate.set()
        for b in blockers:
            b.result(5)
    _wait_for(sent)
    assert sent and sent[0]["id"] == 2


def test_lane_for_tolerates_a_request_that_is_not_an_object():
    assert main.lane_for(["not", "an", "object"]) is main.POOL
    assert main.lane_for({"method": "tts_synthesize"}) is main.TTS_POOL
    assert main.lane_for({}) is main.POOL


def test_the_four_speech_methods_are_registered():
    for name in ("tts_synthesize", "tts_model_status", "tts_download_model", "tts_cancel_download"):
        assert name in main.METHODS


def test_the_status_method_reads_the_model_dir_param(monkeypatch, tmp_path):
    out = main.METHODS["tts_model_status"]({"model_dir": str(tmp_path)})
    assert out["ready"] is False and out["missing"]
```

- [ ] **Step 2: Run to verify failure**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests/test_tts_lane.py -q`
Expected: FAIL — `module 'main' has no attribute 'POOL'`.

- [ ] **Step 3: Edit `sidecar/main.py`**

(a) Add the imports. Replace the line `from reflow.produce import reflow_pdf` with:

```python
from reflow.produce import reflow_pdf
from tts.engine import synthesize_rpc
from tts.models import cancel_download, download_models, model_status
```

(b) Register the methods. Replace the end of the `METHODS` dict — the block

```python
        force=bool(p.get("force")),
        notify=notify,
    ),
}
```

with:

```python
        force=bool(p.get("force")),
        notify=notify,
    ),
    # The voice reader (spec D3/D4). `tts_synthesize` runs on its own single-thread lane
    # (see `lane_for`) so a bulk refresh that fills the shared pool cannot stall the
    # voice; the other three are quick or long-and-independent and use the shared pool.
    # A refusal — no model, no pronunciation data — answers `{ "error": ... }` rather than
    # raising, because it is a normal outcome the reader shows in one line.
    "tts_synthesize": lambda p: synthesize_rpc(p),
    "tts_model_status": lambda p: model_status(p["model_dir"]),
    "tts_download_model": lambda p: download_models(
        p["model_dir"], job_id=p["job_id"], notify=notify
    ),
    "tts_cancel_download": lambda p: cancel_download(p["job_id"]),
}

# Two pools. The shared one is the four threads hydration, conversion, covers and the
# reflow have always used; speech gets one of its own, because a sentence queued behind
# a Google Books call is a voice that stutters. CPU contention remains and is measured
# live (spec AC21), not assumed away here.
POOL = ThreadPoolExecutor(max_workers=4)
TTS_POOL = ThreadPoolExecutor(max_workers=1)
TTS_LANE = frozenset({"tts_synthesize"})


def lane_for(request: object) -> ThreadPoolExecutor:
    method = request.get("method") if isinstance(request, dict) else None
    return TTS_POOL if method in TTS_LANE else POOL


def dispatch(request: object) -> None:
    lane_for(request).submit(handle_request, request)
```

(c) Use it in `main()`. Replace

```python
def main() -> None:
    pool = ThreadPoolExecutor(max_workers=4)
    for line in sys.stdin:
```
with
```python
def main() -> None:
    for line in sys.stdin:
```
and replace `        pool.submit(handle_request, request)` with `        dispatch(request)`.

- [ ] **Step 4: Run to verify they pass**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests/test_tts_lane.py sidecar/tests/test_main_dispatch.py -q`
Expected: 7 passed (5 new + the 2 existing dispatch cases).

- [ ] **Step 5: Mutation check**

Change `TTS_LANE = frozenset({"tts_synthesize"})` to `frozenset()`, re-run → `test_synthesis_is_answered_while_the_shared_pool_is_saturated` FAILS (the control keeps passing). Restore.

- [ ] **Step 6: Full pytest — no regression against the Task 1 baseline**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests -q 2>&1 | tail -3`
Expected: baseline passed count + the new TTS cases, 0 failed. The real-model file is skipped unless `MUSAEUM_TTS_MODELS` is set.

- [ ] **Step 7: Run the sidecar for real, once, over its real stdin protocol**

```bash
cd sidecar && printf '%s\n' '{"id":"a","method":"tts_model_status","params":{"model_dir":"/nonexistent"}}' '{"id":"b","method":"tts_synthesize","params":{"model_dir":"/nonexistent","text":"Hello."}}' | ../sidecar/.venv/bin/python main.py 2>&1 | head -5; cd ..
```
Expected: two result frames. `a` has `"ready": false`; `b` has `"result": {"error": "The voice is not downloaded yet"}` and `"error": null`.

- [ ] **Step 8: Commit**

```bash
git add sidecar/main.py sidecar/tests/test_tts_lane.py
git commit -m "feat(tts): the speech RPC methods, on a lane of their own

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
(`/verify` first.)

---

# Slice 1c — the main-process bridge

### Task 10: Types and the service

**Files:**
- Create: `src/types/tts.types.ts`, `src/types/tts.types.test.ts`, `electron/main/services/tts.ts`
- Test: `electron/main/services/tts.test.ts`

**Interfaces:**
- Produces (`@shared/tts.types`):
  ```ts
  export const TTS_VOICES = ['af_heart', 'af_bella', 'bf_emma', 'bm_george', 'am_michael'] as const
  export type TtsVoice = (typeof TTS_VOICES)[number]
  export const TTS_DEFAULT_VOICE: TtsVoice = 'af_heart'
  export const TTS_MODEL_ID = 'kokoro-v1.0-int8'
  export const TTS_SPEED_MIN = 0.8
  export const TTS_SPEED_MAX = 1.5
  export function clampTtsSpeed(speed: number): number
  export interface VoiceSpec { model: typeof TTS_MODEL_ID; voice: TtsVoice; speed: number }
  export interface TtsRequest { text: string; voice: TtsVoice; speed: number }
  export interface TtsAudio { sampleRate: number; samples: Uint8Array; durationMs: number; lexiconVersion: string }
  export interface TtsModelStatus { ready: boolean; missing: string[]; totalBytes: number }
  export interface TtsDownloadProgress { jobId: string; file: string; completed: number; total: number }
  export type TtsDownloadResult = { status: 'ready' } | { status: 'cancelled' } | { status: 'failed'; error: string }
  ```
- Produces (`services/tts.ts`): `SYNTH_TIMEOUT_MS = 30_000`, `MAX_TEXT_CHARS = 4_000`, `modelDir(): string`, `status(): Promise<TtsModelStatus>`, `synthesize(request: TtsRequest): Promise<TtsAudio>`, `downloadModel(): Promise<TtsDownloadResult>`, `cancelDownload(): Promise<void>`, `resetForTests(): void`.

- [ ] **Step 1: Write the failing type tests**

`src/types/tts.types.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  TTS_DEFAULT_VOICE,
  TTS_MODEL_ID,
  TTS_SPEED_MAX,
  TTS_SPEED_MIN,
  TTS_VOICES,
  clampTtsSpeed
} from './tts.types'

describe('the speech contract', () => {
  it('offers exactly the five voices Jason chose, and the default is one of them', () => {
    expect([...TTS_VOICES]).toEqual(['af_heart', 'af_bella', 'bf_emma', 'bm_george', 'am_michael'])
    expect(TTS_VOICES).toContain(TTS_DEFAULT_VOICE)
  })

  it('names the model, because a rendered file will stamp it', () => {
    expect(TTS_MODEL_ID).toBe('kokoro-v1.0-int8')
  })

  it('clamps a speed to 0.8-1.5 and rounds to a step of 0.1', () => {
    expect(clampTtsSpeed(5)).toBe(TTS_SPEED_MAX)
    expect(clampTtsSpeed(0.1)).toBe(TTS_SPEED_MIN)
    expect(clampTtsSpeed(1.04)).toBe(1.0)
    expect(clampTtsSpeed(1.26)).toBe(1.3)
    expect(clampTtsSpeed(Number.NaN)).toBe(1.0)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/types/tts.types.test.ts 2>&1 | tail -6`
Expected: FAIL — cannot resolve `./tts.types`.

- [ ] **Step 3: Write `src/types/tts.types.ts`**

```ts
/**
 * The voice reader's contract (docs/superpowers/specs/2026-10-15-voice-reader-design.md).
 * Shared by the main-process service and, in slice 2, the reader.
 */

/** The five voices Jason chose by ear on 2026-10-15; more are available and nobody has heard them. */
export const TTS_VOICES = ['af_heart', 'af_bella', 'bf_emma', 'bm_george', 'am_michael'] as const
export type TtsVoice = (typeof TTS_VOICES)[number]
export const TTS_DEFAULT_VOICE: TtsVoice = 'af_heart'

/** What a rendered file's stamp will name (D9). */
export const TTS_MODEL_ID = 'kokoro-v1.0-int8'

export const TTS_SPEED_MIN = 0.8
export const TTS_SPEED_MAX = 1.5

/** Out-of-range speeds clamp, NaN falls back to 1.0, and the step is 0.1 (D7). */
export function clampTtsSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1.0
  const clamped = Math.min(TTS_SPEED_MAX, Math.max(TTS_SPEED_MIN, speed))
  return Math.round(clamped * 10) / 10
}

/** Voice, speed and model as one value, so a cache key or a stamp never has to assemble it (D9). */
export interface VoiceSpec {
  model: typeof TTS_MODEL_ID
  voice: TtsVoice
  speed: number
}

export interface TtsRequest {
  text: string
  voice: TtsVoice
  speed: number
}

/** One synthesized sentence: mono signed 16-bit little-endian PCM. Empty `samples` is silence. */
export interface TtsAudio {
  sampleRate: number
  samples: Uint8Array
  durationMs: number
  /** A hash of the lexicon entries that applied — what a rendered file's stamp will need. */
  lexiconVersion: string
}

export interface TtsModelStatus {
  ready: boolean
  missing: string[]
  totalBytes: number
}

export interface TtsDownloadProgress {
  jobId: string
  file: string
  /** Bytes, across both files. */
  completed: number
  total: number
}

export type TtsDownloadResult =
  | { status: 'ready' }
  | { status: 'cancelled' }
  | { status: 'failed'; error: string }
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- src/types/tts.types.test.ts 2>&1 | tail -6`
Expected: 3 passed.

- [ ] **Step 5: Write the failing service tests**

`electron/main/services/tts.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { join } from 'path'
import * as events from './events'
import * as sidecar from './sidecar'
import {
  MAX_TEXT_CHARS,
  SYNTH_TIMEOUT_MS,
  cancelDownload,
  downloadModel,
  modelDir,
  resetForTests,
  status,
  synthesize
} from './tts'

/** Whole-module mocks, as `reflow.test.ts` does: `assertAvailable` would otherwise start a live Python. */
vi.mock('./sidecar', () => ({
  assertAvailable: vi.fn(),
  call: vi.fn(),
  onNotification: vi.fn(() => () => {})
}))
vi.mock('./events', () => ({ broadcast: vi.fn() }))

const call = vi.mocked(sidecar.call)

beforeEach(() => {
  resetForTests()
  call.mockReset()
  vi.mocked(sidecar.assertAvailable).mockReset()
  vi.mocked(sidecar.onNotification).mockClear()
  vi.mocked(events.broadcast).mockClear()
})

function pcm(...samples: number[]): string {
  const b = Buffer.alloc(samples.length * 2)
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2))
  return b.toString('base64')
}

describe('synthesize', () => {
  it('sends the model directory, voice, speed and an empty lexicon, and maps the answer to camelCase', async () => {
    call.mockResolvedValue({
      sample_rate: 24000,
      pcm: pcm(1000, -1000, 32767),
      duration_ms: 42,
      lexicon_version: 'abc123'
    } as never)
    const audio = await synthesize({ text: ' Hello there. ', voice: 'bf_emma', speed: 1.2 })
    expect(call).toHaveBeenCalledWith(
      'tts_synthesize',
      {
        model_dir: join(app.getPath('userData'), 'tts-models'),
        text: 'Hello there.',
        voice: 'bf_emma',
        speed: 1.2,
        lexicon: []
      },
      SYNTH_TIMEOUT_MS
    )
    expect(audio.sampleRate).toBe(24000)
    expect(audio.durationMs).toBe(42)
    expect(audio.lexiconVersion).toBe('abc123')
    expect(Array.from(new Int16Array(audio.samples.buffer, audio.samples.byteOffset, 3))).toEqual([1000, -1000, 32767])
  })

  it('treats an empty pcm as silence, not an error', async () => {
    call.mockResolvedValue({ sample_rate: 24000, pcm: '', duration_ms: 0, lexicon_version: 'x' } as never)
    const audio = await synthesize({ text: '†', voice: 'af_heart', speed: 1 })
    expect(audio.samples.byteLength).toBe(0)
    expect(audio.durationMs).toBe(0)
  })

  it('surfaces the sidecar\'s refusal as the rejection message', async () => {
    call.mockResolvedValue({ error: 'The voice is not downloaded yet' } as never)
    await expect(synthesize({ text: 'Hi', voice: 'af_heart', speed: 1 })).rejects.toThrow(
      'The voice is not downloaded yet'
    )
  })

  it('clamps the speed before it reaches the sidecar', async () => {
    call.mockResolvedValue({ sample_rate: 24000, pcm: '', duration_ms: 0, lexicon_version: '' } as never)
    await synthesize({ text: 'Hi', voice: 'af_heart', speed: 9 })
    expect(call.mock.calls[0]?.[1]).toMatchObject({ speed: 1.5 })
  })

  it('refuses an unknown voice, empty text and oversize text without calling the sidecar', async () => {
    await expect(synthesize({ text: 'Hi', voice: 'af_sky' as never, speed: 1 })).rejects.toThrow(/voice/i)
    await expect(synthesize({ text: '   ', voice: 'af_heart', speed: 1 })).rejects.toThrow(/nothing to speak/i)
    await expect(
      synthesize({ text: 'a'.repeat(MAX_TEXT_CHARS + 1), voice: 'af_heart', speed: 1 })
    ).rejects.toThrow(/too long/i)
    expect(call).not.toHaveBeenCalled()
  })

  it('rejects, rather than starting nothing, when the metadata engine is unavailable', async () => {
    vi.mocked(sidecar.assertAvailable).mockImplementation(() => {
      throw new Error('Python sidecar is unavailable')
    })
    await expect(synthesize({ text: 'Hi', voice: 'af_heart', speed: 1 })).rejects.toThrow('unavailable')
  })
})

describe('status', () => {
  it('maps the sidecar answer', async () => {
    call.mockResolvedValue({ ready: false, missing: ['voices-v1.0.bin'], total_bytes: 120575669 } as never)
    expect(await status()).toEqual({ ready: false, missing: ['voices-v1.0.bin'], totalBytes: 120575669 })
    expect(call).toHaveBeenCalledWith('tts_model_status', { model_dir: modelDir() })
  })
})

describe('the download', () => {
  it('rebroadcasts the sidecar\'s progress frames in the app\'s spelling', async () => {
    call.mockResolvedValue({ status: 'ready' } as never)
    await downloadModel()
    const handler = vi.mocked(sidecar.onNotification).mock.calls.find((c) => c[0] === 'tts_model_progress')?.[1]
    expect(handler).toBeTypeOf('function')
    handler?.({ job_id: 'j', file: 'a.bin', completed: 5, total: 10 })
    expect(events.broadcast).toHaveBeenCalledWith('ttsModelProgress', {
      jobId: 'j',
      file: 'a.bin',
      completed: 5,
      total: 10
    })
  })

  it('ignores a malformed frame', async () => {
    call.mockResolvedValue({ status: 'ready' } as never)
    await downloadModel()
    const handler = vi.mocked(sidecar.onNotification).mock.calls.find((c) => c[0] === 'tts_model_progress')?.[1]
    handler?.({ file: 'a.bin' })
    handler?.(null)
    expect(events.broadcast).not.toHaveBeenCalled()
  })

  it('runs one download at a time: a second call shares the first', async () => {
    let finish: (v: unknown) => void = () => {}
    call.mockImplementation(() => new Promise((r) => (finish = r)) as never)
    const a = downloadModel()
    const b = downloadModel()
    expect(call).toHaveBeenCalledTimes(1)
    finish({ status: 'ready' })
    expect(await a).toEqual({ status: 'ready' })
    expect(await b).toEqual({ status: 'ready' })
  })

  it('cancels the running job by id, and is a no-op with none running', async () => {
    await cancelDownload()
    expect(call).not.toHaveBeenCalled()

    let finish: (v: unknown) => void = () => {}
    call.mockImplementation(((method: string) =>
      method === 'tts_download_model' ? new Promise((r) => (finish = r)) : Promise.resolve({ cancelled: true })) as never)
    const running = downloadModel()
    const jobId = (call.mock.calls[0]?.[1] as { job_id: string }).job_id
    await cancelDownload()
    expect(call).toHaveBeenCalledWith('tts_cancel_download', { job_id: jobId })
    finish({ status: 'cancelled' })
    expect(await running).toEqual({ status: 'cancelled' })
  })

  it('reports a failed download as a result, not a rejection', async () => {
    call.mockResolvedValue({ status: 'failed', error: 'offline' } as never)
    expect(await downloadModel()).toEqual({ status: 'failed', error: 'offline' })
  })

  it('allows a new download after the last one settled', async () => {
    call.mockResolvedValue({ status: 'ready' } as never)
    await downloadModel()
    await downloadModel()
    expect(call).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 6: Run to verify failure**

Run: `npm test -- electron/main/services/tts.test.ts 2>&1 | tail -6`
Expected: FAIL — cannot resolve `./tts`.

- [ ] **Step 7: Write `electron/main/services/tts.ts`**

```ts
import { randomUUID } from 'crypto'
import { join } from 'path'
import { app } from 'electron'
import {
  TTS_VOICES,
  clampTtsSpeed,
  type TtsAudio,
  type TtsDownloadResult,
  type TtsModelStatus,
  type TtsRequest
} from '@shared/tts.types'
import * as events from './events'
import * as sidecar from './sidecar'

/**
 * The app's one door to the speech engine — the sidecar's `tts_*` methods
 * (docs/superpowers/specs/2026-10-15-voice-reader-design.md, D3/D4).
 *
 * Thin by rule (invariant 8): validation and the shapes between the two worlds, and
 * nothing that a sidecar test already decides. Three choices are worth saying:
 *
 * - **The model lives under `userData`, never in the bundle.** `modelDir()` is the one
 *   place that spells it; the sidecar is told, so it reads no configuration.
 * - **A refusal is a rejection here and `{ error }` there.** The sidecar answers a normal
 *   outcome (no model yet, no pronunciation data) in its result, as the reflow does; the
 *   IPC envelope's `error` is where the renderer reads a sentence, so it is thrown here.
 * - **One download at a time.** A second press shares the first; progress is rebroadcast
 *   on the app's own channel rather than handed to a caller, because the sidecar's frames
 *   arrive whether or not anything awaits the result.
 */

/** A sentence is ~0.3–0.5 s warm. Thirty seconds is a stuck engine, not a slow one. */
export const SYNTH_TIMEOUT_MS = 30_000
/** One sentence, not one chapter: a request this long is a caller bug. */
export const MAX_TEXT_CHARS = 4_000
/**
 * The lexicon is the library's `lexicon.json` (slice 3). Until that service exists there
 * is nothing to read, and this is the one line slice 3 replaces.
 */
const NO_LEXICON: never[] = []

export function modelDir(): string {
  return join(app.getPath('userData'), 'tts-models')
}

interface SidecarAudio {
  sample_rate?: unknown
  pcm?: unknown
  duration_ms?: unknown
  lexicon_version?: unknown
  error?: unknown
}

interface SidecarStatus {
  ready?: unknown
  missing?: unknown
  total_bytes?: unknown
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export async function status(): Promise<TtsModelStatus> {
  sidecar.assertAvailable()
  const answer = await sidecar.call<SidecarStatus>('tts_model_status', { model_dir: modelDir() })
  return {
    ready: answer.ready === true,
    missing: Array.isArray(answer.missing) ? answer.missing.filter((m): m is string => typeof m === 'string') : [],
    totalBytes: count(answer.total_bytes)
  }
}

export async function synthesize(request: TtsRequest): Promise<TtsAudio> {
  if (!(TTS_VOICES as readonly string[]).includes(request.voice)) {
    throw new Error(`Unknown voice: ${String(request.voice)}`)
  }
  const sentence = request.text.trim()
  if (!sentence) throw new Error('There is nothing to speak')
  if (sentence.length > MAX_TEXT_CHARS) throw new Error('That passage is too long to speak at once')
  sidecar.assertAvailable()
  const answer = await sidecar.call<SidecarAudio>(
    'tts_synthesize',
    {
      model_dir: modelDir(),
      text: sentence,
      voice: request.voice,
      speed: clampTtsSpeed(request.speed),
      lexicon: NO_LEXICON
    },
    SYNTH_TIMEOUT_MS
  )
  if (typeof answer.error === 'string' && answer.error) throw new Error(answer.error)
  const bytes = Buffer.from(text(answer.pcm), 'base64')
  return {
    sampleRate: count(answer.sample_rate) || 24000,
    // A copy, not a view: `Buffer.from` may sit in Node's shared pool slab, and structured
    // clone (which Electron's IPC uses) sends a view's *whole* underlying buffer.
    samples: Uint8Array.from(bytes),
    durationMs: count(answer.duration_ms),
    lexiconVersion: text(answer.lexicon_version)
  }
}

let running: { jobId: string; promise: Promise<TtsDownloadResult> } | null = null
let subscribed = false

function subscribeOnce(): void {
  if (subscribed) return
  subscribed = true
  sidecar.onNotification('tts_model_progress', (params) => {
    const frame = (params ?? {}) as Record<string, unknown>
    const jobId = text(frame.job_id)
    const file = text(frame.file)
    if (!jobId || !file) return
    events.broadcast('ttsModelProgress', {
      jobId,
      file,
      completed: count(frame.completed),
      total: count(frame.total)
    })
  })
}

export function downloadModel(): Promise<TtsDownloadResult> {
  if (running) return running.promise
  sidecar.assertAvailable()
  subscribeOnce()
  const jobId = randomUUID()
  const promise = sidecar
    .call<TtsDownloadResult>('tts_download_model', { model_dir: modelDir(), job_id: jobId }, 30 * 60_000)
    .finally(() => {
      if (running?.jobId === jobId) running = null
    })
  running = { jobId, promise }
  return promise
}

export async function cancelDownload(): Promise<void> {
  if (!running) return
  await sidecar.call('tts_cancel_download', { job_id: running.jobId })
}

/** Forget the in-flight download and the subscription. For tests only. */
export function resetForTests(): void {
  running = null
  subscribed = false
}
```

- [ ] **Step 8: Add the event channel the service names**

In `src/types/api.types.ts`, in `EVENT_CHANNELS`, add after `shelvesChanged`:

```ts
  /** The speech model's download progress (voice reader D4). */
  ttsModelProgress: 'event:tts-model-progress'
```
(`shelvesChanged` currently ends the object with no trailing comma; add the comma after it.)

- [ ] **Step 9: Run to verify the service tests pass**

Run: `npm test -- electron/main/services/tts.test.ts src/types/tts.types.test.ts 2>&1 | tail -8`
Expected: all pass (13 + 3).

- [ ] **Step 10: Mutation checks**

(a) In `synthesize` delete the `clampTtsSpeed(...)` call (pass `request.speed`) → the clamp case FAILS. (b) Delete the `if (running) return running.promise` line → the "one download at a time" case FAILS. Restore both.

- [ ] **Step 11: Typecheck**

Run: `npm run typecheck 2>&1 | tail -6`
Expected: clean (the new event channel is not yet in `MusaeumAPI.on`; that is Task 11 and nothing requires it yet).

- [ ] **Step 12: Commit**

```bash
git add src/types/tts.types.ts src/types/tts.types.test.ts src/types/api.types.ts electron/main/services/tts.ts electron/main/services/tts.test.ts
git commit -m "feat(tts): the speech contract and the main-process service

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
(`/verify` first.)

---

### Task 11: IPC, preload and the API surface

**Files:**
- Create: `electron/main/ipc/tts.ts`
- Modify: `src/types/api.types.ts`, `electron/preload/index.ts`, `electron/main/index.ts`

**Interfaces:**
- Consumes: `services/tts` (`status`, `synthesize`, `downloadModel`, `cancelDownload`).
- Produces: channels `tts:status`, `tts:synthesize`, `tts:downloadModel`, `tts:cancelDownload`; `window.musaeum.tts.{status, synthesize, downloadModel, cancelDownload}` and `window.musaeum.on.ttsModelProgress`.

- [ ] **Step 1: Write the handler**

`electron/main/ipc/tts.ts`:

```ts
import type { TtsRequest } from '@shared/tts.types'
import * as tts from '../services/tts'
import { handle } from './handle'

/**
 * The speech engine's door (docs/superpowers/specs/2026-10-15-voice-reader-design.md, D3/D4).
 * Thin by rule (invariant 8): validation, the sidecar call and the progress rebroadcast are
 * all `services/tts.ts`'s, and a refusal reaches the renderer as the envelope's `error`.
 */
export function registerTtsHandlers(): void {
  handle('tts:status', () => tts.status())
  handle('tts:synthesize', (request: TtsRequest) => tts.synthesize(request))
  handle('tts:downloadModel', () => tts.downloadModel())
  handle('tts:cancelDownload', () => tts.cancelDownload())
}
```

- [ ] **Step 2: Register it**

In `electron/main/index.ts`: add `import { registerTtsHandlers } from './ipc/tts'` beside the other `register…Handlers` imports (after the `registerAnnotationHandlers` import, line 16), and add `registerTtsHandlers()` after `registerAiHandlers()` in the block of registrations (line ~221).

- [ ] **Step 3: Extend `MusaeumAPI`**

In `src/types/api.types.ts`: add to the type imports at the top (beside the other `@shared` imports — match the file's existing import style; if it imports from relative `./…` paths, use `./tts.types`):

```ts
import type {
  TtsAudio,
  TtsDownloadProgress,
  TtsDownloadResult,
  TtsModelStatus,
  TtsRequest
} from './tts.types'
```

Add a `tts` group to `MusaeumAPI` directly before `ai: {` (line 395):

```ts
  /** The voice reader's engine (docs/superpowers/specs/2026-10-15-voice-reader-design.md). */
  tts: {
    /** Whether the model files are on disk; cheap (existence and size). */
    status(): Promise<TtsModelStatus>
    /**
     * One sentence → mono 16-bit PCM at 24 kHz. An empty `samples` is silence (text with
     * nothing to say). **Rejects with a sentence** when there is no model yet or the
     * pronunciation data is missing — a normal outcome the bar shows in one line.
     */
    synthesize(request: TtsRequest): Promise<TtsAudio>
    /** Resolves with the outcome; progress arrives as `on.ttsModelProgress`. */
    downloadModel(): Promise<TtsDownloadResult>
    cancelDownload(): Promise<void>
  }
```

Add to the `on` group, after `reflowProgress`:

```ts
    /** The speech model's download progress (voice reader D4). */
    ttsModelProgress(cb: (progress: TtsDownloadProgress) => void): Unsubscribe
```

- [ ] **Step 4: Extend the preload**

In `electron/preload/index.ts`, add the `tts` group before `ai: {`:

```ts
  tts: {
    status: () => invoke('tts:status'),
    synthesize: (request) => invoke('tts:synthesize', request),
    downloadModel: () => invoke('tts:downloadModel'),
    cancelDownload: () => invoke('tts:cancelDownload')
  },
```
and in the `on` group, change the last entry to add a comma and the new line:

```ts
    reflowProgress: (cb) => listen(EVENT_CHANNELS.reflowProgress, cb),
    ttsModelProgress: (cb) => listen(EVENT_CHANNELS.ttsModelProgress, cb)
```

- [ ] **Step 5: Typecheck and fix anything it names**

Run: `npm run typecheck 2>&1 | tail -20`
Expected: clean. **If it reports a test file or mock that builds a whole `MusaeumAPI` and now lacks `tts`/`ttsModelProgress`,** add the two members to that mock in the file's own style (`vi.fn()` or a stub) — do not weaken the `MusaeumAPI` type.

- [ ] **Step 6: Full gates**

Run: `npm run lint 2>&1 | tail -6 && npm test 2>&1 | tail -8`
Expected: lint clean; the suite passes with the Task 1 baseline plus this plan's new cases (the 3 type cases, 13 service cases, 1 invariants case), 0 failed, 0 newly skipped.

- [ ] **Step 7: Prove the bridge against the real sidecar, once**

With the model present, from the repo root:

```bash
MUSAEUM_USER_DATA=$(mktemp -d) sidecar/.venv/bin/python - <<'EOF'
import json, subprocess, sys, base64, os
models = os.path.expanduser("~/Downloads/musaeum-tts-bakeoff/models")
p = subprocess.Popen([sys.executable, "main.py"], cwd="sidecar", stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
req = {"id": "1", "method": "tts_synthesize", "params": {"model_dir": models, "text": "Hegel wrote it in 1807.", "voice": "bm_george", "speed": 1.0,
       "lexicon": [{"word": "Hegel", "sounds_like": "HAY-gul"}]}}
p.stdin.write(json.dumps(req) + "\n"); p.stdin.flush()
out = json.loads(p.stdout.readline())
r = out["result"]
print("error:", out["error"], "| sample_rate:", r["sample_rate"], "| ms:", r["duration_ms"], "| bytes:", len(base64.b64decode(r["pcm"])), "| lexicon_version:", r["lexicon_version"])
p.stdin.close(); p.wait(5)
EOF
```
Expected: `error: None`, `sample_rate: 24000`, a duration of roughly 2500–4500 ms, `bytes` equal to `ms × 48` ± a few, and a non-empty `lexicon_version`. (The app's IPC layer is exercised by the unit suite; the first end-to-end audible check is slice 2's.)

- [ ] **Step 8: Commit**

```bash
git add electron/main/ipc/tts.ts electron/main/index.ts src/types/api.types.ts electron/preload/index.ts
git commit -m "feat(tts): the IPC surface, preload and API for the speech engine

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
(`/verify` first.)

---

### Task 12: Documents — the record, and the spec's five amendments

**Files:**
- Create: `docs/invariants/voice-reader.md`
- Modify: `CLAUDE.md`, `docs/data-contracts.md`, `docs/invariants/files-and-deletion.md`, `docs/superpowers/specs/2026-10-15-voice-reader-design.md`, `tasks.md`, this plan (an annex)

- [ ] **Step 1: Write `docs/invariants/voice-reader.md`**

```markdown
# The voice reader

**Read before:** touching `sidecar/tts/`, `scripts/build-espeak.sh`, the speech model's download, `services/tts.ts`, or anything that speaks a book. Design: `docs/superpowers/specs/2026-10-15-voice-reader-design.md`; the engine's build record: `docs/superpowers/plans/2026-10-15-voice-reader-engine.md`.

## The rules, and what each one cost to learn

- **espeak-ng is the bundle we build, never the pip wheel.** `espeakng-loader` compiles a build machine's data path into its binary (`/Users/runner/work/...`) and espeak calls `exit()` when it cannot read `phontab` there — measured on 0.1.51, 0.2.1 and 0.2.4, and no runtime path rescues it. `scripts/build-espeak.sh` builds 1.52.0 from a pinned tarball; the library takes its data directory at run time (`espeak_Initialize`'s `path`, the directory that *contains* `espeak-ng-data`), so the bundle is relocatable. `find_espeak()` checks for `phontab` itself, so a missing file is a sentence, not a dead process.
- **The bundle ships `en_dict` only** (2.3 MB against 19.8 MB). It rides the existing `helpers/bin` entry in `electron-builder.yml`; `test/invariants.test.ts` pins that entry, because a narrower `from:` ships a build with no pronunciation and no code defect to find — which is exactly what happened once to the layout helper.
- **GPL-3.** espeak-ng is linked dynamically through `ctypes` into a personal app that is not distributed. The day the app is distributed to anyone else, the combination is re-read against the licence before the first copy leaves the machine.
- **Speech has a lane of its own** (`main.TTS_POOL`, one thread). A sentence queued behind a Google Books call is a voice that stutters. CPU contention remains and is measured live, not assumed away.
- **The model is loaded on use and dropped after 300 s idle**, and the idle timer only *tries* the engine's lock, so it can never drop the model under a call in flight. int8 is +167 MB resident and 316 MB after its first sentence (measured); full precision is 570 MB, against a 500 MB target, and was judged no better by ear.
- **The model files are pinned by size and sha256** (`sidecar/tts/models.py`), live under `userData/tts-models/`, and are never in the DMG. A good file is never re-fetched; a corrupt one is replaced; a killed download leaves a `.part` that the next run overwrites.
- **A refusal is `{ "error" }` in the sidecar and a rejection in `services/tts.ts`.** Text with nothing to say is *silence* (empty `pcm`, zero `duration_ms`), never an error, so a footnote marker does not stop a book.
- **Text is normalised for two measured failures only.** espeak reads a decimal point as a sentence end (`3.5 million` → "three. five million") and `$2.1 billion` as "two dollars. one billion". `normalize_text` rewrites decimals and dollar amounts; dates (`3/4/2021`) and clock times (`5:30 p.m.`) are **known gaps**, passed through untouched and recorded rather than half-handled.
- **The lexicon stores what a person typed** ("HAY-gul"; the part in capitals carries the stress), never IPA, and the phonemes are derived at synthesis. Whole words, case-sensitive, possessives handled, hostile entries ignored. The derivation from a respelling was listened to on its own only after the mechanism was approved with hand-written phonemes (spec AC24).
- **No word-level timings.** Neither pinned model has a duration output (`has_timings` is False), so highlighting is per sentence.
- **Highlighting, playback and the lexicon file are slices 2 and 3**, and are not described here until they exist.
```

- [ ] **Step 2: Route it from `CLAUDE.md`**

In the routing table, after the `docs/invariants/menu-and-branding.md` row, add:

```
| `docs/invariants/voice-reader.md` | the speech engine, `scripts/build-espeak.sh`, the speech model's download, anything that speaks a book |
```
In the dev quickstart's code block, after the `./scripts/build-layout-helper.sh` line pair, add:

```bash
./scripts/build-espeak.sh                    # the voice reader's pronunciation data (cmake, git, network);
                                             # without it the TTS pytest cases skip
```

- [ ] **Step 3: Record the sidecar methods in `docs/data-contracts.md`**

Find the `reflow_pdf` block in the sidecar RPC section (`grep -n "reflow_pdf" docs/data-contracts.md`) and add, in the same format and directly after it, entries for the four methods. The content:

- `tts_synthesize` — params `{ model_dir, text, voice?, speed?, lexicon? }` where `lexicon` is `[{ word, sounds_like }]`; result `{ sample_rate: 24000, pcm: <base64 of mono s16le>, duration_ms, lexicon_version }` or `{ error: string }`; runs on its own single-thread lane; empty `pcm` and `duration_ms: 0` mean silence.
- `tts_model_status` — params `{ model_dir }`; result `{ ready, missing: [name], total_bytes }`.
- `tts_download_model` — params `{ model_dir, job_id }`; result `{ status: 'ready' } | { status: 'cancelled' } | { status: 'failed', error }`; emits `tts_model_progress` notifications `{ job_id, file, completed, total }` (bytes across both files).
- `tts_cancel_download` — params `{ job_id }`; result `{ cancelled: true }`; safe before the job starts.

- [ ] **Step 4: Reserve `derived/audio/`**

In `docs/invariants/files-and-deletion.md`, in *The `derived/` folder* section, add one sentence: `{book}/derived/audio/` is reserved for the voice reader's rendering slice (docs/superpowers/specs/2026-10-15-voice-reader-design.md, D9) — nothing writes it yet, and like everything under `derived/` it is disposable and never enters `formats` or `file_size_bytes`.

- [ ] **Step 5: Apply the spec's five amendments**

In `docs/superpowers/specs/2026-10-15-voice-reader-design.md` (read the file first; match each sentence exactly with `Edit`):

1. **D2** — replace "builds a `libespeak-ng.dylib` and its `espeak-ng-data` from a pinned upstream release, with the data path set so the library finds it, and writes them to `helpers/bin/espeak/` (gitignored, like the layout helper)" with: "builds a `libespeak-ng.dylib` and its `espeak-ng-data` from the pinned upstream 1.52.0 release (CMake, English dictionary only — 2.3 MB against 19.8 MB) and writes them to `helpers/bin/espeak/` (gitignored, like the layout helper). Nothing is baked in: the library takes its data directory at run time (`espeak_Initialize`'s `path`), so the bundle is relocatable — the pip wheel's trouble was a build machine's path compiled into its binary. CMake's configure fetches a pinned `sonic` from GitHub, so the *build* (not the app) needs the network and git". Replace "`electron-builder.yml`'s `extraResources` carries the directory." with "The existing `helpers/bin` entry in `electron-builder.yml`'s `extraResources` already carries it; no new entry is needed."
2. **AC4** — replace "`electron-builder.yml` carries the directory; the packaged `Contents/Resources/helpers/bin/espeak/` exists; the DMG grows by less than 5 MB." with "A source-scan case pins the existing `helpers/bin` `extraResources` entry; the packaged `Contents/Resources/helpers/bin/espeak/` exists; the bundle is under 5 MB (2.3 MB measured)." If Task 2 step 5 found the data **not** identical across two builds, also reword AC1's "(two builds, identical data checksum)" to "(built from the pinned tarball; the data checksums are recorded in the annex)".
3. **D3** — replace the method line's camelCase with the wire's actual spelling: "`tts_synthesize({ model_dir, text, voice, speed, lexicon })` → `{ sample_rate: 24000, pcm, duration_ms, lexicon_version }`, snake_case like every other sidecar result (`services/tts.ts` maps it to the camelCase `TtsAudio`), and `lexicon` is the list of `{ word, sounds_like }`". Add: "`kokoro-onnx` 0.6.1 batches input longer than the model's 510-phoneme limit itself, so the engine has no chunker; neither pinned model reports phoneme durations (`has_timings` is False, verified), so highlighting stays per sentence."
4. **New D3b** — after D3, add a section: "## D3b — Text is normalised for two measured failures. espeak-ng reads a decimal point as a sentence end, so `3.5 million` is spoken "three. five million" and `$2.1 billion` "two dollars. one billion" (measured 2026-10-15 on the bundled library). `sidecar/tts/normalize.py` rewrites decimals between digits to " point " and dollar amounts to words, and passes everything else through unchanged. **Known gaps, recorded rather than half-handled:** dates (`3/4/2021` is spoken "three slash four slash …") and clock times (`5:30 p.m.` is spoken "five:thirty pee.em."). **Reversal:** a reader hears one of these often enough to mind, and it gets its own measured rule." Add acceptance criteria 27–30 under Slice 1b: "27. `3.5 million` and `$2.1 billion` are spoken as a person would say them. 28. Text with nothing to say (`†`, `[12]`, `😀`) is silence, not an error. 29. A 1,200-character single sentence is audio, not a crash. 30. A lexicon entry that is empty, duplicated or full of regex metacharacters is ignored or applied, never raised, and `Hegelian` is never read as `Hegel`+`ian`."
5. **Slices table** — replace the `1b` row's scope with "`sidecar/tts/` (engine, normalize, lexicon, models, phonemize), `tts_synthesize` and its lane, the download, `requirements.txt`" and add a row "**1c** | `services/tts.ts` + IPC + preload + types + the progress event | The main-process bridge, decidable by vitest alone; 1b alone was 14 source files and `CLAUDE.md` puts the line at ~10". Add to _What I read_: "Both pinned models have `has_timings = False` (verified 2026-10-15)". In D8 add the respelling convention: "A respelling's part in CAPITALS carries the stress (`HAY-gul`); with none, the first part does."

- [ ] **Step 6: Update `tasks.md`**

The voice reader entry under _Specified, not scheduled_ already names this plan. Append to it: "**Slices 1a–1c are built** (date, branch, the suite counts) and the espeak gate result is in the plan's annex; slices 2 (the reader) and 3 (the lexicon file and popover) are not yet planned." Leave the checkbox open — the feature is not done until slice 2 lands.

- [ ] **Step 7: Write the annex to this plan**

Append a section "## Annex — what the build found" to this file recording, in plain sentences: the slice 1a gate result (from Task 4 step 7), the cold/warm synthesis timings (Task 8 step 7), whether the two espeak builds were byte-identical (Task 2 step 5), what Jason heard from the respelling clips (Task 6 step 6), the baseline and final test counts, and any deviation from this plan with its reason.

- [ ] **Step 8: Verify the documents**

Run: `grep -c "voice-reader" CLAUDE.md` (expect ≥ 1) and `npm test -- test/invariants.test.ts 2>&1 | tail -4` (expect pass). Read `docs/invariants/voice-reader.md` once through for any claim this build did not actually measure; remove it or mark it unverified.

- [ ] **Step 9: Commit**

```bash
git add docs CLAUDE.md tasks.md
git commit -m "docs(voice-reader): the invariants file, the sidecar contract, and the spec's five amendments from the build

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
(Docs only: no `/verify`.)

---

## Self-review against the spec

**Spec coverage.** D1 (Kokoro int8 in the sidecar) → Tasks 1, 7, 8. D2 (own espeak, the gate) → Tasks 2–4. D3 (one RPC, own lane, lifecycle, quiet failure) → Tasks 8–9 and 10. D4 (pinned download) → Task 7 and 10; **the "Download the voice" surface in the bar is slice 2**, as the spec's D4 puts it in the transport bar. D5, D6, D7 (playback, controls, prefs) → **slice 2, not this plan** (only `VoiceSpec`, `TTS_VOICES`, `clampTtsSpeed` are built here, because slice 2 and the service both need them). D8 (the lexicon) → the *engine half* in Task 6 (matching, possessives, respellings, version); `lexicon.json`, its service and the popover are slice 3, and the service's `NO_LEXICON` line is the seam. D9 (no disk cache; seams) → Task 8 returns `lexicon_version`; Task 10 adds `VoiceSpec`; Task 12 reserves `derived/audio/`. D10 → the Global Constraints. AC1–AC4 → Tasks 2–4. AC5 → Task 8 step 6 (the five voices, byte-identical repeat; the "within 5 %" wording is satisfied trivially because the duration is computed from the same array, so the test asserts a plausible range instead, which is the meaningful half). AC6 → Task 6. AC7 → Task 9. AC8 → Task 8. AC9 → Task 7. AC10 → Tasks 8 and 9 step 7. AC11 → Tasks 1 and 9 step 6 and 11 step 6. AC12–AC26 are slices 2 and 3.

**Gaps I chose, stated.** (1) The download's real-network path is not exercised: the tests use a local server, and a real fetch of 120 MB from GitHub is the first thing slice 2's live pass does. (2) `AC21`'s engine half (cold/warm sentence time) is recorded in the annex; the audible half is slice 2. (3) The live behaviour of speech while a bulk refresh runs (risk 3) is not tested here; the lane is, by saturation.

**Placeholder scan.** No TBD or "handle edge cases"; every code step has code. Task 4's invariants test and Task 11's mock fixes tell the executor to adopt the file's own idiom because those two files' exact imports were not read to the character — the instruction names what to match, and the test body is complete.

**Type consistency.** `Entry(word, sounds_like)`, `Lexicon(...).phonemes(text) -> (str, list[Entry])`, `lexicon_version(list[Entry]) -> str`, `SpeechEngine.synthesize(model_dir=, text=, voice=, speed=, lexicon=)`, `synthesize_rpc(params)`, `models.verify/model_status/download_models/cancel_download`, `main.POOL/TTS_POOL/lane_for/dispatch`, and on the TypeScript side `TtsRequest/TtsAudio/TtsModelStatus/TtsDownloadProgress/TtsDownloadResult`, `tts.status/synthesize/downloadModel/cancelDownload`, channel names `tts:status|synthesize|downloadModel|cancelDownload` and the event `ttsModelProgress` / `tts_model_progress` agree across Tasks 6–11.

**Review Focus coverage.** (1) numbers → Task 5; (2) nothing to say → Task 8 (fake and real); (3) long sentence → Task 8 step 6; (4) hostile entries → Task 6; (5) release under a running call → Task 8; (6) killed or corrupt download → Task 7.
