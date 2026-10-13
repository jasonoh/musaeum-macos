# Portable decisions — slice 3: absence is not silence

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A refresh stops treating "no source supplies this field" as "keep what was there": the merge reports the fields it could not supply, and the main process blanks them — but only on a run where a remote source answered.

**Architecture:** D7's split. The sidecar decides, because that is where the candidates live, and reports one new reply member (`missing_fields`); the main process applies the blanks when it assembles the patch (`importer.applyHydration`), because the record's shape is the main process's business and the reply is untrusted input. D4's guard (a remote source answered this run) gates the whole rule, and D3 as written means the locks do **not** exempt a field — a locked field nothing supplies is blanked too.

**Tech Stack:** Python 3.11+ sidecar (pytest, `merge_metadata`/`hydrate_metadata`), TypeScript main process (vitest through Electron-as-Node, `importer.hydrate`/`applyHydration`).

**Spec:** `docs/superpowers/specs/2026-09-20-portable-decisions-design.md` — this plan implements **D4**, **D6**, **D7** and **AC11–AC13** (slice 3). Read it with this plan; where they disagree, the spec's decision wins.

## Global Constraints

- **Slices 1 and 2 are settled — do not re-open them.** The claim map (`owned-fields.ts`) and the per-field reading reconcile (`library-sync.preserveLocalReadingState`) are not in play.
- **Invariants:** 1 (`metadata.json` canonical — this writes it), 8 (the blanking lives in `services/importer.ts`, the IPC handlers gain nothing), 12 (a failure stays non-fatal).
- **The new reply member is optional.** An older sidecar that omits `missing_fields` must degrade to today's add/update-only behavior, never to blanking everything (D7's consequence). The main process treats it as `undefined` = "nothing to blank".
- **D3's clause, confirmed by the owner 2026-10-13:** a lock does **not** protect a field against blanking. AC13's case asserts the locked field *is* blanked when nothing supplies it.
- **Gates at the branch point (`main` @ `4d60602`, 2026-10-13):** `npm run typecheck` 0, `npm run lint` 0, `npm test` **2,132 passed / 97 files**; `sidecar/.venv/bin/python -m pytest sidecar/tests -q` **413 passed** — this slice touches the sidecar, so that number **rises** by the new cases (a sidecar slice's pytest count is allowed to move; it moves up, never down). `npx prettier --check <touched file>` 0. Never `npm run format` (it rewrites vendored files). `npm test` only ever as `npm test`; a single file is `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run <path>`.
- **The app is not launched.** Every AC11–AC13 decider is a service/unit case on both sides.
- Stage named paths only, never `git add -A`. No merge, push or PR unasked.

## Review Focus

The five conditions most likely to bite a person using this, none of which the ACs name directly; each gets its test in the task that owns the code.

1. **A partial answer blanks a field the answering source did not mention.** D4's guard is per *run*, not per field, so a matched Google record with no `publisher` blanks a stored publisher even though the user never asked it to. This is D4's *accepted* residual (spec *Risks* 2) — pinned as *intended* in Task 2, so the behavior is deliberate rather than incidental.
2. **An older sidecar omits `missing_fields`.** Expect nothing blanked (add/update only), never a crash. Pinned by Task 2.
3. **`metadata_sources` present but only `embedded`/`calibre`.** That is not a *remote* answer, so nothing is blanked (D4). Pinned by Task 2.
4. **A book the file still supplies.** A field the file's own metadata carries is a candidate, so it is never reported missing and never blanked — even when it is locked (D3 as written protects the *file's* value, not the lock). Pinned by Task 1.
5. **A field nothing has ever supplied, on a book where a fetch matched.** It is blanked on that same run (AC12). Pinned by Task 1 (the sidecar reports it) and Task 2 (the main process blanks it).

One hazard checked and accepted, not a finding: the literal rule would blank a `title` no source supplies, leaving an untitled book. It requires a remote source to have answered *and* supplied no title — a Google/OpenLibrary match with an empty title, which does not occur on a match — so it is left to the spec's literal rule.

## Decision taken where the spec parks one

**D3's open clause** (does a lock protect a field against the file deleting it?) is confirmed **as written**: a lock does not. A locked field that no source supplies is blanked; a locked field a source *does* supply is not. This is the one line the spec owed before slice 3, and the owner gave it 2026-10-13.

---

### Task 1: The sidecar reports what it could not supply

The merge is the only place that knows which sources had an opinion, so it grows the output: a third return value naming the merge-owned fields no source supplied. The computation **ignores the locks** (D3 as written — a locked field is still absent if nothing supplies it), which is why it lives here rather than in a caller.

**Files:**
- Modify: `sidecar/pipeline/conflict.py` (`merge_metadata`, and a new `MERGE_FIELDS`/`_SUPPLY`/`unsupplied_fields`)
- Modify: `sidecar/pipeline/hydration.py` (`hydrate_metadata`: unpack three, and the `identifiers` exception in the reply)
- Modify: `sidecar/tests/test_conflict.py` (the two-unpack sweep + new cases)
- Modify: `sidecar/tests/test_hydration_locks.py` (the two-unpack sweep + new cases)

**Interfaces:**
- Produces: `merge_metadata(sources, preferences, locked_fields=()) -> (merged, conflicts, missing_fields)` where `missing_fields` is a `list[str]` of `HydratedField` names; `hydrate_metadata`'s reply gains `"missing_fields": [...]`.

- [ ] **Step 1: Write the failing sidecar cases**

In `sidecar/tests/test_conflict.py`, add (the file already imports `merge_metadata` and defines `_book`):

```python
def test_a_field_no_source_supplies_is_reported_missing():
    _, _, missing = merge_metadata({"embedded": _book(title="A")}, {})

    # title is supplied by the one source; everything else the merge owns is not
    assert set(missing) == {
        "author",
        "series",
        "publisher",
        "published_date",
        "language",
        "description",
        "identifiers",
        "tags",
    }


def test_a_locked_field_nothing_supplies_is_still_missing():
    # D3 as written: a lock does not protect a field against the absence rule
    _, _, missing = merge_metadata({"embedded": _book(title="A")}, {}, ["publisher"])

    assert "publisher" in missing


def test_a_locked_field_a_source_supplies_is_not_missing():
    # The file's own value is a supply, so the field is not blanked — the lock
    # does not change that, it only keeps the merge from proposing a *candidate*
    _, _, missing = merge_metadata(
        {"embedded": _book(title="A", publisher="P")}, {}, ["publisher"]
    )

    assert "publisher" not in missing


def test_the_identifier_union_counts_as_a_supply():
    _, _, missing = merge_metadata(
        {"embedded": {"identifiers": {"isbn_13": "9781707274123"}}}, {}
    )

    assert "identifiers" not in missing
```

In `sidecar/tests/test_hydration_locks.py`, add (it defines `_epub`, `_offline`, and imports `hydration`):

```python
def test_the_reply_reports_the_fields_no_source_supplied(tmp_path, monkeypatch):
    path = _epub(tmp_path, "0306406152")
    _offline(monkeypatch)
    book_dir = str(tmp_path / "out")
    os.makedirs(book_dir)

    result = hydration.hydrate_metadata(
        book_id="missing", file_path=path, book_dir=book_dir, known={}, source_preferences={}
    )

    # The file supplies title, identifiers and language; the offline fetches
    # supply nothing, so the rest are reported missing
    assert set(result["missing_fields"]) == {
        "author",
        "series",
        "publisher",
        "published_date",
        "description",
        "tags",
    }
```

- [ ] **Step 2: Run them to verify they fail**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests/test_conflict.py sidecar/tests/test_hydration_locks.py -q`
Expected: FAIL — `merge_metadata` returns two values, so `_, _, missing = …` raises `ValueError: not enough values to unpack`, and `result["missing_fields"]` raises `KeyError`.

- [ ] **Step 3: Implement the sidecar half**

`sidecar/pipeline/conflict.py` — add the vocabulary and the supply table beside `REVIEWED_FIELDS`, and return a third value:

```python
# The fields the merge owns — a field no source supplies is blanked by the main
# process (portable-decisions D6/D7), so the vocabulary is stated here once, in
# the same names the locks use (`HydratedField` in the TS types).
MERGE_FIELDS = (
    "title",
    "author",
    "series",
    "publisher",
    "published_date",
    "language",
    "description",
    "identifiers",
    "tags",
)

# One supply test per field, matching the value each merge branch reads.
_SUPPLY = {
    "title": lambda d: d.get("title"),
    "author": lambda d: (d.get("authors") or [{}])[0].get("name"),
    "series": lambda d: d.get("series"),
    "publisher": lambda d: d.get("publisher"),
    "published_date": lambda d: d.get("published_date"),
    "language": lambda d: d.get("language"),
    "description": lambda d: d.get("description"),
    "identifiers": lambda d: d.get("identifiers"),
    "tags": lambda d: d.get("tags"),
}


def unsupplied_fields(sources: dict) -> list:
    """The merge-owned fields no source had a value for.

    Computed over the raw sources and **ignoring the lock** (D3 as written): a
    locked field is still absent when nothing supplies it, so it is blanked all
    the same — the lock only keeps the merge from proposing a candidate.
    """
    return [
        field
        for field in MERGE_FIELDS
        if not any(data and _SUPPLY[field](data) for data in sources.values())
    ]
```

and change the end of `merge_metadata` from `return merged, conflicts` to:

```python
    return merged, conflicts, unsupplied_fields(sources)
```

`sidecar/pipeline/hydration.py` — unpack three and put the member on the reply:

```python
    merged, conflicts, missing = merge_metadata(sources, source_preferences, locked)

    # Identifiers baked into the file (or seeded from Calibre) are definitive —
    # online fetches may match a different edition of the same work. Not when
    # the user owns this field: then their value is the definitive one.
    if identifiers and "identifiers" not in locked:
        merged.setdefault("identifiers", {}).update(identifiers)
    # …and a supply the union saw, so it is not reported missing even locked
    if identifiers:
        missing = [f for f in missing if f != "identifiers"]
```

and the reply gains the member:

```python
    return {
        "metadata": merged,
        "conflicts": conflicts,
        "cover": cover_result["cover"],
        "missing_fields": missing,
    }
```

- [ ] **Step 4: Sweep the two-unpack call sites**

Every existing `merge_metadata(...)` unpacking in `sidecar/tests/test_conflict.py` and `sidecar/tests/test_hydration_locks.py` binds two values and now raises. Add a third binding to each: `merged, conflicts = …` → `merged, conflicts, _ = …`, `merged, _ = …` → `merged, _, _ = …`, `_, conflicts = …` → `_, conflicts, _ = …`. Indexing call sites (`merge_metadata(sources, {})[0]["title"]`) need no change. Do not alter any assertion.

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests/test_conflict.py sidecar/tests/test_hydration_locks.py -q`
Expected: PASS.

- [ ] **Step 5: Run the whole pytest suite**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests -q`
Expected: PASS, count up by the new cases from the 413 baseline (no existing test removed).

- [ ] **Step 6: Commit**

```bash
git add sidecar/pipeline/conflict.py sidecar/pipeline/hydration.py sidecar/tests/test_conflict.py sidecar/tests/test_hydration_locks.py
git commit -m "audit(PD3): the merge reports the fields no source supplied"
```

---

### Task 2: The main process blanks what the merge could not supply

The record's shape is the main process's business, and the reply is untrusted input, so the blanking is applied where the patch is assembled — `importer.applyHydration`, which already folds the sidecar's cover in. D4's guard gates the whole rule.

**Files:**
- Modify: `electron/main/services/importer.ts` (`HydrationResult` at `:82-106`; the blank map and guard near `HYDRATION_KEY_FIELD` at `:474`; `applyHydration` at `:514-565`)
- Modify: `electron/main/services/importer.test.ts` (the `reply` helper at `:99-103` and `HydrationReply` at `:86`; new cases)

**Interfaces:**
- Consumes: the sidecar's `"missing_fields"` (Task 1).
- Produces: `HydrationResult.missing_fields?: string[]`; the blanking inside `applyHydration`, reported through its returned `HydratedField[]`.

- [ ] **Step 1: Write the failing cases**

In `electron/main/services/importer.test.ts`, extend the local `HydrationReply` (line 86) with `missing_fields?: string[]`, and `reply` (line 99):

```ts
function reply(
  metadata: Record<string, unknown> = {},
  cover: HydrationReply['cover'] = null,
  missing_fields: string[] = []
): HydrationReply {
  return { metadata, conflicts: [], cover, missing_fields }
}
```

Add a describe (the harness — `hydrate`, `sidecar.call`, `getBook`, `updateBook`, `insertBook`, `makeBook` — is already imported by the file):

```ts
describe('hydrate — absence is not silence (D6)', () => {
  const REMOTE = { google_books: { fetched_at: '2026-10-13T09:00:00Z', match_confidence: 0.9 } }

  it('blanks a field no source supplied when a remote source answered', async () => {
    updateBook('a', { publisher: 'Stale House' })
    vi.mocked(sidecar.call).mockResolvedValue(
      reply({ title: 'Book a', metadata_sources: REMOTE }, null, ['publisher'])
    )

    const outcome = await hydrate('a', join(dir, 'Book a.epub'), dir)

    expect(getBook('a')?.publisher).toBeNull()
    expect(outcome).toMatchObject({ ok: true })
    expect(outcome.changed).toContain('publisher')
  })

  it('leaves the field alone when no remote source answered (D4)', async () => {
    updateBook('a', { publisher: 'Kept House' })
    // embedded and calibre are local sources; neither is a remote answer
    vi.mocked(sidecar.call).mockResolvedValue(
      reply(
        {
          title: 'Book a',
          metadata_sources: { embedded: { fetched_at: '2026-10-13T09:00:00Z', match_confidence: 1 } }
        },
        null,
        ['publisher']
      )
    )

    const outcome = await hydrate('a', join(dir, 'Book a.epub'), dir)

    expect(getBook('a')?.publisher).toBe('Kept House')
    expect(outcome.changed).not.toContain('publisher')
  })

  it('blanks a locked field nothing supplied (D3 as written)', async () => {
    // The user claimed the field; nothing in the reply supplies it
    updateBook('a', { publisher: 'User Chose This' })
    await setFieldOverride('a', 'publisher')
    vi.mocked(sidecar.call).mockResolvedValue(
      reply({ title: 'Book a', metadata_sources: REMOTE }, null, ['publisher'])
    )

    await hydrate('a', join(dir, 'Book a.epub'), dir)

    expect(getBook('a')?.publisher).toBeNull()
  })

  it('blanks nothing when the sidecar omits the member', async () => {
    updateBook('a', { publisher: 'Kept House' })
    const noMember = reply({ title: 'Book a', metadata_sources: REMOTE })
    delete (noMember as { missing_fields?: string[] }).missing_fields
    vi.mocked(sidecar.call).mockResolvedValue(noMember)

    const outcome = await hydrate('a', join(dir, 'Book a.epub'), dir)

    expect(getBook('a')?.publisher).toBe('Kept House')
    expect(outcome.changed).not.toContain('publisher')
  })

  it('names what it blanked, so the blast radius is visible (spec Risk 2)', async () => {
    updateBook('a', { publisher: 'Stale House' })
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.mocked(sidecar.call).mockResolvedValue(
      reply({ title: 'Book a', metadata_sources: REMOTE }, null, ['publisher'])
    )

    await hydrate('a', join(dir, 'Book a.epub'), dir)

    const logged = info.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toContain('publisher')
    expect(logged).toContain('Stale House')
  })
})
```

If `setFieldOverride` is not the override module's exported name, use whatever the file's existing "a field the user has overridden" describe (`:340`) uses to lock a field — reuse that helper, do not invent one.

- [ ] **Step 2: Run them to verify they fail**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run electron/main/services/importer.test.ts -t "absence is not silence"`
Expected: FAIL — `publisher` is never blanked (nothing reads `missing_fields` yet).

- [ ] **Step 3: Implement the main-process half**

`electron/main/services/importer.ts` — extend `HydrationResult` (after `cover`):

```ts
  /**
   * The merge-owned fields no source supplied, from the sidecar's own candidate
   * view. The main process blanks these unless the run had no remote answer
   * (D4/D6). Optional: a sidecar too old to report it means "blank nothing",
   * never "blank everything" (D7).
   */
  missing_fields?: string[]
```

Add the guard and the blank map beside `HYDRATION_KEY_FIELD` (`:474`):

```ts
/** Who counts as a *remote* answer — the sources D4's guard keys on. */
const REMOTE_SOURCES = new Set(['google_books', 'openlibrary', 'goodreads'])

/**
 * Whether this run heard from a remote source at all. `metadata_sources` is
 * written only by sources that fetched (the conflict merge stamps `fetched_at`
 * on the online ones), so an empty or local-only map means every remote fetch
 * failed — and a failed fetch says nothing, so it must blank nothing (D4).
 */
function heardFromRemoteSource(
  sources: HydrationResult['metadata']['metadata_sources']
): boolean {
  return !!sources && Object.keys(sources).some((name) => REMOTE_SOURCES.has(name))
}

/** What a blanked `HydratedField` clears, and to what. `cover` is absent on purpose — a cover is selected, never blanked. */
const BLANK_FIELD: Partial<Record<HydratedField, Partial<Book>>> = {
  title: { title: null, sortTitle: null },
  author: { author: null, authorSort: null },
  series: { seriesName: null, seriesIndex: null, seriesTotal: null },
  description: { description: null },
  publisher: { publisher: null },
  published_date: { publishedDate: null },
  language: { language: null },
  identifiers: { isbn10: null, isbn13: null, goodreadsId: null, openlibraryId: null },
  tags: { tags: [] }
}
```

Confirm `HydratedField` is imported in `importer.ts` (it imports `HYDRATED_KEY_FIELD` from `@shared/metadata.types` at `:16`; add `type HydratedField` to that import if it is not already there). Then in `applyHydration`, immediately before `db.updateBook(bookId, updates)` (`:559`):

```ts
  // D6/D7: the merge owns the fields it supplies, so a field with no candidate
  // is written blank — but only when a remote source answered this run (D4),
  // because a run whose fetches all failed has no opinion to blank against.
  if (heardFromRemoteSource(result.metadata.metadata_sources)) {
    for (const field of result.missing_fields ?? []) {
      const blank = BLANK_FIELD[field as HydratedField]
      if (!blank) continue
      const previous = Object.entries(blank)
        .filter(([key, value]) => !sameBookValue(before[key as keyof Book], value))
        .map(([key]) => `${key}=${JSON.stringify(before[key as keyof Book])}`)
      for (const [key, value] of Object.entries(blank)) set(key as keyof Book, value)
      // Spec Risk 2: D6 is destructive by design, so the blast radius is named
      // in the log — the field and what it held — not only felt as a surprise.
      if (previous.length) {
        console.info(`[hydrate] blanked ${field} on ${bookId}: ${previous.join(', ')}`)
      }
    }
  }
```

(`before` is the row read at the top of `applyHydration`; `m` is the local alias `const m = result.metadata` already in scope at `:516` — if the block is placed where `m` is not in scope, use `result.metadata.metadata_sources`.) A blanked field flows through `set`, so it is reported in `changed` when the value really moved, and `db.updateBook` writes it.

- [ ] **Step 4: Run the cases, then the branch gates**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run electron/main/services/importer.test.ts`
Expected: PASS, including the four new cases and every pre-existing hydrate case.

Run: `npm run typecheck && npm run lint && npm test`
Expected: EXIT 0, 0, 0.

- [ ] **Step 5: Commit**

```bash
git add electron/main/services/importer.ts electron/main/services/importer.test.ts
git commit -m "audit(PD3): the main process blanks what no source supplied, guarded by D4"
```

---

### Task 3: The contract and the record

The reply's new member is an external contract (documented), and the invariant doc states the rule the two halves now enforce.

**Files:**
- Modify: `docs/data-contracts.md` (the sidecar reply / `hydrate_metadata` section, near `:272`)
- Modify: `docs/invariants/metadata-hydration.md` (the pipeline + conflict policy, `:33-38`)
- Modify: `docs/superpowers/specs/2026-09-20-portable-decisions-design.md` (the `Status` line and a `Built — slice 3` section)
- Modify: `tasks.md` (the Portable decisions bullet)
- Modify: `CHANGELOG.md` (a user-facing line — unlike slices 1–2, this one changes what a refresh does)

- [ ] **Step 1: Document the reply member**

In `docs/data-contracts.md`, under the Sidecar Methods section (by the `hydrate_metadata` row / the reflow detail paragraph), add a paragraph: `hydrate_metadata`'s result now carries `missing_fields` — the `HydratedField` names (same vocabulary as the overrides) that no source supplied this run. The main process blanks those fields when the row is written, **unless** the run had no remote source in `metadata_sources` (D4); an older sidecar omits the member, which reads as "blank nothing".

- [ ] **Step 2: State the rule in the invariant**

In `docs/invariants/metadata-hydration.md`, add to the conflict-policy block (or a new paragraph after it): a field the merge could not supply is written blank rather than kept, guarded by a remote-source answer (D4), and a lock does not exempt a field (D3 as written) — the lock stops a fetch proposing a *candidate*, not the absence rule.

- [ ] **Step 3: Record the slice**

Update the spec's `**Status:**` line (slices 1–3 built) and add a `## Built — slice 3` section with this run's gate numbers, the D3 confirmation, and the files touched; update `tasks.md`'s Portable decisions bullet to say slice 3 built (the design is complete).

- [ ] **Step 4: A user-facing line**

In `CHANGELOG.md`, add a line under the current unreleased heading (match the file's existing style): a re-fetch now clears a field no source supplies any more, instead of keeping the stale value — and it does not when every remote fetch failed.

- [ ] **Step 5: Run the gates and commit**

Run: `npm run typecheck && npm run lint && npm test` → EXIT 0, 0, 0
Run: `sidecar/.venv/bin/python -m pytest sidecar/tests -q` → PASS (count up by Task 1's cases)

```bash
git add docs/data-contracts.md docs/invariants/metadata-hydration.md docs/superpowers/specs/2026-09-20-portable-decisions-design.md docs/superpowers/plans/2026-10-13-portable-decisions-slice3.md tasks.md CHANGELOG.md
git commit -m "docs(PD3): slice 3 built — absence is not silence"
```

---

## Self-Review

**Spec coverage.** **D7** (the sidecar gains the output; the main process blanks) → Tasks 1 and 2. **D6** (a field with no candidate is blanked; nothing is retained merely because it was in the row) → Task 2. **D4** (only a run that heard from a remote source may blank) → Task 2's guard and its case. **D3 as written** (a lock does not block the absence rule) → Task 1's `unsupplied_fields` ignoring the lock, Task 2's locked-field case. **AC11** (an OPF dropping `publisher`: blanked with a source answering, untouched without one) → Task 2 Steps 1 and 3. **AC12** (a never-supplied field blanked; a file-supplied field never blanked) → Task 1's supply predicate and cases. **AC13** (a locked field blanked when nothing supplies it) → Task 2's locked case. **D7's "an older sidecar degrades to add/update only"** → Task 2's omitted-member case.

**Placeholder scan.** No "TBD"/"handle edge cases"/"similar to Task N"; every step carries the code or the exact edit. The one open reference — the override-locking helper's exact name in `importer.test.ts` — is deliberately delegated to reuse of the file's own existing helper rather than a guessed name.

**Type consistency.** `HydratedField` (TS) and `MERGE_FIELDS` (Python) carry the same nine names; the reply key `missing_fields` is the same string on both sides; `HydrationResult.missing_fields?: string[]` is read only through `?? []`.

**Spec Risk 2's mitigation** (a report naming the fields blanked and their previous values) → Task 2 Step 3's log line, pinned by Task 2 Step 1's `console.info` case.

**Review Focus coverage.** 1 → Task 2 Step 1 (the remote-answer blank case, named as the accepted residual in the code comment). 2 → Task 2 Step 1 (the omitted-member case). 3 → Task 2 Step 1 (the local-only `metadata_sources` case). 4 → Task 1 Step 1 (the file-supplied locked field). 5 → Task 1 Step 1 (the never-supplied field) and Task 2 Step 1 (it is blanked).
