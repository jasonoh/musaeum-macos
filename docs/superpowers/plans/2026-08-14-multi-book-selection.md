# Multi-Book Selection and Bulk Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user select many books in either library view and act on the whole selection — delete, send to a device, or re-hydrate metadata.

**Architecture:** A pure selection-grammar module (`src/lib/selection.ts`) owns every gesture rule; `ui.store` holds one `Selection` slice and delegates to it; views call one action and never compute set math. The three bulk actions are deliberately asymmetric because the services under them are: delete gains a batched main-process operation, send is a store-level loop over an already-serial queue, and re-hydrate becomes a sequential cancellable job.

**Tech Stack:** Electron, React 18, TypeScript (strict), Zustand, Tailwind, better-sqlite3, Vitest (run through Electron-as-Node).

**Spec:** `docs/superpowers/specs/2026-08-14-multi-book-selection-design.md`

## Global Constraints

- **TypeScript strict; no `any`.** Shared types live in `src/types/`.
- **Business logic never lives in an IPC handler** — handlers in `electron/main/ipc/` are thin wrappers over `electron/main/services/`.
- **Run tests only via `npm test`.** It sets `ELECTRON_RUN_AS_NODE=1` so the better-sqlite3 native ABI matches. Never invoke `vitest` directly.
- **`npm run typecheck && npm run lint` must pass** before every commit.
- **`ListView`'s `ROW_HEIGHT` is 37 and must not change.** Every cell carries explicit leading and a **block-level** child; an inline child inherits the table's line strut and silently grows the row, which shows up as scroll drift, not a build error.
- **`GridView`'s row geometry is computed from constants, not measured.** Do not change `BookCard`'s cover box or meta block.
- **Icons are the hand-rolled set** in `src/components/shared/icons.tsx`. No icon library. `CheckIcon` already exists.
- **Never call NAS/file operations from the renderer** — always via IPC.
- Existing exported names used throughout: `librarySync.writeFullCatalog()`, `librarySync.upsertCatalog(books)`, `nas.assertOnline()`, `nas.isOnline()`, `nas.getLibraryRoot()`, `db.getBook(id)`, `db.deleteBook(id)`, `broadcast(channel, payload?)`.
- Commit after every task with the message given in that task's final step.

---

### Task 1: Selection grammar module

The whole gesture rule set, pure and testable with no React, no DOM, no Electron. Every later task depends on these names.

**Files:**
- Create: `src/lib/selection.ts`
- Test: `src/lib/selection.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Selection { ids: ReadonlySet<string>; anchor: string | null; cursor: string | null }`
  - `const EMPTY_SELECTION: Selection`
  - `interface ClickModifiers { toggle: boolean; range: boolean }`
  - `modifiersFrom(e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): ClickModifiers`
  - `applyClick(sel: Selection, id: string, mods: ClickModifiers, order: readonly string[]): Selection`
  - `toggleOne(sel: Selection, id: string): Selection`
  - `extendTo(sel: Selection, id: string, order: readonly string[]): Selection`
  - `selectAll(sel: Selection, order: readonly string[]): Selection`
  - `clear(): Selection`
  - `prune(sel: Selection, existing: readonly string[]): Selection`
  - `selectedId(sel: Selection): string | null`

- [ ] **Step 1: Write the failing test**

Create `src/lib/selection.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  EMPTY_SELECTION,
  applyClick,
  clear,
  extendTo,
  modifiersFrom,
  prune,
  selectAll,
  selectedId,
  toggleOne,
  type Selection
} from './selection'

const ORDER = ['a', 'b', 'c', 'd', 'e']
const PLAIN = { toggle: false, range: false }
const TOGGLE = { toggle: true, range: false }
const RANGE = { toggle: false, range: true }
const TOGGLE_RANGE = { toggle: true, range: true }

/** Selections are compared by content; Sets don't compare structurally. */
function ids(sel: Selection): string[] {
  return [...sel.ids]
}

describe('modifiersFrom', () => {
  it('maps meta and ctrl to toggle, shift to range', () => {
    expect(modifiersFrom({ metaKey: true, ctrlKey: false, shiftKey: false })).toEqual(TOGGLE)
    expect(modifiersFrom({ metaKey: false, ctrlKey: true, shiftKey: false })).toEqual(TOGGLE)
    expect(modifiersFrom({ metaKey: false, ctrlKey: false, shiftKey: true })).toEqual(RANGE)
    expect(modifiersFrom({ metaKey: true, ctrlKey: false, shiftKey: true })).toEqual(TOGGLE_RANGE)
  })
})

describe('applyClick', () => {
  it('replaces the selection on a plain click and sets both anchor and cursor', () => {
    const sel = applyClick(EMPTY_SELECTION, 'c', PLAIN, ORDER)
    expect(ids(sel)).toEqual(['c'])
    expect(sel.anchor).toBe('c')
    expect(sel.cursor).toBe('c')
  })

  it('replaces a multi-selection on a plain click', () => {
    let sel = applyClick(EMPTY_SELECTION, 'a', PLAIN, ORDER)
    sel = applyClick(sel, 'c', TOGGLE, ORDER)
    sel = applyClick(sel, 'e', PLAIN, ORDER)
    expect(ids(sel)).toEqual(['e'])
  })

  it('adds with a toggle click and moves the anchor to it', () => {
    let sel = applyClick(EMPTY_SELECTION, 'a', PLAIN, ORDER)
    sel = applyClick(sel, 'd', TOGGLE, ORDER)
    expect(ids(sel).sort()).toEqual(['a', 'd'])
    expect(sel.anchor).toBe('d')
  })

  it('removes an already-selected book on a toggle click', () => {
    let sel = applyClick(EMPTY_SELECTION, 'a', PLAIN, ORDER)
    sel = applyClick(sel, 'd', TOGGLE, ORDER)
    sel = applyClick(sel, 'a', TOGGLE, ORDER)
    expect(ids(sel)).toEqual(['d'])
  })

  it('toggling the only selected book leaves nothing selected', () => {
    let sel = applyClick(EMPTY_SELECTION, 'a', PLAIN, ORDER)
    sel = applyClick(sel, 'a', TOGGLE, ORDER)
    expect(ids(sel)).toEqual([])
  })

  it('selects the range from the anchor on a shift click', () => {
    let sel = applyClick(EMPTY_SELECTION, 'b', PLAIN, ORDER)
    sel = applyClick(sel, 'd', RANGE, ORDER)
    expect(ids(sel)).toEqual(['b', 'c', 'd'])
  })

  it('ranges backwards too', () => {
    let sel = applyClick(EMPTY_SELECTION, 'd', PLAIN, ORDER)
    sel = applyClick(sel, 'b', RANGE, ORDER)
    expect(ids(sel)).toEqual(['b', 'c', 'd'])
  })

  it('re-ranges from the same anchor instead of creeping', () => {
    let sel = applyClick(EMPTY_SELECTION, 'b', PLAIN, ORDER)
    sel = applyClick(sel, 'd', RANGE, ORDER)
    sel = applyClick(sel, 'c', RANGE, ORDER)
    expect(ids(sel)).toEqual(['b', 'c'])
    expect(sel.anchor).toBe('b')
    expect(sel.cursor).toBe('c')
  })

  it('unions the range with the existing selection on a toggle-range click', () => {
    let sel = applyClick(EMPTY_SELECTION, 'a', PLAIN, ORDER)
    sel = applyClick(sel, 'd', TOGGLE, ORDER)
    sel = applyClick(sel, 'e', TOGGLE_RANGE, ORDER)
    expect(ids(sel).sort()).toEqual(['a', 'd', 'e'])
  })

  it('degrades a shift click with no anchor to a plain click', () => {
    const sel = applyClick(EMPTY_SELECTION, 'c', RANGE, ORDER)
    expect(ids(sel)).toEqual(['c'])
    expect(sel.anchor).toBe('c')
  })

  it('ranges over the given display order, so a re-sort changes what is adjacent', () => {
    let sel = applyClick(EMPTY_SELECTION, 'b', PLAIN, ORDER)
    sel = applyClick(sel, 'd', RANGE, ['e', 'd', 'c', 'b', 'a'])
    expect(ids(sel)).toEqual(['d', 'c', 'b'])
  })

  it('selects just the target when the anchor is no longer in the order', () => {
    const stale: Selection = { ids: new Set(['z']), anchor: 'z', cursor: 'z' }
    const sel = applyClick(stale, 'c', RANGE, ORDER)
    expect(ids(sel)).toEqual(['c'])
  })

  it('ranges to the first and last books', () => {
    let sel = applyClick(EMPTY_SELECTION, 'c', PLAIN, ORDER)
    expect(ids(applyClick(sel, 'a', RANGE, ORDER))).toEqual(['a', 'b', 'c'])
    expect(ids(applyClick(sel, 'e', RANGE, ORDER))).toEqual(['c', 'd', 'e'])
  })
})

describe('toggleOne', () => {
  it('adds, then removes, and always claims the anchor', () => {
    const added = toggleOne(EMPTY_SELECTION, 'b')
    expect(ids(added)).toEqual(['b'])
    expect(added.anchor).toBe('b')
    expect(ids(toggleOne(added, 'b'))).toEqual([])
  })
})

describe('extendTo', () => {
  it('extends from the anchor and moves only the cursor', () => {
    let sel = applyClick(EMPTY_SELECTION, 'b', PLAIN, ORDER)
    sel = extendTo(sel, 'd', ORDER)
    expect(ids(sel)).toEqual(['b', 'c', 'd'])
    expect(sel.anchor).toBe('b')
    expect(sel.cursor).toBe('d')
  })
})

describe('selectAll', () => {
  it('selects every book in order and leaves anchor and cursor alone', () => {
    const sel = selectAll(applyClick(EMPTY_SELECTION, 'c', PLAIN, ORDER), ORDER)
    expect(ids(sel).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(sel.anchor).toBe('c')
    expect(sel.cursor).toBe('c')
  })
})

describe('clear', () => {
  it('empties everything', () => {
    const sel = clear()
    expect(ids(sel)).toEqual([])
    expect(sel.anchor).toBeNull()
    expect(sel.cursor).toBeNull()
  })
})

describe('prune', () => {
  it('drops ids that no longer exist', () => {
    let sel = applyClick(EMPTY_SELECTION, 'a', PLAIN, ORDER)
    sel = applyClick(sel, 'd', TOGGLE, ORDER)
    expect(ids(prune(sel, ['a', 'b']))).toEqual(['a'])
  })

  it('nulls an anchor and cursor that no longer exist', () => {
    const sel = applyClick(EMPTY_SELECTION, 'd', PLAIN, ORDER)
    const pruned = prune(sel, ['a', 'b'])
    expect(pruned.anchor).toBeNull()
    expect(pruned.cursor).toBeNull()
  })

  it('returns the same object when nothing changed, so stores can skip a render', () => {
    const sel = applyClick(EMPTY_SELECTION, 'a', PLAIN, ORDER)
    expect(prune(sel, ORDER)).toBe(sel)
  })
})

describe('selectedId', () => {
  it('is the id when exactly one is selected, and null otherwise', () => {
    const one = applyClick(EMPTY_SELECTION, 'a', PLAIN, ORDER)
    expect(selectedId(one)).toBe('a')
    expect(selectedId(EMPTY_SELECTION)).toBeNull()
    expect(selectedId(applyClick(one, 'b', TOGGLE, ORDER))).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/selection.test.ts` Expected: FAIL — cannot resolve `./selection`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/selection.ts`:

```ts
/**
 * The library's selection grammar, as pure functions.
 *
 * All of it lives here rather than in the views because the rules are subtle
 * — the anchor/cursor split below is the difference between shift-clicking
 * that re-ranges and shift-clicking that creeps — and because this way they
 * are testable with no React, no DOM and no Electron.
 *
 * `order` is always the ids of the books *as currently displayed*, so a range
 * follows what the user can see after a re-sort or a filter change.
 */

export interface Selection {
  ids: ReadonlySet<string>
  /** Range pivot. Set by plain and toggle clicks; range clicks leave it. */
  anchor: string | null
  /** Keyboard focus / ensure-visible target. Moves on every gesture. */
  cursor: string | null
}

export const EMPTY_SELECTION: Selection = { ids: new Set(), anchor: null, cursor: null }

export interface ClickModifiers {
  /** ⌘ or ctrl: add/remove one book. */
  toggle: boolean
  /** ⇧: select from the anchor to here. */
  range: boolean
}

export function modifiersFrom(e: {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}): ClickModifiers {
  return { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey }
}

/** Inclusive slice between two ids, in display order, in either direction. */
function rangeBetween(order: readonly string[], from: string, to: string): string[] {
  const a = order.indexOf(from)
  const b = order.indexOf(to)
  // An anchor that has left the library (deleted, or filtered out) can't
  // define a range; selecting just the target is the least surprising answer.
  if (a === -1 || b === -1) return b === -1 ? [] : [to]
  return order.slice(Math.min(a, b), Math.max(a, b) + 1)
}

export function applyClick(
  sel: Selection,
  id: string,
  mods: ClickModifiers,
  order: readonly string[]
): Selection {
  if (mods.range && sel.anchor) {
    const range = rangeBetween(order, sel.anchor, id)
    // ⌘⇧ adds the range to what's already selected; ⇧ alone replaces it
    const ids = mods.toggle ? new Set([...sel.ids, ...range]) : new Set(range)
    return { ids, anchor: sel.anchor, cursor: id }
  }
  if (mods.toggle) return toggleOne(sel, id)
  return { ids: new Set([id]), anchor: id, cursor: id }
}

export function toggleOne(sel: Selection, id: string): Selection {
  const ids = new Set(sel.ids)
  if (ids.has(id)) ids.delete(id)
  else ids.add(id)
  // The anchor follows even when removing: the next ⇧-click should range from
  // the book the user last touched, which is this one either way.
  return { ids, anchor: id, cursor: id }
}

/** ⇧+arrow: the same rule as a ⇧-click, from wherever the cursor is. */
export function extendTo(sel: Selection, id: string, order: readonly string[]): Selection {
  return applyClick(sel, id, { toggle: false, range: true }, order)
}

export function selectAll(sel: Selection, order: readonly string[]): Selection {
  // Changes what is selected, not where the user is
  return { ids: new Set(order), anchor: sel.anchor, cursor: sel.cursor }
}

export function clear(): Selection {
  return EMPTY_SELECTION
}

/**
 * Drop anything that is no longer in the library. Returns the *same object*
 * when nothing changed, so a store can set it unconditionally on every load
 * without causing a render.
 */
export function prune(sel: Selection, existing: readonly string[]): Selection {
  const keep = new Set(existing)
  const ids = new Set([...sel.ids].filter((id) => keep.has(id)))
  const anchor = sel.anchor && keep.has(sel.anchor) ? sel.anchor : null
  const cursor = sel.cursor && keep.has(sel.cursor) ? sel.cursor : null
  if (ids.size === sel.ids.size && anchor === sel.anchor && cursor === sel.cursor) return sel
  return { ids, anchor, cursor }
}

/** The single-selection view of a selection: null unless exactly one. */
export function selectedId(sel: Selection): string | null {
  if (sel.ids.size !== 1) return null
  return sel.ids.values().next().value ?? null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/selection.test.ts` Expected: PASS, all tests.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add src/lib/selection.ts src/lib/selection.test.ts
git commit -m "feat: pure selection grammar for multi-book selection"
```

---

### Task 2: Selection slice in the UI store

Replace `selectedBookId` with a `Selection`, keeping a derived single-selection selector so existing consumers keep working, and prune the selection whenever the library reloads.

**Files:**
- Modify: `src/stores/ui.store.ts`
- Modify: `src/hooks/useLibrary.ts`
- Modify: `src/components/library/BookDetail.tsx:29`
- Modify: `src/components/library/DeleteBookDialog.tsx:17`
- Modify: `src/hooks/useBookNavigation.ts:60`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces, on `useUIStore`:
  - state `selection: Selection`
  - `select(id: string, mods: ClickModifiers): void`
  - `selectBook(id: string | null): void` — unchanged signature; selects exactly that book, or clears
  - `toggleBookSelection(id: string): void`
  - `extendSelectionTo(id: string): void`
  - `selectAllBooks(): void`
  - `clearSelection(): void`
  - `pruneSelection(existing: string[]): void`
  - exported selectors `selectedBookId(s: UIState): string | null` and `selectionCount(s: UIState): number`

- [ ] **Step 1: Replace the state and actions in `ui.store.ts`**

Add these imports at the top of `src/stores/ui.store.ts`:

```ts
import { useLibraryStore } from '@/stores/library.store'
import {
  EMPTY_SELECTION,
  applyClick,
  clear,
  extendTo,
  prune,
  selectAll,
  selectedId,
  toggleOne,
  type ClickModifiers,
  type Selection
} from '@/lib/selection'
```

In `interface UIState`, replace the line `selectedBookId: string | null` with:

```ts
  selection: Selection
```

and replace the `selectBook(id: string | null): void` declaration with:

```ts
  select(id: string, mods: ClickModifiers): void
  /** Select exactly this book, or clear. The single-selection shorthand. */
  selectBook(id: string | null): void
  toggleBookSelection(id: string): void
  extendSelectionTo(id: string): void
  selectAllBooks(): void
  clearSelection(): void
  /** Drop selected books that are no longer in the loaded library. */
  pruneSelection(existing: string[]): void
```

In the store body, replace `selectedBookId: null,` with `selection: EMPTY_SELECTION,` and replace the `selectBook:` line with:

```ts
      select: (id, mods) =>
        set((s) => ({ selection: applyClick(s.selection, id, mods, bookOrder()) })),
      selectBook: (id) =>
        set((s) => ({
          selection: id === null ? clear() : applyClick(s.selection, id, PLAIN_CLICK, bookOrder())
        })),
      toggleBookSelection: (id) => set((s) => ({ selection: toggleOne(s.selection, id) })),
      extendSelectionTo: (id) =>
        set((s) => ({ selection: extendTo(s.selection, id, bookOrder()) })),
      selectAllBooks: () => set((s) => ({ selection: selectAll(s.selection, bookOrder()) })),
      clearSelection: () => set({ selection: clear() }),
      pruneSelection: (existing) => set((s) => ({ selection: prune(s.selection, existing) })),
```

Above `export const useUIStore`, add the order helper and the click constant:

```ts
const PLAIN_CLICK: ClickModifiers = { toggle: false, range: false }

/**
 * Display order for range selection, read at call time rather than passed in
 * by every view — the same cross-store `getState` read `BookCard` already uses
 * to reach the reader. The dependency is one-way: `library.store` knows
 * nothing about this one (pruning is wired from `useLibrary`), so there is no
 * import cycle.
 */
function bookOrder(): string[] {
  return useLibraryStore.getState().books.map((b) => b.id)
}
```

Below the store, add the derived selectors:

```ts
/**
 * The single-selection view, for everything that only makes sense for one
 * book (the detail panel, the metadata editor, the per-book delete dialog).
 * Null when zero or many are selected.
 */
export const selectedBookId = (s: UIState): string | null => selectedId(s.selection)

export const selectionCount = (s: UIState): number => s.selection.ids.size
```

- [ ] **Step 2: Update the three single-selection read sites**

In `src/components/library/BookDetail.tsx`, change the import from `@/stores/ui.store` to also bring in the selector and swap line 29:

```ts
import { selectedBookId, useUIStore } from '@/stores/ui.store'
// …
  const bookId = useUIStore(selectedBookId)
```

Then rename its uses in that component: `selectedBookId` → `bookId` in the `useMemo` on line 42–45 and anywhere else it appears.

In `src/components/library/DeleteBookDialog.tsx`, swap line 17 the same way:

```ts
import { selectedBookId, useUIStore } from '@/stores/ui.store'
// …
  const currentSelection = useUIStore(selectedBookId)
```

and update the `confirm()` body's `if (selectedBookId === book.id) selectBook(null)` to `if (currentSelection === book.id) selectBook(null)`.

In `src/hooks/useBookNavigation.ts`, swap line 60:

```ts
import { selectedBookId as selectedBookIdSelector, useUIStore } from '@/stores/ui.store'
// …
  const selectedBookId = useUIStore(selectedBookIdSelector)
```

(Task 5 replaces this with the cursor; this step only keeps it compiling.)

- [ ] **Step 3: Prune on every library load, from `useLibrary`**

In `src/hooks/useLibrary.ts`, add after the existing store reads:

```ts
  const books = useLibraryStore((s) => s.books)
  const pruneSelection = useUIStore((s) => s.pruneSelection)

  // Selection is pruned to what is actually loaded. Without this, selecting
  // twelve books and then typing a search leaves them selected but invisible,
  // and "Delete 12 books" would delete books the user can no longer see. The
  // cost — narrowing a filter drops the selection — is the intended trade.
  useEffect(() => {
    pruneSelection(books.map((b) => b.id))
  }, [books, pruneSelection])
```

- [ ] **Step 4: Verify the app still builds and behaves as before**

Run: `npm run typecheck && npm run lint && npm test` Expected: all pass. Single selection still works exactly as it did — this task adds no user-visible behaviour.

- [ ] **Step 5: Commit**

```bash
git add src/stores/ui.store.ts src/hooks/useLibrary.ts \
  src/components/library/BookDetail.tsx src/components/library/DeleteBookDialog.tsx \
  src/hooks/useBookNavigation.ts
git commit -m "feat: hold a selection rather than one book id in the UI store"
```

---

### Task 3: Modifier clicks in the grid

**Files:**
- Modify: `src/components/library/BookCard.tsx:42-43,58`

**Interfaces:**
- Consumes: `select`, `selection` from Task 2; `modifiersFrom` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Swap the card's selection read and click handler**

In `src/components/library/BookCard.tsx`, add to the imports:

```ts
import { modifiersFrom } from '@/lib/selection'
```

Replace lines 42–43:

```ts
  const select = useUIStore((s) => s.select)
  // A boolean selector, so zustand re-renders only the cards whose membership
  // actually changed rather than every mounted card on every selection change
  const selected = useUIStore((s) => s.selection.ids.has(book.id))
```

Replace the `onClick` on line 58:

```tsx
        onClick={(e) => select(book.id, modifiersFrom(e))}
```

- [ ] **Step 2: Verify by hand in the running app**

Run: `npm run dev` Expected: plain click selects one book; ⌘-click adds and removes books; ⇧-click selects a contiguous run; every selected card shows the gold ring. Double-click still opens the reader.

- [ ] **Step 3: Commit**

```bash
npm run typecheck && npm run lint
git add src/components/library/BookCard.tsx
git commit -m "feat: modifier-click selection in the grid"
```

---

### Task 4: Checkbox column in the list

**Files:**
- Modify: `src/components/library/ListView.tsx`

**Interfaces:**
- Consumes: Task 1 and Task 2.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add the column definition and the select-all header cell**

In `src/components/library/ListView.tsx`, extend the imports:

```ts
import { modifiersFrom } from '@/lib/selection'
import { selectionCount, useUIStore } from '@/stores/ui.store'
import { CheckIcon, SortArrowIcon, StarIcon } from '@/components/shared/icons'
```

Change the `COLUMNS` type and add the select column as the first entry, so `Spacer`'s `colSpan={COLUMNS.length}` stays correct by construction:

```ts
/** Column definitions; `field` omitted means the column isn't sortable. */
const COLUMNS: {
  label: string
  width: string
  field?: SortField
  align?: 'right'
  /** The checkbox column: rendered by its own header and row cells. */
  select?: true
}[] = [
  { label: '', width: 'w-10', select: true },
  { label: 'Title', width: 'w-[28%]', field: 'title' },
  { label: 'Author', width: 'w-[20%]', field: 'author' },
  { label: 'Series', width: 'w-[18%]', field: 'series' },
  { label: 'Added', width: 'w-[12%]', field: 'date_added' },
  { label: 'Formats', width: 'w-[10%]' },
  { label: 'Rating', width: 'w-[10%]', field: 'rating' }
]
```

Add the header cell component next to `HeaderCell`:

```tsx
/**
 * Select-all box. "All" means every book currently loaded — that is, under
 * the active search and filters — which is the only meaning that matches
 * what is on screen.
 */
function SelectAllHeaderCell() {
  const books = useLibraryStore((s) => s.books)
  const count = useUIStore(selectionCount)
  const selectAllBooks = useUIStore((s) => s.selectAllBooks)
  const clearSelection = useUIStore((s) => s.clearSelection)

  const all = books.length > 0 && count === books.length
  const some = count > 0 && !all

  return (
    <th className="w-10 py-2 pl-6 pr-2">
      <button
        role="checkbox"
        aria-checked={all ? 'true' : some ? 'mixed' : 'false'}
        aria-label={all ? 'Deselect all books' : 'Select all books'}
        onClick={() => (all ? clearSelection() : selectAllBooks())}
        className="flex h-5 items-center"
      >
        <span
          className={`flex h-3.5 w-3.5 items-center justify-center rounded-sm border transition-colors ${
            all || some ? 'border-gold-400 bg-gold-500/30 text-gold-200' : 'border-ink-600'
          }`}
        >
          {all && <CheckIcon className="h-2.5 w-2.5" />}
          {some && <span className="h-0.5 w-2 rounded bg-gold-200" />}
        </span>
      </button>
    </th>
  )
}
```

- [ ] **Step 2: Render it from the header map**

Replace the `COLUMNS.map(...)` block inside `<thead>` with:

```tsx
            {COLUMNS.map((c, i) =>
              c.select ? (
                <SelectAllHeaderCell key="select" />
              ) : (
                <HeaderCell
                  key={c.label}
                  label={c.label}
                  width={c.width}
                  field={c.field}
                  first={i === 0}
                  last={i === COLUMNS.length - 1}
                />
              )
            )}
```

- [ ] **Step 3: Add the row checkbox and modifier clicks**

In `Row`, replace the three store reads and the `onClick` with:

```tsx
  const select = useUIStore((s) => s.select)
  const toggleBookSelection = useUIStore((s) => s.toggleBookSelection)
  const selected = useUIStore((s) => s.selection.ids.has(book.id))
  const openContextMenu = useUIStore((s) => s.openContextMenu)
```

```tsx
      onClick={(e) => select(book.id, modifiersFrom(e))}
```

Then add this as the **first** `<td>` in the row, before Title:

```tsx
      {/* The 20px line and block-level child keep this cell inside ROW_HEIGHT.
          stopPropagation so ticking a box doesn't also run the row's click and
          collapse the selection to this one book. */}
      <td
        className="w-10 py-2 pl-6 pr-2"
        onClick={(e) => {
          e.stopPropagation()
          toggleBookSelection(book.id)
        }}
      >
        <span className="flex h-5 items-center">
          <span
            className={`flex h-3.5 w-3.5 items-center justify-center rounded-sm border transition-colors ${
              selected ? 'border-gold-400 bg-gold-500/30 text-gold-200' : 'border-ink-600'
            }`}
          >
            {selected && <CheckIcon className="h-2.5 w-2.5" />}
          </span>
        </span>
      </td>
```

Finally, since Title is no longer the first column, change its `<td>` padding from `py-2 pl-6 pr-3` to `px-3 py-2`.

- [ ] **Step 4: Verify the row height did not move**

Run: `npm run dev`, switch to list view, open DevTools console and run:

```js
document.querySelector('tbody tr:not([aria-hidden])').getBoundingClientRect().height
```

Expected: `36` (the `<tr>` height; the 37th px is the collapsed border). If it is anything else, the checkbox cell has grown the row and the virtualizer's `ROW_HEIGHT` is now wrong — fix the cell, do not change `ROW_HEIGHT`.

Also confirm: scrolling to the bottom of a long library lands on the last row with no gap, ⌘-click and ⇧-click work on rows, ticking a box adds one book without collapsing the selection, and the header box goes checked → indeterminate → empty as expected.

- [ ] **Step 5: Commit**

```bash
npm run typecheck && npm run lint
git add src/components/library/ListView.tsx
git commit -m "feat: checkbox column and select-all in the list view"
```

---

### Task 5: Keyboard selection

**Files:**
- Modify: `src/hooks/useBookNavigation.ts`
- Modify: `src/hooks/useMenuCommands.ts`
- Modify: `electron/main/services/menu.ts:58`
- Modify: `src/types/api.types.ts:43`

**Interfaces:**
- Consumes: Task 2's actions.
- Produces: `MenuCommand` gains the `'select-all'` member.

- [ ] **Step 1: Navigate from the cursor, not the single selection**

In `src/hooks/useBookNavigation.ts`, replace the selection reads (the line added in Task 2 plus `selectBook`) with:

```ts
  const cursorId = useUIStore((s) => s.selection.cursor)
  const selectionSize = useUIStore((s) => s.selection.ids.size)
  const selectBook = useUIStore((s) => s.selectBook)
  const extendSelectionTo = useUIStore((s) => s.extendSelectionTo)
  const clearSelection = useUIStore((s) => s.clearSelection)
```

and the index line with:

```ts
  const index = cursorId ? books.findIndex((b) => b.id === cursorId) : -1
```

- [ ] **Step 2: Handle shift-arrows and Escape**

In the `onKey` handler, replace the first two guards with:

```ts
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
      if (e.key === 'Escape') {
        if (!selectionSize) return
        e.preventDefault()
        clearSelection()
        return
      }
```

and replace the final move with:

```ts
      e.preventDefault() // arrows would otherwise scroll the container away
      if (next === index) return
      // ⇧ extends the range from the anchor; a plain arrow collapses to one
      if (e.shiftKey) extendSelectionTo(books[next].id)
      else selectBook(books[next].id)
```

Update the effect's dependency array: replace `selectedBookId, selectBook` with `selectionSize, selectBook, extendSelectionTo, clearSelection`.

- [ ] **Step 3: Give ⌘A to the library**

In `src/types/api.types.ts` line 43:

```ts
export type MenuCommand = 'open-settings' | 'view-grid' | 'view-list' | 'select-all'
```

In `electron/main/services/menu.ts`, replace `{ role: 'selectAll' }` with:

```ts
      // Not `role: 'selectAll'` — that role owns ⌘A, and the library needs it.
      // The renderer routes by focus so text fields keep their own select-all.
      { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: command('select-all') }
```

In `src/hooks/useMenuCommands.ts`, extend the handler:

```ts
        else if (cmd === 'select-all') {
          // Text fields keep ⌘A: the menu item took the accelerator away from
          // the `selectAll` role, so this hands it back where it belongs.
          const el = document.activeElement
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select()
          else useUIStore.getState().selectAllBooks()
        }
```

- [ ] **Step 4: Verify in the running app**

Run: `npm run dev` Expected: arrows move a single selection as before; ⇧+arrow grows a range from the anchor; Escape clears everything; ⌘A selects every loaded book in both views; ⌘A inside the search box or a metadata-editor field still selects that field's text.

If ⌘A does **not** reach the renderer at all, stop and report it: the documented fallback is to restore `{ role: 'selectAll' }` and leave the header checkbox as the only select-all, which is a spec-sanctioned outcome.

- [ ] **Step 5: Commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/hooks/useBookNavigation.ts src/hooks/useMenuCommands.ts \
  electron/main/services/menu.ts src/types/api.types.ts
git commit -m "feat: shift-arrow range selection and a library-aware Select All"
```

---

### Task 6: Batched bulk delete in the main process

**Files:**
- Modify: `electron/main/services/book-delete.ts`
- Modify: `electron/main/ipc/library.ts:52`
- Modify: `src/types/api.types.ts` (library section)
- Modify: `electron/preload/index.ts:25`
- Test: `electron/main/services/book-delete.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface BulkDeleteResult { deleted: number; failed: { id: string; title: string; error: string }[] }` exported from `electron/main/services/book-delete.ts`
  - `deleteBooks(ids: string[]): Promise<BulkDeleteResult>`
  - `window.Musaeum.library.deleteBooks(ids: string[]): Promise<BulkDeleteResult>`

- [ ] **Step 1: Write the failing tests**

Append to `electron/main/services/book-delete.test.ts` (and add `deleteBooks` to the existing `./book-delete` import, `vi` to the `vitest` import, and `readCatalog` is already imported):

```ts
describe('deleteBooks', () => {
  it('deletes every book, its folder, and its cache row', async () => {
    const dirs = [await seed('m1', ['epub']), await seed('m2', ['epub']), await seed('m3', ['pdf'])]
    await seed('keep', ['epub'])

    const result = await deleteBooks(['m1', 'm2', 'm3'])

    expect(result.deleted).toBe(3)
    expect(result.failed).toEqual([])
    for (const dir of dirs) {
      await expect(fs.access(dir)).rejects.toThrow()
    }
    expect(getBooks().map((b) => b.id)).toEqual(['keep'])
  })

  it('writes the catalog once for the whole batch, not once per book', async () => {
    await seed('m1', ['epub'])
    await seed('m2', ['epub'])
    await seed('m3', ['epub'])
    await seed('keep', ['epub'])
    const full = vi.spyOn(librarySync, 'writeFullCatalog')
    const perBook = vi.spyOn(librarySync, 'removeBookFromCatalog')

    await deleteBooks(['m1', 'm2', 'm3'])
    await librarySync.flushForTests()

    expect(full).toHaveBeenCalledTimes(1)
    expect(perBook).not.toHaveBeenCalled()
    // …and the file it wrote is correct, not merely written once
    const catalog = await readCatalog(root)
    expect(catalog?.books.map((b) => b.id)).toEqual(['keep'])
    full.mockRestore()
    perBook.mockRestore()
  })

  it('keeps going past a book it cannot delete, and reports it', async () => {
    await seed('ok1', ['epub'])
    await seed('ok2', ['epub'])

    // An id with no row is the cheapest stand-in for a book that has gone
    // missing under the batch — the point is that it doesn't abort the rest
    const result = await deleteBooks(['ok1', 'missing-entirely', 'ok2'])

    expect(result.deleted).toBe(2)
    expect(result.failed).toEqual([
      { id: 'missing-entirely', title: 'missing-entirely', error: 'Book not found' }
    ])
    expect(getBook('ok1')).toBeFalsy()
    expect(getBook('ok2')).toBeFalsy()
  })

  it('writes nothing when nothing was deleted', async () => {
    await seed('keep', ['epub'])
    const full = vi.spyOn(librarySync, 'writeFullCatalog')

    const result = await deleteBooks([])

    expect(result.deleted).toBe(0)
    expect(full).not.toHaveBeenCalled()
    full.mockRestore()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- electron/main/services/book-delete.test.ts` Expected: FAIL — `deleteBooks` is not exported.

- [ ] **Step 3: Implement `deleteBooks`**

First add the shared result type to `src/types/api.types.ts`, near the other shared shapes — it crosses the IPC boundary, so it belongs there rather than in the service:

```ts
export interface BulkDeleteResult {
  deleted: number
  failed: { id: string; title: string; error: string }[]
}
```

Then append to `electron/main/services/book-delete.ts`, adding the import beside the existing `@shared/book.types` one:

```ts
import type { BulkDeleteResult } from '@shared/api.types'
```

```ts
/**
 * Delete many books in one pass.
 *
 * Not a loop over `deleteBook`: that function removes each book from the
 * catalog individually, and every one of those enqueues a **whole-file**
 * rewrite of catalog.json over SMB, plus a `libraryChanged` broadcast that
 * reloads the entire library in the renderer. For a dozen books that is a
 * dozen ~10MB writes and a dozen reloads. This does the per-book work with no
 * catalog contact at all and finishes with one batched write.
 *
 * One book's failure never aborts the rest — the books are independent
 * folders on a share that may be flaky, and eleven successful deletions plus
 * an honest report beats a half-finished batch.
 */
export async function deleteBooks(ids: string[]): Promise<BulkDeleteResult> {
  nas.assertOnline()
  const root = nas.getLibraryRoot()!
  const failed: BulkDeleteResult['failed'] = []
  let deleted = 0

  for (const id of ids) {
    const book = db.getBook(id)
    if (!book) {
      failed.push({ id, title: id, error: 'Book not found' })
      continue
    }
    try {
      if (book.nasPath) {
        await fs.rm(join(root, book.nasPath), { recursive: true, force: true })
      }
      db.deleteBook(id)
      deleted++
    } catch (err) {
      failed.push({ id, title: book.title, error: err instanceof Error ? err.message : String(err) })
    }
  }

  if (deleted > 0) {
    librarySync.writeFullCatalog()
    broadcast('libraryChanged')
  }
  return { deleted, failed }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- electron/main/services/book-delete.test.ts` Expected: PASS, including the existing `deleteBook` and `deleteFormats` tests.

- [ ] **Step 5: Expose it over IPC**

In `electron/main/ipc/library.ts`, after the `library:deleteBook` handler:

```ts
  handle('library:deleteBooks', (ids: string[]) => bookDelete.deleteBooks(ids))
```

In `src/types/api.types.ts`, in the `library` block after `deleteBook` (the `BulkDeleteResult` type itself went in during Step 3):

```ts
    /**
     * Delete many books in one batched operation. Partial success is normal:
     * `failed` names the books that survived and why.
     */
    deleteBooks(ids: string[]): Promise<BulkDeleteResult>
```

In `electron/preload/index.ts`, after the `deleteBook` line:

```ts
    deleteBooks: (ids) => invoke('library:deleteBooks', ids),
```

- [ ] **Step 6: Commit**

```bash
npm run typecheck && npm run lint && npm test
git add electron/main/services/book-delete.ts electron/main/services/book-delete.test.ts \
  electron/main/ipc/library.ts src/types/api.types.ts electron/preload/index.ts
git commit -m "feat: batched bulk delete with one catalog write"
```

---

### Task 7: Sequential bulk re-hydrate job

**Files:**
- Create: `electron/main/services/bulk-hydrate.ts`
- Create: `electron/main/services/bulk-hydrate.test.ts`
- Modify: `electron/main/services/importer.ts:248-296`
- Modify: `electron/main/ipc/metadata.ts`
- Modify: `src/types/api.types.ts`
- Modify: `electron/preload/index.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface BulkHydrateProgress { completed: number; total: number; failed: number; skipped: number; running: boolean }` in `src/types/metadata.types.ts`
  - `startBulkHydrate(ids: string[]): void` (validates synchronously, then runs)
  - `cancelBulkHydrate(): void`
  - `findHydratableFile(bookDir: string): Promise<string | null>`
  - `flushForTests(): Promise<void>`, `resetForTests(): void`
  - `window.Musaeum.metadata.rehydrateBooks(ids)` / `.cancelRehydrate()`
  - `window.Musaeum.on.bulkHydrateProgress(cb)`
  - `importer.hydrate(..., options?: { batched?: boolean })`

- [ ] **Step 1: Add the `batched` option to `importer.hydrate`**

In `electron/main/services/importer.ts`, change the signature:

```ts
export async function hydrate(
  bookId: string,
  filePath: string,
  bookDir: string,
  job?: ImportProgress,
  /**
   * Batched: the caller owns the catalog write and the libraryChanged
   * broadcast for the whole run. metadata.json is still written per book —
   * it is the canonical store and lives in the book's own folder, which is
   * exactly what catalog.json is not.
   */
  options: { batched?: boolean } = {}
): Promise<void> {
```

Inside, guard the two calls (leave `writeMetadataJson` and `renameToTitle` alone):

```ts
      await writeMetadataJson(bookDir, updated, result.metadata.metadata_sources)
      if (!options.batched) librarySync.upsertCatalog([updated])
```

```ts
    if (!options.batched) broadcast('libraryChanged')
```

Leave the `conflictQueueUpdated` broadcast unconditional — it carries a count and does no I/O.

- [ ] **Step 2: Write the failing tests**

Create `electron/main/services/bulk-hydrate.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { writeCatalog } from './catalog'
import { closeDb, insertBook } from './db'
import * as importer from './importer'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'
import {
  cancelBulkHydrate,
  findHydratableFile,
  flushForTests,
  resetForTests,
  startBulkHydrate
} from './bulk-hydrate'

let root: string
/** Order and overlap of hydrate calls, for the sequencing assertions. */
let calls: { id: string; start: number; end: number }[]

async function seed(id: string, ext = 'epub'): Promise<void> {
  insertBook(makeBook(id))
  const dir = join(root, `books/${id}`)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, `Book ${id}.${ext}`), 'x')
}

beforeEach(async () => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
  librarySync.resetForTests()
  resetForTests()
  root = mkdtempSync(join(tmpdir(), 'musaeum-bulk-hydrate-'))
  await nas.setLibraryRoot(root)
  await writeCatalog(root, [])

  calls = []
  vi.spyOn(importer, 'hydrate').mockImplementation(async (bookId) => {
    const start = Date.now()
    await new Promise((r) => setTimeout(r, 10))
    calls.push({ id: bookId, start, end: Date.now() })
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await librarySync.flushForTests()
  rmSync(root, { recursive: true, force: true })
})

describe('findHydratableFile', () => {
  it('finds an epub, mobi or azw3 and ignores a pdf', async () => {
    await seed('a', 'epub')
    await seed('b', 'azw3')
    await seed('c', 'pdf')
    expect(await findHydratableFile(join(root, 'books/a'))).toContain('.epub')
    expect(await findHydratableFile(join(root, 'books/b'))).toContain('.azw3')
    expect(await findHydratableFile(join(root, 'books/c'))).toBeNull()
  })
})

describe('startBulkHydrate', () => {
  it('hydrates books one at a time, never concurrently', async () => {
    await seed('a')
    await seed('b')
    await seed('c')

    startBulkHydrate(['a', 'b', 'c'])
    await flushForTests()

    expect(calls.map((c) => c.id)).toEqual(['a', 'b', 'c'])
    // No call may begin before its predecessor ended — this is the rate-limit
    // guarantee, and the reason the loop awaits rather than fanning out
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i].start).toBeGreaterThanOrEqual(calls[i - 1].end)
    }
  })

  it('passes batched: true so hydrate does not write the catalog per book', async () => {
    await seed('a')
    startBulkHydrate(['a'])
    await flushForTests()

    expect(importer.hydrate).toHaveBeenCalledWith(
      'a',
      expect.stringContaining('Book a.epub'),
      join(root, 'books/a'),
      undefined,
      { batched: true }
    )
  })

  it('writes the catalog once for the whole job', async () => {
    await seed('a')
    await seed('b')
    const full = vi.spyOn(librarySync, 'writeFullCatalog')

    startBulkHydrate(['a', 'b'])
    await flushForTests()

    expect(full).toHaveBeenCalledTimes(1)
  })

  it('skips a book with no hydratable file rather than failing', async () => {
    await seed('a', 'pdf')
    await seed('b')

    startBulkHydrate(['a', 'b'])
    await flushForTests()

    expect(calls.map((c) => c.id)).toEqual(['b'])
  })

  it('refuses to start a second job while one is running', async () => {
    await seed('a')
    startBulkHydrate(['a'])
    expect(() => startBulkHydrate(['a'])).toThrow(/already running/i)
    await flushForTests()
  })

  it('stops early when cancelled', async () => {
    await seed('a')
    await seed('b')
    await seed('c')

    startBulkHydrate(['a', 'b', 'c'])
    cancelBulkHydrate()
    await flushForTests()

    // The in-flight book finishes — a sidecar call can't be torn off midway —
    // but nothing after it starts
    expect(calls.length).toBeLessThan(3)
  })

  it('stops when the NAS goes offline mid-job', async () => {
    await seed('a')
    await seed('b')
    await seed('c')
    vi.spyOn(nas, 'isOnline').mockReturnValue(false)

    startBulkHydrate(['a', 'b', 'c'])
    await flushForTests()

    expect(calls).toEqual([])
  })

  it('throws when the NAS is offline before it starts', async () => {
    vi.spyOn(nas, 'assertOnline').mockImplementation(() => {
      throw new Error('Library is offline')
    })
    expect(() => startBulkHydrate(['a'])).toThrow(/offline/i)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- electron/main/services/bulk-hydrate.test.ts` Expected: FAIL — cannot resolve `./bulk-hydrate`.

- [ ] **Step 4: Add the progress type**

In `src/types/metadata.types.ts`:

```ts
/** Progress of a bulk re-hydration job. `running` false means it is over. */
export interface BulkHydrateProgress {
  completed: number
  total: number
  failed: number
  skipped: number
  running: boolean
}
```

- [ ] **Step 5: Implement the service**

Create `electron/main/services/bulk-hydrate.ts`:

```ts
import { promises as fs } from 'fs'
import { extname, join } from 'path'
import type { BulkHydrateProgress } from '@shared/metadata.types'
import * as db from './db'
import { broadcast } from './events'
import * as importer from './importer'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'

/**
 * Re-hydrate many books as one job.
 *
 * Not a loop in the renderer: `importer.hydrate` upserts the catalog and
 * broadcasts `libraryChanged` per book, so fifty books would mean fifty
 * whole-file catalog rewrites over SMB and fifty full library reloads. Worse,
 * the sidecar dispatches on a thread pool, so a renderer loop would fan out
 * fifty *concurrent* hydrations at rate-limited metadata APIs.
 *
 * So: sequential, batched (the catalog is written once at the end), and
 * cancellable, because a few hundred books is minutes of work.
 */

const HYDRATABLE = ['.epub', '.mobi', '.azw3']

/**
 * The one place that decides what a book can be hydrated from — shared with
 * the single-book `metadata:rehydrateBook` handler so the two cannot drift.
 * PDF-only books have nothing here, and are skipped rather than failed.
 */
export async function findHydratableFile(bookDir: string): Promise<string | null> {
  const files = await fs.readdir(bookDir)
  const match = files.find((f) => HYDRATABLE.includes(extname(f).toLowerCase()))
  return match ? join(bookDir, match) : null
}

let running = false
let cancelled = false
let current: Promise<void> = Promise.resolve()

export function isBulkHydrateRunning(): boolean {
  return running
}

/** Stops the loop; the book in flight still finishes and is counted. */
export function cancelBulkHydrate(): void {
  if (running) cancelled = true
}

/**
 * Validates synchronously and then runs in the background — the caller is an
 * IPC handler, and a job that takes minutes must not hold an `invoke` open.
 * Progress and completion arrive as `bulkHydrateProgress` events.
 */
export function startBulkHydrate(ids: string[]): void {
  if (running) throw new Error('A metadata refresh is already running')
  nas.assertOnline()
  running = true
  cancelled = false
  current = run(ids)
}

async function run(ids: string[]): Promise<void> {
  const progress: BulkHydrateProgress = {
    completed: 0,
    total: ids.length,
    failed: 0,
    skipped: 0,
    running: true
  }
  broadcast('bulkHydrateProgress', { ...progress })
  let hydrated = 0

  try {
    for (const id of ids) {
      if (cancelled) break
      // Every remaining write would fail anyway; stopping and saying so beats
      // reporting fifty separate failures
      if (!nas.isOnline()) break

      const book = db.getBook(id)
      if (!book?.nasPath) {
        progress.skipped++
      } else {
        const bookDir = join(nas.getLibraryRoot()!, book.nasPath)
        try {
          const file = await findHydratableFile(bookDir)
          if (!file) {
            progress.skipped++
          } else {
            await importer.hydrate(id, file, bookDir, undefined, { batched: true })
            hydrated++
          }
        } catch (err) {
          // `hydrate` swallows its own pipeline failures (a book keeps its
          // embedded metadata), so this catches the surrounding I/O only
          console.error(`[bulk-hydrate] ${id} failed:`, err)
          progress.failed++
        }
      }
      progress.completed++
      broadcast('bulkHydrateProgress', { ...progress })
    }
  } finally {
    running = false
    cancelled = false
    progress.running = false
    if (hydrated > 0) {
      librarySync.writeFullCatalog()
      broadcast('libraryChanged')
    }
    broadcast('bulkHydrateProgress', { ...progress })
  }
}

/** Test-only helpers. */
export function flushForTests(): Promise<void> {
  return current
}
export function resetForTests(): void {
  running = false
  cancelled = false
  current = Promise.resolve()
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- electron/main/services/bulk-hydrate.test.ts` Expected: PASS.

- [ ] **Step 7: Expose it over IPC and share the file lookup**

In `electron/main/ipc/metadata.ts`, import the service and rewrite the single-book handler to use the shared lookup, then add the two new handlers:

```ts
import * as bulkHydrate from '../services/bulk-hydrate'
```

```ts
  handle('metadata:rehydrateBook', async (bookId: string) => {
    nas.assertOnline()
    const book = db.getBook(bookId)
    if (!book?.nasPath) throw new Error('Book not found')
    const bookDir = join(nas.getLibraryRoot()!, book.nasPath)
    const file = await bulkHydrate.findHydratableFile(bookDir)
    if (!file) throw new Error('No book file found to hydrate from')
    // Fire and forget — hydration is always non-blocking
    void importer.hydrate(bookId, file, bookDir)
  })

  handle('metadata:rehydrateBooks', (bookIds: string[]) => {
    bulkHydrate.startBulkHydrate(bookIds)
  })

  handle('metadata:cancelRehydrate', () => {
    bulkHydrate.cancelBulkHydrate()
  })
```

Remove the now-unused `fs` and `extname` imports from that file if nothing else uses them.

In `src/types/api.types.ts`: import `BulkHydrateProgress` alongside the other metadata types, extend the `metadata` block:

```ts
    /** Re-hydrate many books as one sequential job; progress via events. */
    rehydrateBooks(bookIds: string[]): Promise<void>
    /** Stop a running bulk re-hydrate after the book in flight. */
    cancelRehydrate(): Promise<void>
```

extend `on`:

```ts
    bulkHydrateProgress(cb: (p: BulkHydrateProgress) => void): Unsubscribe
```

and extend `EVENT_CHANNELS`:

```ts
  bulkHydrateProgress: 'event:bulk-hydrate-progress',
```

In `electron/preload/index.ts`, in `metadata`:

```ts
    rehydrateBooks: (bookIds) => invoke('metadata:rehydrateBooks', bookIds),
    cancelRehydrate: () => invoke('metadata:cancelRehydrate'),
```

and in the `on` block, matching the surrounding style:

```ts
    bulkHydrateProgress: (cb) => listen(EVENT_CHANNELS.bulkHydrateProgress, cb),
```

- [ ] **Step 8: Commit**

```bash
npm run typecheck && npm run lint && npm test
git add electron/main/services/bulk-hydrate.ts electron/main/services/bulk-hydrate.test.ts \
  electron/main/services/importer.ts electron/main/ipc/metadata.ts \
  src/types/api.types.ts src/types/metadata.types.ts electron/preload/index.ts
git commit -m "feat: sequential, cancellable bulk metadata re-hydration"
```

---

### Task 8: Renderer plumbing for send and hydrate progress

**Files:**
- Modify: `src/stores/device.store.ts`
- Modify: `src/stores/library.store.ts`
- Modify: `src/hooks/useLibrary.ts`
- Modify: `src/components/layout/StatusBar.tsx`

**Interfaces:**
- Consumes: Task 7's `bulkHydrateProgress` event.
- Produces:
  - `useDeviceStore.sendBooksToDevice(bookIds: string[], deviceId: string): Promise<void>`
  - `useLibraryStore.bulkHydrate: BulkHydrateProgress | null` and `setBulkHydrate(p: BulkHydrateProgress | null): void`

- [ ] **Step 1: Add the bulk send loop to the device store**

In `src/stores/device.store.ts`, add to the interface after `sendToDevice`:

```ts
  sendBooksToDevice(bookIds: string[], deviceId: string): Promise<void>
```

and after the `sendToDevice` implementation:

```ts
  /**
   * Send many books. A plain loop over the single-book call is correct here:
   * `sendToDevice` returns as soon as the job is enqueued, and the main
   * process's transfer queue is already serial, so this adds N jobs to one
   * queue rather than N concurrent copies. StatusBar counts them for free.
   */
  async sendBooksToDevice(bookIds, deviceId) {
    const already = new Set(get().onDevice[deviceId] ?? [])
    for (const bookId of bookIds.filter((id) => !already.has(id))) {
      try {
        await get().sendToDevice(bookId, deviceId)
      } catch (err) {
        // The queue logs per-book failures to device_history; one book that
        // can't be queued must not stop the rest
        console.error(`send to device failed for ${bookId}:`, err)
      }
    }
  },
```

- [ ] **Step 2: Hold hydrate progress in the library store**

In `src/stores/library.store.ts`, import the type:

```ts
import type { BulkHydrateProgress } from '@shared/metadata.types'
```

add to `LibraryState`:

```ts
  /** Live bulk re-hydration progress, or null when no job is running. */
  bulkHydrate: BulkHydrateProgress | null
  setBulkHydrate(p: BulkHydrateProgress | null): void
```

add `bulkHydrate: null,` to the initial state and the action:

```ts
      setBulkHydrate(p) {
        set({ bulkHydrate: p })
      },
```

- [ ] **Step 3: Subscribe to the event**

In `src/hooks/useLibrary.ts`, add the store read:

```ts
  const setBulkHydrate = useLibraryStore((s) => s.setBulkHydrate)
```

add to the `unsubs` array:

```ts
      window.Musaeum.on.bulkHydrateProgress((p) => setBulkHydrate(p.running ? p : null)),
```

and add `setBulkHydrate` to that effect's dependency array.

- [ ] **Step 4: Show it in the status bar**

In `src/components/layout/StatusBar.tsx`, read it:

```ts
  const bulkHydrate = useLibraryStore((s) => s.bulkHydrate)
```

and render it after the `activeTransfers` block, matching the existing rows:

```tsx
      {bulkHydrate && (
        <span className="flex items-center gap-1.5 text-gold-400">
          <SpinnerIcon className="h-3 w-3" />
          <span className="tabular-nums">
            Refreshing metadata {bulkHydrate.completed}/{bulkHydrate.total}…
          </span>
          {/* Cancel lives here, not in the selection panel: the job outlives
              the selection, and clearing the selection must never strand a
              running job with no way to stop it. */}
          <button
            onClick={() => void window.Musaeum.metadata.cancelRehydrate()}
            className="underline underline-offset-2 hover:text-gold-300"
          >
            Cancel
          </button>
        </span>
      )}
```

- [ ] **Step 5: Commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/stores/device.store.ts src/stores/library.store.ts \
  src/hooks/useLibrary.ts src/components/layout/StatusBar.tsx
git commit -m "feat: bulk send loop and bulk hydrate progress in the status bar"
```

---

### Task 9: Selection panel and bulk delete dialog

**Files:**
- Create: `src/components/library/SelectionPanel.tsx`
- Create: `src/components/library/DeleteSelectionDialog.tsx`
- Modify: `src/stores/ui.store.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: Tasks 2, 6, 7, 8.
- Produces: `useUIStore.deletingSelection: boolean` and `requestSelectionDelete(open: boolean): void`.

- [ ] **Step 1: Add the dialog flag to the UI store**

In `src/stores/ui.store.ts`, add to `UIState`:

```ts
  /** Whether the bulk delete confirmation is open. */
  deletingSelection: boolean
  requestSelectionDelete(open: boolean): void
```

to the initial state `deletingSelection: false,` and the action:

```ts
      requestSelectionDelete: (deletingSelection) =>
        set({ deletingSelection, contextMenu: null }),
```

Also add `deletingSelection` to the guard list in `useBookNavigation`'s keyboard effect (both the condition and the dependency array), so arrows don't walk the library underneath the open dialog:

```ts
  const deletingSelection = useUIStore((s) => s.deletingSelection)
```

- [ ] **Step 2: Write the selection panel**

Create `src/components/library/SelectionPanel.tsx`:

```tsx
import { useMemo } from 'react'
import { useDeviceStore } from '@/stores/device.store'
import { useLibraryStore } from '@/stores/library.store'
import { useNASStore } from '@/stores/nas.store'
import { selectionCount, useUIStore } from '@/stores/ui.store'
import { CloseIcon, RefreshIcon, SendIcon, TrashIcon } from '@/components/shared/icons'

const PREVIEW_TITLES = 5

/**
 * Stands in for BookDetail when two or more books are selected. It reuses that
 * panel's shell width exactly: GridView derives its column count and row
 * height from the container width, so a panel that changed size between modes
 * would re-flow the grid on every selection change.
 */
export function SelectionPanel() {
  const count = useUIStore(selectionCount)
  const selectedIds = useUIStore((s) => s.selection.ids)
  const clearSelection = useUIStore((s) => s.clearSelection)
  const requestSelectionDelete = useUIStore((s) => s.requestSelectionDelete)
  const books = useLibraryStore((s) => s.books)
  const online = useNASStore((s) => s.status?.state === 'connected')
  const devices = useDeviceStore((s) => s.devices)
  const onDevice = useDeviceStore((s) => s.onDevice)
  const sendBooksToDevice = useDeviceStore((s) => s.sendBooksToDevice)

  // In display order, so the preview matches what the user is looking at
  const selected = useMemo(() => books.filter((b) => selectedIds.has(b.id)), [books, selectedIds])

  if (count < 2) return null

  // One button per connected device, like the detail panel's send row.
  // Presence comes from the scanned device contents, so a book already on the
  // Kindle is skipped rather than re-copied.
  const sends = devices.map((device) => {
    const alreadyOn = new Set(onDevice[device.id] ?? [])
    return { device, sendable: selected.filter((b) => !alreadyOn.has(b.id)) }
  })

  return (
    <aside className="flex w-[360px] shrink-0 animate-slide-in-right flex-col border-l border-ink-800 bg-ink-900 shadow-panel">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-ink-800 px-4">
        <span className="font-display text-[13px] text-parchment">{count} books selected</span>
        <button
          onClick={clearSelection}
          aria-label="Clear selection"
          className="rounded p-1 text-parchment-faint hover:bg-ink-800 hover:text-parchment"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <ul className="space-y-1.5">
          {selected.slice(0, PREVIEW_TITLES).map((b) => (
            <li key={b.id} className="truncate font-display text-[13px] text-parchment-dim">
              {b.title}
            </li>
          ))}
        </ul>
        {count > PREVIEW_TITLES && (
          <p className="mt-2 text-[12px] text-parchment-faint">
            +{count - PREVIEW_TITLES} more
          </p>
        )}
      </div>

      <div className="shrink-0 space-y-2 border-t border-ink-800 p-4">
        {sends.map(({ device, sendable }) => (
          <button
            key={device.id}
            disabled={!online || sendable.length === 0}
            onClick={() => void sendBooksToDevice(sendable.map((b) => b.id), device.id)}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-gold-500/20 px-3 py-2 text-[13px] text-gold-200 hover:bg-gold-500/30 disabled:opacity-40"
          >
            <SendIcon className="h-4 w-4" />
            {sendable.length === 0
              ? `All on ${device.name}`
              : `Send ${sendable.length} to ${device.name}`}
          </button>
        ))}
        <button
          disabled={!online}
          onClick={() => void window.Musaeum.metadata.rehydrateBooks(selected.map((b) => b.id))}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-ink-600 px-3 py-2 text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40"
        >
          <RefreshIcon className="h-4 w-4" />
          Refresh metadata
        </button>
        {/* Set apart from the recoverable actions above it, and the only one
            styled as danger */}
        <button
          disabled={!online}
          onClick={() => requestSelectionDelete(true)}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-md border border-red-500/40 px-3 py-2 text-[13px] text-red-400 hover:bg-red-500/15 disabled:opacity-40"
        >
          <TrashIcon className="h-4 w-4" />
          Delete {count} books…
        </button>
        {!online && (
          <p className="text-[12px] text-red-400">The library is offline — reconnect to act.</p>
        )}
      </div>
    </aside>
  )
}
```

- [ ] **Step 3: Write the bulk delete dialog**

Create `src/components/library/DeleteSelectionDialog.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react'
import type { BulkDeleteResult } from '@shared/api.types'
import { useLibraryStore } from '@/stores/library.store'
import { useNASStore } from '@/stores/nas.store'
import { useUIStore } from '@/stores/ui.store'
import { SpinnerIcon, TrashIcon } from '@/components/shared/icons'

const PREVIEW_TITLES = 5

/**
 * Confirmation for deleting many books. Whole books only — a per-format
 * picker across a mixed selection has no coherent meaning.
 */
export function DeleteSelectionDialog() {
  const requestSelectionDelete = useUIStore((s) => s.requestSelectionDelete)
  const selectedIds = useUIStore((s) => s.selection.ids)
  const clearSelection = useUIStore((s) => s.clearSelection)
  const selectBook = useUIStore((s) => s.selectBook)
  const books = useLibraryStore((s) => s.books)
  const online = useNASStore((s) => s.status?.state === 'connected')

  const selected = useMemo(() => books.filter((b) => selectedIds.has(b.id)), [books, selectedIds])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BulkDeleteResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) requestSelectionDelete(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestSelectionDelete, busy])

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await window.Musaeum.library.deleteBooks(selected.map((b) => b.id))
      if (res.failed.length === 0) {
        // Deleted books must not stay selected, and waiting for the library
        // reload's prune would depend on broadcast timing
        clearSelection()
        requestSelectionDelete(false)
        return
      }
      // Keep the survivors selected so the report doubles as the retry
      setResult(res)
      if (res.failed.length === 1) selectBook(res.failed[0].id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-ink-950/80 p-8 backdrop-blur-sm"
      onClick={() => !busy && requestSelectionDelete(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Delete ${selected.length} books`}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-ink-700 bg-ink-900 p-5 shadow-cover-lift"
      >
        <h2 className="font-display text-lg leading-snug text-parchment">
          Delete {selected.length} books?
        </h2>

        <ul className="mt-3 space-y-1">
          {selected.slice(0, PREVIEW_TITLES).map((b) => (
            <li key={b.id} className="truncate text-[13px] text-parchment-dim">
              {b.title}
            </li>
          ))}
          {selected.length > PREVIEW_TITLES && (
            <li className="text-[12px] text-parchment-faint">
              +{selected.length - PREVIEW_TITLES} more
            </li>
          )}
        </ul>

        <p className="mt-4 text-[12px] leading-relaxed text-parchment-dim">
          This permanently removes each book, all of its files, covers, and metadata from the
          library. This can’t be undone.
        </p>

        {!online && (
          <p className="mt-3 text-[12px] text-red-400">
            The library is offline — reconnect before deleting.
          </p>
        )}
        {error && <p className="mt-3 text-[12px] text-red-400">{error}</p>}
        {result && (
          <div className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 p-3">
            <p className="text-[12px] text-parchment-dim">
              Deleted {result.deleted}. {result.failed.length} could not be deleted and are still
              selected:
            </p>
            <ul className="mt-1.5 space-y-0.5">
              {result.failed.map((f) => (
                <li key={f.id} className="truncate text-[12px] text-red-400">
                  {f.title} — {f.error}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            disabled={busy}
            onClick={() => requestSelectionDelete(false)}
            className="rounded-md border border-ink-600 px-3 py-1.5 text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40"
          >
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result && (
            <button
              disabled={busy || !online || selected.length === 0}
              onClick={() => void confirm()}
              className="flex items-center gap-2 rounded-md bg-red-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-red-500 disabled:opacity-40"
            >
              {busy ? <SpinnerIcon className="h-4 w-4" /> : <TrashIcon className="h-4 w-4" />}
              Delete {selected.length} books
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Mount both in `App.tsx`**

Add the imports:

```ts
import { DeleteSelectionDialog } from '@/components/library/DeleteSelectionDialog'
import { SelectionPanel } from '@/components/library/SelectionPanel'
```

read the flag:

```ts
  const deletingSelection = useUIStore((s) => s.deletingSelection)
```

and render them beside their single-book counterparts (`SelectionPanel` returns null below two selected, and `BookDetail` already returns null when the derived single selection is null, so no conditional is needed here):

```tsx
      <BookDetail />
      <SelectionPanel />
```

```tsx
      {deletingSelection && <DeleteSelectionDialog />}
```

- [ ] **Step 5: Verify in the running app**

Run: `npm run dev` Expected: selecting two books swaps the detail panel for the selection panel with no width change or grid re-flow; Delete opens the confirmation and removes them all; Refresh metadata starts a job whose progress appears in the status bar with a working Cancel; with a Kindle connected, Send skips books already on it and the status bar counts the transfers.

- [ ] **Step 6: Commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/components/library/SelectionPanel.tsx \
  src/components/library/DeleteSelectionDialog.tsx src/stores/ui.store.ts \
  src/hooks/useBookNavigation.ts src/App.tsx
git commit -m "feat: selection panel with bulk delete, send and refresh"
```

---

### Task 10: Selection-aware context menu

**Files:**
- Modify: `src/components/library/BookContextMenu.tsx`
- Modify: `src/components/library/BookCard.tsx` (context-menu handler)
- Modify: `src/components/library/ListView.tsx` (context-menu handler)

**Interfaces:**
- Consumes: Tasks 2 and 9.
- Produces: nothing.

- [ ] **Step 1: Replace the selection when right-clicking outside it**

The rule is Finder's: right-clicking a book that isn't part of the selection makes it the selection first. Add this action to `src/stores/ui.store.ts`:

```ts
  /** Right-click: books outside the selection become the selection first. */
  openContextMenuFor(target: ContextMenuTarget): void
```

```ts
      openContextMenuFor: (target) =>
        set((s) => ({
          contextMenu: target,
          selection: s.selection.ids.has(target.bookId)
            ? s.selection
            : applyClick(s.selection, target.bookId, PLAIN_CLICK, bookOrder())
        })),
```

In `BookCard.tsx` and in `ListView.tsx`'s `Row`, swap `openContextMenu` for `openContextMenuFor` (same call shape).

- [ ] **Step 2: Show selection-scoped items for a multi-selection**

In `src/components/library/BookContextMenu.tsx`, add the reads:

```ts
  const count = useUIStore(selectionCount)
  const clearSelection = useUIStore((s) => s.clearSelection)
  const requestSelectionDelete = useUIStore((s) => s.requestSelectionDelete)
```

and, immediately after the `if (!book) return null` guard, branch:

```tsx
  if (count >= 2) {
    return (
      <div className="fixed inset-0 z-50" onClick={closeContextMenu} onContextMenu={closeContextMenu}>
        <div
          ref={ref}
          role="menu"
          onClick={(e) => e.stopPropagation()}
          style={{ left: pos.x, top: pos.y }}
          className="absolute w-52 animate-fade-in overflow-hidden rounded-lg border border-ink-700 bg-ink-850 py-1 shadow-cover-lift"
        >
          <p className="px-3 py-1 font-display text-[12px] text-parchment-faint">
            {count} books selected
          </p>
          <div className="my-1 h-px bg-ink-700" />
          {/* Per-book actions are absent rather than disabled: silently
              applying "Read" to one book of twelve is worse than not offering
              it. */}
          <MenuItem
            icon={<CloseIcon className="h-3.5 w-3.5" />}
            label="Clear selection"
            onClick={() => {
              clearSelection()
              closeContextMenu()
            }}
          />
          <MenuItem
            icon={<TrashIcon className="h-3.5 w-3.5" />}
            label={`Delete ${count} books…`}
            danger
            onClick={() => requestSelectionDelete(true)}
          />
        </div>
      </div>
    )
  }
```

Add `CloseIcon` and `selectionCount` to that file's imports.

- [ ] **Step 2b: Keep the menu positioned**

The `useLayoutEffect` that flips the menu inside the window measures `ref.current`, which now belongs to whichever branch rendered. No change is needed — but confirm by right-clicking a multi-selection near the bottom-right corner of the window and checking the menu stays on screen.

- [ ] **Step 3: Verify in the running app**

Run: `npm run dev` Expected: right-clicking a book inside a multi-selection shows the count, Clear and Delete N; right-clicking a book outside it selects that one book and shows the normal single-book menu.

- [ ] **Step 4: Commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/components/library/BookContextMenu.tsx src/components/library/BookCard.tsx \
  src/components/library/ListView.tsx src/stores/ui.store.ts
git commit -m "feat: selection-scoped context menu"
```

---

### Task 11: Documentation and live verification

**Files:**
- Modify: `CLAUDE.md`
- Modify: `tasks.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Document the selection model in `CLAUDE.md`**

Replace the **Selection & keyboard navigation** section's first paragraph so it describes a selection rather than one book, and add underneath it:

```markdown
Selection is a `Selection` (`src/lib/selection.ts`): a `Set` of ids plus an
**anchor** (the range pivot, set by plain and ⌘ clicks) and a **cursor** (the
keyboard focus, moved by ⇧ clicks and ⇧ arrows). Two fields, because a single
"lead" cannot express both — repeated ⇧-clicks must re-range from one pivot
rather than creep. The grammar lives in that pure module and is unit-tested
there; views call `select(id, modifiersFrom(event))` and never do set math.
`selectedBookId` survives as a **derived** selector — the id when exactly one
book is selected, null otherwise — which is why the detail panel, the metadata
editor and the single-book delete dialog needed no changes.

`useLibrary` prunes the selection to the loaded books on every library change.
Without it, selecting twelve books and then searching leaves them selected but
invisible, and "Delete 12 books" would delete books the user cannot see. The
cost — narrowing a filter drops the selection — is deliberate.

**⌘A is a menu command, not a key listener.** The Edit menu's
`{ role: 'selectAll' }` owns that accelerator, so `menu.ts` replaces it with a
custom item and `useMenuCommands` routes by focus: an input or textarea gets
`select()`, anything else selects every loaded book.
```

Add a **Bulk actions** section after Deletion:

```markdown
### Bulk actions

Three, and deliberately not symmetric — the services under them are not.

- **Delete** — `book-delete.deleteBooks(ids)`. Not a loop over `deleteBook`:
  that removes each book from the catalog individually, and every one of those
  enqueues a whole-file rewrite of `catalog.json` over SMB plus a
  `libraryChanged` broadcast that reloads the library. This does the per-book
  work with no catalog contact and finishes with one `writeFullCatalog()`. A
  single failure never aborts the rest; the result carries `failed` and those
  books stay selected so the report doubles as the retry.
- **Send to device** — no main-process work at all. `sendToDevice` returns as
  soon as the job is enqueued and the transfer queue is already serial, so
  `device.store.sendBooksToDevice` loops the existing IPC and `StatusBar`
  counts the jobs for free. Books already on the device are skipped, using the
  same scanned presence map the card badge uses.
- **Re-hydrate** — `services/bulk-hydrate.ts`, a real job: sequential (the
  sidecar's thread pool would otherwise fan out concurrent hydrations at
  rate-limited APIs), cancellable, and batched via a `batched` option on
  `importer.hydrate` that suppresses its per-book `upsertCatalog` and
  `libraryChanged` so the job can write the catalog once at the end. Cancelling
  stops the loop, not the book in flight. Progress and Cancel live in
  `StatusBar`, because the job outlives the selection.

`findHydratableFile` is shared between the bulk job and the single-book
`metadata:rehydrateBook` handler so the two cannot disagree about what a book
can be hydrated from. PDF-only books have nothing, and are skipped, not failed.
```

Add the new API entries to the `MusaeumAPI` block in that file: `library.deleteBooks`, `metadata.rehydrateBooks`, `metadata.cancelRehydrate`, `on.bulkHydrateProgress`.

- [ ] **Step 2: Update `tasks.md`**

Add to the Phase 1.5 quality list:

```markdown
- [x] **Multi-book selection and bulk actions** — shipped 2026-08-14.
      ⌘-click and ⇧-click in both views, a checkbox column with select-all in
      the list, a selection panel in the detail slot, and three bulk actions:
      delete (batched, one catalog write), send to device (loop onto the
      serial queue), re-hydrate (sequential cancellable job). Design:
      `docs/superpowers/specs/2026-08-14-multi-book-selection-design.md`.
- [ ] **Bulk metadata edit** — apply a field across a selection: add tags, set
      series, set read status. The one group-meaningful action left out of the
      selection work above; it needs its own modal and an "only changed
      fields" write like `BookEditor`'s.
```

- [ ] **Step 3: Update `CHANGELOG.md`** following the existing entry style.

- [ ] **Step 4: Run the full verification pass**

```bash
npm run typecheck && npm run lint && npm test
```

Then use the `verify` skill to drive an isolated instance, and confirm each of:

1. ⌘-click adds and removes in both views; ⇧-click ranges; a second ⇧-click re-ranges from the same anchor rather than creeping
2. The list's checkbox column and header select-all (checked, indeterminate, empty), and that `document.querySelector('tbody tr:not([aria-hidden])')` still measures **36px** tall
3. ⌘A selects all books; ⌘A inside the search field still selects its text
4. ⇧+arrow extends; Escape clears
5. Bulk delete of several books: one confirmation, all removed, `catalog.json` correct afterwards
6. Bulk re-hydrate: status bar counts up, Cancel stops it within one book
7. Bulk send with a device attached: books already present are skipped
8. Selecting and deselecting does not re-flow or drift the grid's scroll position

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md tasks.md CHANGELOG.md
git commit -m "docs: record multi-book selection and bulk actions"
```
