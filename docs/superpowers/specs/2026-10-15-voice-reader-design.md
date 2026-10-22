# Design: The voice reader — listen to a book in the app, in a good free voice

**Date:** 2026-10-15
**Status:** Design approved section by section with Jason on 2026-10-15; the written spec was approved by him the same day, and the engine half (slices 1a–1c) is planned in `docs/superpowers/plans/2026-10-15-voice-reader-engine.md`. **Five amendments found while planning — the espeak data path (D2), the bundle size (AC4), snake_case RPC names (D3), the missing chunker (D3), and a new text-normalization step (D3b) — are listed in that plan and have been applied to this document. **Slices 1a–1c, the engine, are built and merged to `main` (2026-10-15). Slice 2, the reader half (Listen button, bar, sentence highlight, Read from here), is built and live-verified on `feat/voice-reader-ui` (2026-10-15; the outcomes are marked on AC12–AC21 below, and the build record is the annex of `docs/superpowers/plans/2026-10-15-voice-reader-ui.md`) with open items listed in `tasks.md` (AC21 cold, which fails its target on its worst run, plus the others there, including the Previous and Read from here residuals). Slice 3, the lexicon, is built and gated (2026-10-22; its annex is `docs/superpowers/plans/2026-10-22-voice-reader-lexicon.md`, which carries the readings R1–R9, the AC table with each row's decider, and the _Built — slice 3_ record). **AC24 is met: Jason listened to the five respelling-derived clips on 2026-10-22 and judged them correct**, so the substitution D8 named as unverified is settled; the verdict is in this document's _Outcomes, slice 3_ table and in the annex. What is still open from slice 3 is AC25's **live pass** — the popover's wiring is pinned by a source walk, but nothing has rendered it in the running app yet. The build found more, recorded in the plan's annex: the normalizer also strips asterisks, bracketed citation numbers and emoji, and punctuation-only text is silence. The voice was chosen by ear on the same day (see _What I read_), and the engine fork (D1) was settled with him: **live first, rendering supported later**.
**Scope:** Reading a book aloud inside the Mac reader: a Listen control, a transport bar, sentence-level highlighting that carries the page along, a voice and a speed, and a library-wide pronunciation lexicon so names are read correctly. Speech is synthesized locally, offline, for free, by Kokoro-82M (int8) in the Python sidecar. It does **not** cover rendering a book to an audio file, streaming audio to the phone, word-level highlighting, media keys or a sleep timer (see _Rejected and deferred_). It is designed so that rendering is an additive slice (D9).
**Depends on:** `docs/invariants/reader.md` (the reader, foliate-js, the reflow's D10 — the reader learns nothing about PDFs), `docs/invariants/packaging-and-python.md` (the managed venv, `extraResources`, the Swift helper's precedent), `docs/invariants/shelves.md` (the shape of a library-level JSON file), `docs/invariants/settings-and-editing.md` (persisted UI state), `docs/invariants/files-and-deletion.md` → _The `derived/` folder_.
**Interacts with:** `sidecar/main.py` (one new method and a lane), `sidecar/requirements.txt` (two pins), `electron-builder.yml` (a bundled library), `electron/main/services/` (a new `tts.ts`, a new `lexicon.ts`), `src/components/reader/` (the engine arm, the header, a bar, the selection chip), `src/lib/theme/reader-palette.ts` (one role), and `stores/reader.store.ts` (two prefs).
**Supersedes:** nothing. It revives no deferred item; `tasks.md` has never carried a voice reader.

---

## Why now

The reader is complete for EPUB, MOBI, AZW3 and — through the reflow — PDF. The one way to read a book it cannot do is to read it _to_ you, and the library is 6,300 books that a person might well want to hear while doing the dishes. The pieces are unusually cheap: the vendored engine already splits a page into marked sentences (`vendor/foliate-js/tts.js`, reached by `view.initTTS`), the sidecar already hosts long Python jobs, and a free local voice good enough to listen to for hours now exists. What was missing was a measurement, and it was taken on 2026-10-15.

---

## What I read, and what it means for the design

| Fact | Where | Consequence |
| --- | --- | --- |
| Foliate's `TTS` yields **SSML per block** with a `<mark name="N"/>` before each unit at the chosen granularity; `setMark(name)` highlights that unit and, by default, scrolls it into view. It synthesizes nothing | `vendor/foliate-js/tts.js`, `view.js:584-592` | The engine's text, order and highlight are free. The voice is ours. `'sentence'` granularity is the unit (D5) |
| `initTTS` binds to the **current section's document** and re-binds when it changes | `view.js:585-587` | Crossing a section boundary is ours to drive (D5) |
| Listened-to bytes are cheap: int8 Kokoro, loaded, is **+167 MB resident, 316 MB after the first sentence**; full precision is 570 MB. Load **0.3–0.4 s**; one short sentence **0.27 s (int8)** against 0.52 s | measured 2026-10-15, M-series, CPU only, `onnxruntime` 1.31 | The model is loaded on use and dropped after silence (D3). The app's memory target is 500 MB, so full precision is out |
| Throughput on this machine, CPU only, three ~20 s passages: **≈ 8.5× realtime (fp32), ≈ 13× (int8)** | same | Live needs a buffer of two sentences. A 10-hour book renders in about 45 minutes (int8) — a job, not a wait |
| Jason listened to 14 voices on three hard passages and chose **`af_heart`, `af_bella`, `bf_emma`, `bm_george`, `am_michael`**; he found int8 "pretty much the same" as full precision | listening, 2026-10-15 | The voice list is those five; the model is int8 (D1, D7) |
| Apple's system voices, including the Enhanced and Premium ones he downloaded (Zoe, Jamie, Allison, Evan), sound worse than Kokoro but read names correctly | listening, 2026-10-15 | They are not the engine. Whether `speechSynthesis` even exposes them inside Electron was **not** tested (_Not verified_) |
| Kokoro's phonemizer, espeak-ng, reads `Hegel` as `hˈɛdʒəl` (_HEDGE-ul_) and `Kojève` as `kˈoʊdʒv`; `Okafor` (`ˈɑːkæfɚ`) and `Nietzsche` (`nˈiːtʃə`) are acceptable | measured 2026-10-15 | A pronunciation lexicon is part of the feature, not polish (D8) |
| Hand-written phonemes spliced in at the word boundary for those two words were judged **"excellent" and natural-sounding** by Jason, on four voices | listening, 2026-10-15 | The lexicon mechanism is proven end to end (D8) |
| **The pip-packaged espeak-ng cannot find its own data.** `espeakng-loader` 0.1.51, 0.2.1 and 0.2.4 all call `exit()` on a `phontab` path of the _build machine_ (`/Users/runner/work/...`); passing the real path through `phonemizer`, `ESPEAK_DATA_PATH`, or a direct `espeak_Initialize` call does not help. Patching the binary's baked string to a relative path made it work | measured 2026-10-15 | We cannot ship the pip wheel's library. D2 builds and bundles espeak-ng ourselves, and makes proving it the first gate |
| `misaki[en]` (Kokoro's own phonemizer) avoids espeak but **pulls in PyTorch** and prints `❓` for any name outside its dictionary (`Okafor's`) | measured 2026-10-15 | Rejected: wrong size, wrong failure mode for a book full of names |
| Both pinned models have `has_timings = False` | verified 2026-10-15 | Highlighting is per sentence (D3) |
| espeak-ng is **GPL-3** | upstream | Bundling it is fine for a personal app and is a licensing fact to be written down; see D2 |
| The sidecar runs a shared `ThreadPoolExecutor(max_workers=4)` for hydration, conversion, covers and the reflow | `sidecar/main.py:150` | Speech gets its own lane, or a bulk refresh makes it stutter (D3) |
| A packaged build installs sidecar requirements into `userData/sidecar-venv` on first launch and re-runs when the file's hash changes; pins are exact | `docs/invariants/packaging-and-python.md:24-28` | `kokoro-onnx` and `onnxruntime` are exact pins; the marker's hash changes once |
| A native helper already ships as `extraResources` (`helpers/bin/musaeum-layout`, built by `scripts/build-layout-helper.sh`), and **its absence from the bundle once broke every book with no code defect to find** | `packaging-and-python.md:29` | The espeak build ships the same way, and a packaged-app check is an acceptance criterion, not a hope |
| Library-level JSON files have a settled discipline: random-id `.part` rename, never overwrite what cannot be read, carry unknown keys, assert online before a write | `docs/invariants/shelves.md` | `lexicon.json` is a third file of that kind (D8) |
| The reader keeps one side slot with one occupant at a time | `ReaderView.tsx:437` | Listening is a bar, not a panel (D6) |

---

## The design in one paragraph

A **Listen** button in the reader header opens a transport bar. Pressing play takes the foliate engine's marked sentences for the visible page, asks the main process to synthesize each one — a thin `services/tts.ts` forwarding to a new sidecar method, `tts_synthesize`, which phonemizes the sentence (applying the library's pronunciation lexicon), runs Kokoro-82M int8 on a dedicated single-thread lane, and returns 24 kHz PCM — and plays them gaplessly through the Web Audio clock with two sentences prefetched. As each sentence begins, the engine highlights it and the page follows the voice, so the existing position save records listening as reading. Names are fixed by a `lexicon.json` in the library, edited from the selection chip with an instant preview. The model (92 MB) is downloaded on first use, checksummed, and unloaded after five idle minutes; espeak-ng is built by us and bundled.

---

## D1 — Kokoro-82M int8, in the sidecar, behind one RPC

**Decision.** Synthesis runs in the Python sidecar with `kokoro-onnx` over `onnxruntime`, using the **int8** model and the shared `voices-v1.0.bin`.

**Alternatives, and why not:** *(B) `kokoro-js` in the renderer* — it needs a CSP that permits WebAssembly and a model served over `musaeum://`, puts heavy compute in the renderer against invariant 8, is slower on CPU, and rendering a book later would need a hidden window. *(C) Apple's voices through `speechSynthesis`* — Jason's ears ruled it out as the engine; it stays a possible fallback and is not built. *(D) PyTorch Kokoro* — hundreds of megabytes of dependency for the same voice. *(E) Piper* — measurably more robotic in the sources read, and its upstream was archived in late 2025.

**Reversal:** if `kokoro-onnx` is abandoned or the int8 model is withdrawn, the model file is a pinned asset (D4) and the engine is one module (`sidecar/tts/engine.py`) with a two-function surface, so a replacement changes that module and the pin and nothing else.

## D2 — espeak-ng is built by us and bundled; proving it is the first gate

**Decision.** `scripts/build-espeak.sh` builds a `libespeak-ng.dylib` and its `espeak-ng-data` from the pinned upstream 1.52.0 release (CMake, English dictionary only — 1.4 MB against 19.8 MB) and writes them to `helpers/bin/espeak/` (gitignored, like the layout helper). Nothing is baked in: the library takes its data directory at run time (`espeak_Initialize`'s `path`), so the bundle is relocatable — the pip wheel's trouble was a build machine's path compiled into its binary. CMake's configure fetches a pinned `sonic` from GitHub, so the *build* (not the app) needs the network and git. The existing `helpers/bin` entry in `electron-builder.yml`'s `extraResources` already carries it; no new entry is needed. `sidecar/tts/phonemize.py` resolves it the way `vision.find_helper()` resolves the Swift helper — one relative path that a dev tree and a bundle agree on — with an environment override for experiments. The pip `espeakng-loader` is installed transitively by `kokoro-onnx` (its tokenizer imports it) and never used: our code always passes both `lib_path` and `data_path`, and never loads its library.

**The gate.** Slice 1a proves, on a **packaged** build on an isolated profile, that the bundled library phonemizes `Hegel`, before any other slice's code is written. If it cannot be made to work, that is an escalation under `CLAUDE.md`, not a reason to fall back to a PyTorch phonemizer or to a pronunciation-blind voice: the feature stops and is handed back.

**Licence.** espeak-ng is GPL-3 and is linked dynamically through `ctypes`. Musaeum is a personal app that is not distributed, so this is a recorded fact and not a blocker. **Reversal / trigger:** the day the app is distributed to anyone else, the combination is re-read against the licence before the first copy leaves the machine, and this paragraph is the pointer.

## D3 — `tts_synthesize`: one method, its own lane, loaded on use

**The method.** `tts_synthesize({ model_dir, text, voice, speed, lexicon })` → `{ sample_rate: 24000, pcm, duration_ms, lexicon_version }`, snake_case like every other sidecar result (`services/tts.ts` maps it to the camelCase `TtsAudio`), where `pcm` is base64 of mono signed 16-bit samples. `lexicon` is the list of `{ word, sounds_like }` the caller read from the library file (D8); the sidecar reads no library file, so the method stays pure. A sentence is a few hundred kilobytes; this is within what the JSON-RPC pipe already carries for a reflow progress frame many times over.

**The lane.** `tts_synthesize` runs on its **own single-thread executor**, not the shared four. A bulk refresh that saturates the pool would otherwise queue a sentence behind a Google Books call and the voice would stall. CPU contention remains (the model's own threads), and is measured in the live pass rather than assumed away. `tts_model_status` and `tts_cancel_download` run on a two-thread control lane so they are never queued behind a saturated shared pool; `tts_download_model` stays on the shared pool.

**Lifecycle.** The model loads on the first call and is released after **five idle minutes**. Idle cost is zero; playing costs ≈ 316 MB resident (measured). Load is 0.3–0.4 s, so the first sentence of a session is the slowest and is covered by the prefetch.

**Failure is quiet and total.** A missing model, a failed load or a phonemizer error returns `{ error }` in the envelope and never throws across the boundary (invariant 12 by analogy). The bar shows one line and offers a retry; nothing else in the reader changes.

**Chunking and timings.** `kokoro-onnx` 0.6.1 batches input longer than the model's 510-phoneme limit itself, so the engine has no chunker; neither pinned model reports phoneme durations (`has_timings` is False, verified), so highlighting stays per sentence.

## D3b — Text is normalised for the failures we measured

espeak-ng reads a decimal point as a sentence end, so `3.5 million` is spoken "three. five million" and `$2.1 billion` "two dollars. one billion" (measured 2026-10-15 on the bundled library). `sidecar/tts/normalize.py` rewrites decimals between digits to " point " and dollar amounts to words. The build then found three more, measured on the real bundled espeak and the real model the same day: `***` is voiced "asterisk asterisk asterisk", `[12]` "twelve" and `😀` "grinning face", so `normalize_text` also removes every `*`, bracketed citation numbers (`[12]`, `[1,2]`, `[3-5]`; `[sic]` is untouched) and emoji and pictographs (the U+2600–27BF dingbats range included, plus the variation selector and ZWJ). Text whose phonemes contain no alphabetic character (`...`, `—`, `?`, `“”`, `( )`) is silence too, because the model otherwise renders a 260–550 ms non-word noise. Everything else passes through unchanged.

**Known over-strip, recorded:** the dingbat range also strips ✝ ♀ ♂ ☉ ☿ ☞ ♪ ♥, misses ⭐ ⌚ ‼️ ℹ️, and `2*3` becomes `23`. **Known gaps, recorded rather than half-handled:** dates (`3/4/2021` is spoken "three slash four slash …") and clock times (`5:30 p.m.` is spoken "five:thirty pee.em."). **Reversal:** a reader hears one of these often enough to mind, and it gets its own measured rule.

## D4 — The model is downloaded on first use, pinned, and never in the DMG

**Decision.** `models/kokoro-v1.0.int8.onnx` (**92,361,271 bytes**, sha256 `6e742170d309016e5891a994e1ce1559c702a2ccd0075e67ef7157974f6406cb`) and `voices-v1.0.bin` (**28,214,398 bytes**, sha256 `bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d`) come from the `thewh1teagle/kokoro-onnx` release `model-files-v1.0` into `userData/tts-models/`. Both are verified against their pinned hash before first use and are re-downloaded if the hash fails. They are not in the DMG: 120 MB would more than double it for a feature a user may never open.

**Surface.** The first press of Listen with no model shows "Download the voice (120 MB)" with progress and a cancel, in the transport bar. Offline with no model is one honest sentence, not an error toast. Settings gains no section in v1.

**Why the hash is in this document.** It was computed from the files Jason's listening test used on 2026-10-15, so the voices he approved are the voices this pins.

**Reversal:** if the release is removed or re-tagged, the pin turns into a download failure with a clear message (never a silent substitute), and the files move to a location we control. The hash makes that a copy, not a re-evaluation.

## D5 — Playback: foliate's marked sentences, a two-sentence prefetch, the Web Audio clock

**Decision.** `ReaderEngine` gains a speech arm that calls `view.initTTS('sentence', highlight)` for the current section and drives its `start()` / `next()` / `from(range)` / `setMark(name)`. The SSML each returns is flattened by a pure function (`src/lib/speech-queue.ts`) into `{ mark, text, blockEnd }` units — SSML the book itself carries (`<phoneme>`, `<sub>`) is reduced to its text, because Kokoro takes none. The player asks main for sentence _n+1_ and _n+2_ while _n_ plays and schedules the returned buffers on one `AudioContext` clock, so there is no gap and no timer in the audible path. Pause is `suspend()`, resume is `resume()`; neither re-synthesizes.

**Amendments found building slice 2 (2026-10-15).** (1) The highlight scrolls with `scrollToAnchor(range, false)`, not the engine's default or `true`, and only when the sentence is off the page: `true` selects each sentence, raising the Highlight chip and feeding the ask panel on every sentence, and scrolling every sentence wipes a selection the user holds and restarts the position-save debounce. (2) Prefetch never crosses a block boundary and the *player* gates it: foliate's `next()` rebuilds its range map, so the next block is not taken until the last sentence of the old one has started. (3) A *section* is not advanced until the old section's last sentence has **ended** (`PlayerSource.ended(unit)`); advancing when it started jumped the page 6.9 s early. (4) A restart on a page turn drops sentences that start before the page, because `tts.from()` returns the whole block from its first sentence when the page opens inside the block's last sentence. (5) Escape gains a rung: search results, the panels, the listen bar, the book (D6 was silent). Rules and measurements: `docs/invariants/voice-reader.md`.

**Pauses are the player's, not the voice's:** ≈ 350 ms after a sentence, ≈ 700 ms after a block.

**The highlight and the page.** `setMark` highlights the sentence and, by the engine's default highlight, scrolls it into view — so the page follows the voice with no new navigation code. The visible highlight is drawn by a new `speech` role in the derived reader palette, in the same way as `search` (`src/lib/theme/reader-palette.ts`), so it follows every theme and both page schemes.

**Section boundaries.** When a section's blocks are exhausted the engine advances to the next section, waits for `load`, re-initializes and continues. The end of the book stops playback and leaves the bar in its idle state.

**Manual navigation.** A page turn, a table-of-contents jump or a search jump while speaking moves speech to the first sentence of the page now shown. That is what a person who turned the page means, and it is the one rule here that is a judgment; the reversal is to keep speaking from the old place until told otherwise.

**Reading position.** Speech advances pages through the engine, so `onRelocate` fires as it does for a hand turn and `reading-state.saveProgress` records the position. Listening counts as reading, and travels to the phone, with no new code. It is a claim this spec makes and an acceptance criterion tests it.

**PDF.** A reflowed PDF is an EPUB to the engine (reflow D10), and works. Nothing in this arm may branch on the source format.

**Background.** The point of the feature includes a window that is not in front. Chromium throttles timers in a hidden window; the design depends on audio being scheduled on the audio clock and two sentences ahead, not on a timer. _Whether that holds with the window minimized is checked in the live pass (AC20), not assumed._

## D6 — Controls: a Listen button and a bar, not a panel

**Decision.** A **Listen** button in the reader header (a hand-rolled SVG in `icons.tsx`, no icon library) toggles a slim transport bar along the bottom edge: previous sentence, play/pause, next sentence, speed, voice, close. The selection chip gains **Read from here**. The bar is not the side slot's fifth occupant, because that slot holds one panel at a time and a person listening to a book should not have to close their notes or their search to do it.

**Keys.** Space and the arrows keep their page-turn meaning. Listening gets its own toggle key, chosen in the plan so it collides with nothing in `selection-and-keyboard.md`'s map.

## D7 — Voice and speed are reader prefs, per machine

**Decision.** `voice` (one of the five) and `speed` (0.8–1.5, step 0.1, default 1.0) live in `reader.store.ts`'s `ReaderPrefs`, are persisted per machine like typography, and are re-validated on read by `sanitizePrefs` — an unknown voice falls back to `af_heart`, a speed out of range is clamped. They travel to the sidecar in every `tts_synthesize` call, so a change takes effect on the next sentence.

**The five are the five Jason chose.** More of Kokoro's 54 voices are available; they are not listed because nobody has listened to them. **Reversal:** a request for a voice not on the list.

## D8 — The lexicon: `lexicon.json`, respellings, a preview

**The file.** `{library root}/lexicon.json`, a sibling of `shelves.json`, `{ "version": 1, "entries": [ { "word", "soundsLike", "addedAt" } ] }`. It follows the shelves file's discipline in full: `.part` scratch files with a random id renamed into place; a file that exists but does not parse, or has an unknown `version`, is never rewritten and every mutation refuses with one verbatim sentence; unknown keys and unknown entry shapes are carried through; every write asserts the library online. It needs **no adoption path and no SQLite cache** — its read path is the share, so it reaches another Mac by being read when speech starts, as the annotations file does, and a changed file (by mtime) is re-read.

**Why a respelling, not phonemes.** Nobody should have to write IPA. The file stores what a person typed ("HAY-gul"); the sidecar derives phonemes when it speaks, with the bundled espeak, and caches them by word. The file is human-readable, portable, and does not freeze a phonemizer version into a library.

**Respelling convention.** A respelling's part in CAPITALS carries the stress (`HAY-gul`); with none, the first part does.

**Scope.** Per library, not per book. **Reversal:** two books that need different readings of one spelling; then an optional per-book overlay.

**Matching.** Whole words, case-sensitive, with the possessive handled (`Okafor's` uses `Okafor`'s entry and the correct plural-like suffix). The possessive and the apostrophe variants (`'` and `’`) are where this goes wrong first, and have their own cases.

**The popover.** Select a word, choose **Pronounce…** in the selection chip. A small popover shows the word, a "sounds like" field, a **Preview** button that speaks the respelling in the current voice at once, and **Save**; an existing entry opens in the same popover with **Delete**. Preview is the safeguard — a respelling can come out slightly wrong and the cure is hearing it, not reasoning about it.

**Offline.** Speech keeps using the last copy it read when the share drops. Edits are refused, like every other library write (`assertOnline`).

**Proven.** The mechanism — splice hand-written phonemes at the word boundary, phonemize the rest, hand Kokoro the whole — was listened to on four voices on 2026-10-15 and judged correct and natural. This design replaces "hand-written" with "derived from a respelling" and that substitution is **not** yet listened to (_Not verified_; AC24).

## D9 — No disk cache in v1; what rendering will need, built now

**Decision.** v1 keeps the last ~50 sentences in the renderer's memory so that stepping back does not re-synthesize. There is **no disk cache**. The cache arrives with rendering, where it pays.

**A correction to what was said while designing this.** Live reading takes its sentences from foliate's segmentation in a DOM; rendering a whole book has to extract text without a reader open, with its own splitter in the sidecar. The two segmentations will differ, so their cache keys will not match and **listening will not warm a later render**. What live and render share is the synth function, the voices, the lexicon, and the key scheme.

**The seams built now, so rendering is additive:**

1. `tts_synthesize` takes plain text and options and knows nothing of the reader.
2. Every result carries a `lexiconVersion` — a hash of the entries that applied — which a rendered file's stamp will need.
3. Voice, speed and model are one `VoiceSpec` type in `src/types/`.
4. `{book}/derived/audio/` is reserved in `docs/invariants/files-and-deletion.md` and **nothing is written there**.
5. When rendering lands it is a per-section, resumable, cancelable job in the pattern of the bulk refresh, compressed with macOS `afconvert`, stamped (voice, speed, lexicon hash, model version, source stamp), and a stale stamp is never served.

**The phone** reaches a rendered file through an additive `format=audio` route; nothing goes on the wire in v1 (`docs/rest-api.md` is untouched).

## D10 — What does not change

No SQLite migration, no `metadata.json` or `catalog.json` change, no new `musaeum://` host (audio travels over IPC as PCM), no wire change, no edit to `vendor/`, no change to the reflow or to what a PDF is. No CSP change is expected, since Web Audio buffers are not subject to `media-src`; that expectation is checked at AC18.

---

## Acceptance criteria

### Slice 1a — the espeak gate (build and bundle, nothing else)

1. `scripts/build-espeak.sh` builds a library and data directory from a pinned upstream tag into `helpers/bin/espeak/`, reproducibly (two builds, identical data checksum).
2. A pytest case loads the bundled library through `sidecar/tts/phonemize.py` and phonemizes `Hegel`, `Kojève` and `Okafor's` to non-empty IPA; it fails when the data directory is moved aside (the failure is the baked-path bug this slice exists to prevent).
3. **A packaged build on an isolated profile phonemizes `Hegel`.** This criterion is the slice's decider; the unit case above is not a substitute, which is the lesson of the layout helper.
4. A source-scan case pins the existing `helpers/bin` `extraResources` entry; the packaged `Contents/Resources/helpers/bin/espeak/` exists; the bundle is under 5 MB (1.4 MB measured).

### Slice 1b — the engine and the RPC

5. `tts_synthesize` returns 24 kHz mono 16-bit PCM whose duration is within 5 % of `durationMs`, for each of the five voices; a repeat call with the same input is byte-identical (the property a later cache stamp needs).
6. The lexicon is applied: with `{ Hegel, "hay-gul" }` the phoneme string differs from without, and a word not in the lexicon is unchanged. A possessive uses its base word's entry.
7. The method runs on its own lane: with the shared pool saturated by four blocked jobs, a `tts_synthesize` call still completes, and `tts_model_status` / `tts_cancel_download` likewise.
8. The model loads on the first call and is released after the idle period (a test seam for the clock, as the reflow's progress tests have); a call after release loads again.
9. The model download verifies both hashes, rejects a corrupted file and re-downloads it, reports progress, and cancels cleanly. It writes only under `userData/tts-models/`.
10. No model, offline → one sentence, no throw. A failed load → `{ error }`, and the next call retries.
11. `requirements.txt` gains exactly two exact pins; the marker's hash changes; typecheck, lint, vitest and pytest are clean and no previously passing case is skipped.
27. `3.5 million` and `$2.1 billion` are spoken as a person would say them.
28. Text with nothing to say (`†`, `[12]`, `😀`, `***`, `...`) is silence, not an error.
29. A 1,200-character single sentence is audio, not a crash.
30. A lexicon entry that is empty, duplicated or full of regex metacharacters is ignored or applied, never raised, and `Hegelian` is never read as `Hegel`+`ian`.

### Slice 2 — live playback

12. `speech-queue` flattens real foliate SSML (taken from a real EPUB block, not a synthetic string) into ordered `{ mark, text, blockEnd }` units; book-carried `<phoneme>` and `<sub>` reduce to text; an empty block yields nothing.
13. The player plays sentences gaplessly: with synthesis latency simulated at 0.5 s and a two-sentence prefetch, the audio clock shows no gap greater than the configured pause.
14. Pause then resume continues from the same sentence without re-synthesizing it; previous/next move one sentence (as built, Previous never crosses a paragraph and replays the sounding sentence from a block's first or last sentence; see the outcome row); speed and voice changes apply from the next sentence.
15. The highlight follows the voice and the page follows the highlight, across a page boundary and a section boundary, in the running app on a real EPUB, a real MOBI and a reflowed PDF.
16. `onRelocate` fires as speech advances, and a position saved by listening is the position the library reopens at (the existing reading-state cases are re-run unchanged).
17. A page turn, a TOC jump and a search jump while speaking each restart speech at the new page's first sentence.
18. The bar opens beside an open side panel without closing it; no CSP violation is logged in the console during a listen.
19. The `speech` palette role exists in every built-in theme and in the derived palette, and has a contrast decider like `search`'s.
20. **Window minimized or hidden: speech continues for at least ten minutes without a gap.** This is a live check; if it fails the design's background premise is wrong and this document is amended before anything ships.
21. First sentence of a session is audible within 2 s of pressing play with the model cold, and within 1 s warm (measured, recorded).

**Outcomes, slice 2 (built and live-verified 2026-10-15 on `feat/voice-reader-ui`; EPUB *Darwin's Devices*, AZW3 *Yellowface*, reflowed PDFs *Attention is All You Need* and *Politics, Philosophy, Culture*; isolated profiles).**

| AC | Outcome |
| --- | --- |
| 12 | Met. `speech-queue` flattens a captured real SSML fixture; CDATA, quoted `>` and bad numeric entities are handled |
| 13 | Met. The player test simulates 0.5 s latency with a two-sentence prefetch and finds no gap beyond the configured pause |
| 14 | **Partly met.** Met in tests: pause and resume without re-synthesis, Next, spec changes from the next sentence. Previous is overstated: `skip()` never crosses a block, and from a block's last or first sentence it replays the sounding sentence rather than stepping back (pressing again keeps replaying), so in fiction with one-sentence paragraphs it is effectively replay |
| 15 | **Met after a fix.** Page boundary: the highlight starts 37 to 57 ms (median) after the buffer, max 101 ms, over 330 sentences, on all three formats. Section boundary failed on the first pass (the page moved as the old section's last sentence *began*); fixed by `ended()` and re-measured: 6 of 6 crossings, the page moves 20 to 51 ms after the end (before `7b85e42`; the post-fix re-run measured 60 ms and 45 ms), the next sentence is audible 698 to 702 ms after it |
| 16 | Met. The saved `reading_position` and `metadata.json` equal the CFI listening reached. Reopen lands one page early, which a control with no speech shows is pre-existing (7 to 6, 8 to 7) |
| 17 | **Met after a fix.** TOC jump (808 ms), search jumps (3 of 3) and a turn during the first sentence passed. ArrowRight failed 13 of 24 trials near figures and captions (Darwin chapter 4, pages 6 to 7: 10 of 10 failed); after the fix 10 of 10 on that page and 23 of 23 mixed turns |
| 18 | Met. The bar stays open beside ToC, search, notes and ask; 0 CSP violations during a listen (a positive control was caught); `AudioContext.state` was `running` at the first `start()` |
| 19 | Met. The `speech` role exists in every built-in theme; `derive.test.ts` sweeps all of them (minimum 3.032 against the 3.0 floor) |
| 20 | **Met.** Minimized 600 s and hidden 180 s without a gap (invariants file for the numbers) |
| 21 | **Warm met, cold not met.** Cold: 1,796, 1,529 and 3,192 ms, median 1.80 s, **worst 3.19 s against the 2 s target**. Warm: 656, 777 and 124 ms, median 0.66 s against 1 s |

**AC21 cold is an open item, stated plainly.** The median passes and the worst run does not. The worst run's first sentence was long ("Richard Ellis, in his book Sea Dragons, notes that Conybeare...") and the fresh app had not loaded the model, so the model load and a long synthesis both sat in front of the first audible sample. Two options, neither built: pre-warm the model (load it when the bar opens, or when a book opens, instead of on the first Play), or split a long first sentence so the first audible chunk is short. Three cold runs are a small sample; the choice is the owner's.

### Slice 3 — the lexicon

22. `lexicon.json` write discipline holds: `.part` with a random id; an unparseable file or unknown `version` is not rewritten and refuses with the verbatim sentence; unknown keys and entry shapes survive a write; an offline write refuses.
23. Matching: whole word, case-sensitive; `Okafor's` and `Okafor’s` both use `Okafor`; `Hegelian` is not matched by `Hegel`.
24. **The respelling-derived phonemes for `Hegel` and `Kojève` are listened to by Jason and judged correct** — the substitution D8 names as not yet verified.
25. The popover adds, previews, edits and deletes; Preview speaks the respelling in the current voice before saving.
26. A changed `lexicon.json` is picked up by a running session without a restart.

**Outcomes, slice 3 (built and gated 2026-10-22; annex `docs/superpowers/plans/2026-10-22-voice-reader-lexicon.md`).**

| AC  | Outcome                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 22  | Met. `lexicon-file.test.ts` pins the parse/refuse/atomic halves and `lexicon.test.ts` the offline refusal and the untouched bytes; unknown keys and unknown entry shapes survive a write, measured on the file itself                  |
| 23  | Met, and **not by this slice**: the matcher is `sidecar/tts/lexicon.py`'s, decided by `test_tts_lexicon.py` (whole word, case-sensitive, both possessives, `Hegelian` ≠ `Hegel`, hostile entries)                                      |
| 24  | **Met on the owner's ear, 2026-10-22.** Five clips rendered through the synthesis body Preview uses — `Hegel` and `Kojève` plain against respelled (`HAY-gul`, `ko-ZHEV`), plus one sentence — listened to by Jason and judged correct |
| 25  | Wired and pinned by `pronounce-surface.test.ts` (the chip's third button, the field, Preview's own call before any save, Delete only for a word with an entry, the popover's `app-no-drag`); the live pass in the app is **not run**   |
| 26  | Met. `lexicon.test.ts`: a save's own entry is spoken by the next `spokenEntries()` with no restart, and a file written out of band is re-read by its mtime; an unreadable one keeps serving the last good copy                         |

---

## Slices, and why they are cut this way

| Slice | What | Why this cut |
| --- | --- | --- |
| **1a** | The espeak build, the bundle, the packaged-app proof | The single thing that can stop the feature, and the thing the layout helper taught us can be wrong with no defect to find. Nothing else is written until it passes |
| **1b** | `sidecar/tts/` (engine, normalize, lexicon, models, phonemize), `tts_synthesize` and its lane, the download, `requirements.txt` | The engine is decidable by pytest alone, with no renderer |
| **1c** | `services/tts.ts` + IPC + preload + types + the progress event | The main-process bridge, decidable by vitest alone; 1b alone was 14 source files and `CLAUDE.md` puts the line at ~10 |
| **2** | The speech arm, the queue, the player, the bar, the header button, the chip's **Read from here**, the prefs, the palette role | Needs a running app for AC15–21; the last slice that can be gated without the lexicon |
| **3** | `lexicon.json`, `services/lexicon.ts`, the popover | Independent of slice 2's player except for Preview, which is why it is third |

Slices 1b, 2 and 3 are each inside the ~10-file bound; slice 2 is the closest and the plan counts it honestly (the speech arm, the queue, the player, the bar, the header, the chip, the store, the palette, the icon, plus tests). **Rendering is a separate spec and a separate trigger**, below.

---

## Rejected and deferred, with the condition that would revive each

- **Word-level highlighting.** The ONNX Kokoro returns no durations. Revived if a build exposes them or a forced-alignment step proves cheap enough to run on every sentence.
- **Rendering a book to audio (an m4b or per-section m4a).** Seams are built (D9). Revived by its own spec when Jason wants to listen on a device that is not the Mac — the Boox Palma and the phone are the named cases.
- **Streaming rendered audio to the phone.** Depends on rendering. An additive `format=audio` route.
- **macOS media keys and Now Playing.** Revived by the first time the keyboard's play key is reached for.
- **A sleep timer.** Cheap, and unrequested. Revived by being asked for.
- **Per-book lexicon overlays; a Settings list of all pronunciations.** The popover edits and deletes an entry the word is selected for. A list is revived by a library with more entries than anyone can remember.
- **Apple voices as a fallback engine.** Revived if a first-run with no network and no model matters.
- **More than five voices.** Revived by a request for a particular one.
- **Full-precision model.** Rejected on memory (570 MB against a 500 MB target) and by ear (int8 judged the same). Revived by a listener who hears the difference.

---

## Risks, stated plainly

1. **The espeak build may not be reproducible or may not work inside a signed bundle.** It is the first slice and the first gate for that reason (D2).
2. **A hidden window may throttle the audio's scheduling** (AC20). The design leans on the audio clock; if that is not enough, the fix is a larger prefetch, and if that is not enough the premise of "keeps speaking in the background" is wrong and this document says so.
3. **The sidecar's CPU is shared in fact if not in threads.** A bulk refresh running while speech plays may slow synthesis below the buffer's margin. AC13 simulates latency; AC21 measures it live; neither runs it alongside a bulk job, and that case is recorded in the plan.
4. **The possessive and the apostrophe variants** are the likeliest place for the lexicon to be quietly wrong (D8).
5. **A respelling can produce a wrong sound** with no error to show for it. Preview is the cure and the user is the decider.

---

## Not verified

- That `speechSynthesis` in Electron exposes the Enhanced and Premium voices (never tested; not needed unless the Apple fallback is revived).
- ~~That a respelling run through the bundled espeak yields phonemes as good as the hand-written ones~~ — listened to by Jason on 2026-10-15 (`HAY-gul`, `ko-ZHEV`; `af_heart`, `bm_george`) and judged fine. AC24 holds for the engine's derivation; the lexicon popover (slice 3) still has to show it.
- ~~That speech survives a minimized window (AC20)~~ — measured 2026-10-15: 600 s minimized and 180 s hidden, no gap (see AC20 above). Risk 3 (a bulk refresh running alongside) was measured only lightly: synthesis median 621 ms against 260 ms idle, and the bulk job was network-bound, so heavy CPU contention is still **not verified**.
- ~~That no CSP change is needed (AC18)~~ — none was needed; 0 violations during a listen (2026-10-15).
- ~~The first real model download~~ — measured 2026-10-15: 120,575,669 bytes in 3.70 s, both hashes matched, cancel clean.
- AC21 cold (above): the worst run misses the target.
- That the bundled espeak works in a **signed** build. It is verified in a packaged but unsigned build (`Hegel` → `hˈɛdʒəl`, 2026-10-15, plan annex); signing and notarization have not been run against it.
- Kokoro's 54-voice list beyond the five Jason heard, and any voice's behaviour on non-English text. The spec is English.
- The throughput numbers are one machine, one run, three short passages. They bound the design and are not benchmarks.
