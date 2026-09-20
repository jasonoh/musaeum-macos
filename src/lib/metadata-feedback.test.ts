import { describe, expect, it } from 'vitest'
import type { BulkHydrateProgress } from '@shared/metadata.types'
import { describeBulkHydrate, describeHydrate, fieldSummary } from './metadata-feedback'

const BULK_BASE: BulkHydrateProgress = {
  completed: 0,
  total: 0,
  failed: 0,
  skipped: 0,
  updated: 0,
  duplicates: 0,
  running: false
}

describe('fieldSummary', () => {
  it('names fields in the shared display order, not the order they changed', () => {
    expect(fieldSummary(['series', 'cover', 'title'])).toBe('Title, cover and series')
  })

  it('reads naturally for one field', () => {
    expect(fieldSummary(['cover'])).toBe('Cover')
  })

  it('lowercases everything after the first label', () => {
    expect(fieldSummary(['title', 'published_date'])).toBe('Title and published date')
  })

  it('summarizes the tail once more than three fields changed', () => {
    expect(fieldSummary(['title', 'cover', 'author', 'series', 'tags'])).toBe(
      'Title, cover and 3 more'
    )
  })
})

describe('describeHydrate', () => {
  it('reports what changed on success', () => {
    const t = describeHydrate({ ok: true, changed: ['cover', 'series'], conflicts: 0 }, 'Dune')
    expect(t).toMatchObject({
      kind: 'success',
      message: 'Metadata updated',
      detail: 'Cover and series'
    })
  })

  it('says so when nothing changed — the case that used to be invisible', () => {
    const t = describeHydrate({ ok: true, changed: [], conflicts: 0 }, 'Dune')
    expect(t).toMatchObject({
      kind: 'info',
      message: 'No new metadata found',
      detail: 'Dune already has the latest details'
    })
  })

  it('offers a review when conflicts were queued alongside changes', () => {
    const t = describeHydrate({ ok: true, changed: ['title'], conflicts: 2 }, 'Dune')
    expect(t.kind).toBe('success')
    expect(t.detail).toBe('Title · 2 to review')
    expect(t.actionLabel).toBe('Review')
  })

  it('does not claim an update when the only outcome was a conflict', () => {
    const t = describeHydrate({ ok: true, changed: [], conflicts: 1 }, 'Dune')
    expect(t).toMatchObject({
      kind: 'info',
      message: '1 field needs review',
      actionLabel: 'Review'
    })
  })

  it('names the book and the reason on failure', () => {
    const t = describeHydrate(
      { ok: false, error: 'Sidecar call hydrate_metadata timed out' },
      'Dune'
    )
    expect(t).toMatchObject({
      kind: 'error',
      message: 'Metadata refresh failed',
      detail: 'Dune · Sidecar call hydrate_metadata timed out'
    })
  })

  it('keeps a long failure on one line', () => {
    const t = describeHydrate({ ok: false, error: `${'x'.repeat(400)}\n  more` }, 'Dune')
    expect(t.detail!.length).toBeLessThanOrEqual(200)
    expect(t.detail).not.toContain('\n')
  })

  /**
   * The collision a fetch revealed — the one place the refresh report carries
   * news the user did not ask for, and the only one it cannot fix itself.
   */
  const DUPLICATE = {
    existingBookId: 'b',
    existingTitle: 'Summary of Fair Play',
    existingAuthor: 'Ctprint',
    matchType: 'isbn' as const
  }

  it('leads with the collision and keeps what the run changed', () => {
    const t = describeHydrate(
      { ok: true, changed: ['title'], conflicts: 0, duplicate: DUPLICATE },
      'Fair Play'
    )
    expect(t).toEqual({
      kind: 'info',
      message: 'Possible duplicate',
      detail: 'Title · same ISBN as “Summary of Fair Play”'
    })
  })

  it('still says it when nothing else changed', () => {
    const t = describeHydrate(
      { ok: true, changed: [], conflicts: 0, duplicate: DUPLICATE },
      'Fair Play'
    )
    expect(t).toMatchObject({
      kind: 'info',
      message: 'Possible duplicate',
      detail: 'No new metadata · same ISBN as “Summary of Fair Play”'
    })
  })

  it('offers no action for a duplicate — the pair is a person’s to judge', () => {
    const t = describeHydrate(
      { ok: true, changed: [], conflicts: 0, duplicate: DUPLICATE },
      'Fair Play'
    )
    expect(t.actionLabel).toBeUndefined()
  })
})

describe('describeBulkHydrate', () => {
  it('stays quiet for an empty job', () => {
    expect(describeBulkHydrate(BULK_BASE)).toBeNull()
  })

  it('reports a clean run as updated plus already-current', () => {
    const t = describeBulkHydrate({
      ...BULK_BASE,
      completed: 10,
      total: 10,
      updated: 4,
      skipped: 1
    })
    expect(t).toMatchObject({
      kind: 'success',
      message: 'Refreshed 10 books',
      detail: '4 updated · 5 already up to date · 1 skipped'
    })
  })

  it('says nothing was new rather than claiming a refresh', () => {
    const t = describeBulkHydrate({ ...BULK_BASE, completed: 3, total: 3, updated: 0 })
    expect(t).toMatchObject({ kind: 'info', message: 'No new metadata found' })
  })

  it('counts the duplicates the job found', () => {
    const t = describeBulkHydrate({
      ...BULK_BASE,
      completed: 3,
      total: 3,
      updated: 1,
      duplicates: 2
    })
    expect(t).toMatchObject({
      kind: 'success',
      message: 'Refreshed 3 books',
      detail: '1 updated · 2 already up to date · 2 possible duplicates'
    })
  })

  it('reports a duplicate even when the job changed nothing', () => {
    const t = describeBulkHydrate({ ...BULK_BASE, completed: 2, total: 2, duplicates: 1 })
    expect(t?.detail).toBe('All 2 books already have the latest details · 1 possible duplicate')
  })

  it('distinguishes a cancel from the library dropping out', () => {
    const cancelled = describeBulkHydrate({
      ...BULK_BASE,
      completed: 2,
      total: 9,
      updated: 2,
      stopped: 'cancelled'
    })
    const offline = describeBulkHydrate({
      ...BULK_BASE,
      completed: 2,
      total: 9,
      updated: 2,
      stopped: 'offline'
    })
    expect(cancelled!.kind).toBe('info')
    expect(offline!.kind).toBe('error')
    expect(offline!.detail).toBe('2 of 9 refreshed · 2 updated')
  })

  it('surfaces the last failure rather than only a count', () => {
    const t = describeBulkHydrate({
      ...BULK_BASE,
      completed: 5,
      total: 5,
      updated: 3,
      failed: 2,
      lastError: 'Python sidecar is unavailable'
    })
    expect(t).toMatchObject({
      kind: 'error',
      message: 'Refresh failed for 2 of 5 books',
      detail: 'Python sidecar is unavailable'
    })
  })
})
