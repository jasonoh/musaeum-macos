import { describe, expect, it } from 'vitest'
import type { CatalogSyncState } from '@shared/book.types'
import {
  applyRebuildProgress,
  describeCatalogSync,
  settleCatalogSync,
  startCatalogSync
} from './catalog-sync'

function state(over: Partial<CatalogSyncState>): CatalogSyncState {
  return { kind: 'rebuild', completed: 0, total: null, outcome: 'running', books: null, ...over }
}

/**
 * The line's job is to make the *cheap* action and the *twenty-minute* one
 * distinguishable, and to survive the Settings dialog that started it. Both the
 * verb and the settled states are therefore wording with a decider.
 */
describe('describeCatalogSync', () => {
  it('names the job a refresh and a rebuild differently while running', () => {
    expect(describeCatalogSync(state({ kind: 'refresh' })).text).toBe('Reloading library')
    expect(describeCatalogSync(state({ kind: 'rebuild' })).text).toBe('Rebuilding catalog')
  })

  it('shows a folder count only once the walk has reported one', () => {
    // A refresh never reports a total, and a rebuild's first tick has not
    // arrived yet — both must render as a bare verb rather than "0/null"
    expect(describeCatalogSync(state({ kind: 'refresh', total: null })).progress).toBeNull()
    expect(describeCatalogSync(state({ kind: 'rebuild', total: null })).progress).toBeNull()
    expect(describeCatalogSync(state({ completed: 412, total: 7101 })).progress).toBe('412/7101')
  })

  it('is busy only while running', () => {
    expect(describeCatalogSync(state({ outcome: 'running' })).tone).toBe('busy')
    expect(describeCatalogSync(state({ outcome: 'done', books: 1 })).tone).toBe('done')
    expect(describeCatalogSync(state({ outcome: 'cancelled' })).tone).toBe('stopped')
    expect(describeCatalogSync(state({ outcome: 'failed' })).tone).toBe('stopped')
  })

  it('names a failure as a failure, and says which job failed', () => {
    expect(describeCatalogSync(state({ outcome: 'failed' })).text).toBe(
      'Couldn’t reload the catalog'
    )
    expect(describeCatalogSync(state({ kind: 'refresh', outcome: 'failed' })).text).toBe(
      'Couldn’t reload the library'
    )
  })

  it('reports a cancel as a cancel, not as a missing result', () => {
    const line = describeCatalogSync(state({ outcome: 'cancelled' }))
    expect(line.text).toContain('cancelled')
    // The claim the walk's design rests on, said out loud
    expect(line.text).toContain('nothing was written')
    expect(line.progress).toBeNull()
  })

  it('counts the books it reloaded, and singularises one', () => {
    expect(describeCatalogSync(state({ outcome: 'done', books: 7101 })).text).toBe(
      'Catalog rebuilt — 7101 books'
    )
    expect(describeCatalogSync(state({ outcome: 'done', books: 1 })).text).toBe(
      'Catalog rebuilt — 1 book'
    )
    expect(describeCatalogSync(state({ kind: 'refresh', outcome: 'done', books: 2 })).text).toBe(
      'Library reloaded — 2 books'
    )
  })

  it('never claims a book count it does not have', () => {
    // A cancelled run produced no count; a done one always has one, and a null
    // must not render as "— null books"
    expect(describeCatalogSync(state({ outcome: 'done', books: null })).text).toBe(
      'Catalog rebuilt'
    )
  })
})

describe('the transitions', () => {
  it('starts a job with no counts and no result', () => {
    expect(startCatalogSync('refresh')).toEqual({
      kind: 'refresh',
      completed: 0,
      total: null,
      outcome: 'running',
      books: null
    })
  })

  it('a folder tick turns a refresh into a rebuild', () => {
    // The fallback becoming visible, which is the one place a user finds out
    // that "Reload" is going to take twenty minutes
    const ticking = applyRebuildProgress(startCatalogSync('refresh'), {
      completed: 3,
      total: 7101
    })

    expect(ticking?.kind).toBe('rebuild')
    expect(ticking?.completed).toBe(3)
    expect(describeCatalogSync(ticking as CatalogSyncState).text).toBe('Rebuilding catalog')
  })

  it('a tick with no job running changes nothing', () => {
    // The event can outlive a job whose promise already settled
    expect(applyRebuildProgress(null, { completed: 1, total: 2 })).toBeNull()
  })

  it('settling keeps the kind the run actually had, not the one it was asked for', () => {
    const wasRefresh = startCatalogSync('refresh')
    const becameRebuild = applyRebuildProgress(wasRefresh, { completed: 9, total: 9 })
    const settled = settleCatalogSync(becameRebuild, 'refresh', 'done', 7101)

    expect(settled.kind).toBe('rebuild')
    expect(describeCatalogSync(settled).text).toBe('Catalog rebuilt — 7101 books')
  })

  it('settling drops the count when the run did not finish', () => {
    // Otherwise a cancelled run's line could claim books that were never
    // reloaded — the one claim the cancel path must not make
    const cancelled = settleCatalogSync(startCatalogSync('rebuild'), 'rebuild', 'cancelled', 7101)

    expect(cancelled.books).toBeNull()
    expect(describeCatalogSync(cancelled).text).toContain('nothing was written')
  })

  it('settling falls back to the caller’s kind when nothing was running', () => {
    expect(settleCatalogSync(null, 'refresh', 'done', 2).kind).toBe('refresh')
  })
})
