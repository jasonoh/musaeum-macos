import { describe, expect, it } from 'vitest'
import { parseOwnedFields, reconcileOwnedFields, sameOwnedFields } from './owned-fields'

const T1 = '2026-10-11T10:00:00.000Z'
const T2 = '2026-10-11T11:00:00.000Z'

describe('parseOwnedFields', () => {
  it('accepts a map of known fields to time strings', () => {
    expect(parseOwnedFields({ author: T1, tags: T2 })).toEqual({ author: T1, tags: T2 })
  })
  it('accepts the JSON text a column holds', () => {
    expect(parseOwnedFields(JSON.stringify({ author: T1 }))).toEqual({ author: T1 })
  })
  it.each([null, undefined, 7, 'not json', '[]', [], ['author'], true])(
    'reads %j as no locks',
    (bad) => expect(parseOwnedFields(bad)).toEqual({})
  )
  it('drops an unknown field and a non-string time, keeps the rest', () => {
    expect(parseOwnedFields({ author: T1, sort_title: T1, tags: 5, title: '' })).toEqual({
      author: T1
    })
  })
})

describe('reconcileOwnedFields', () => {
  it('takes a claim only the incoming record has', () => {
    expect(reconcileOwnedFields({}, { author: T1 }, T1)).toEqual({ author: T1 })
  })
  it('keeps the newer of two claims on the same field', () => {
    expect(reconcileOwnedFields({ author: T2 }, { author: T1 }, T2)).toEqual({ author: T2 })
    expect(reconcileOwnedFields({ author: T1 }, { author: T2 }, T2)).toEqual({ author: T2 })
  })
  it('keeps the incoming entry on a tie', () => {
    expect(reconcileOwnedFields({ author: T1 }, { author: T1 }, T1)).toEqual({ author: T1 })
  })
  it('keeps the incoming entry on a tie of instants spelled differently', () => {
    const SAME_AS_T1 = '2026-10-11T10:00:00Z'
    expect(reconcileOwnedFields({ author: SAME_AS_T1 }, { author: T1 }, T1)).toEqual({ author: T1 })
  })
  it('lets an unparseable local time lose to the incoming one', () => {
    expect(reconcileOwnedFields({ author: 'garbage' }, { author: T1 }, T1)).toEqual({ author: T1 })
  })
  it('drops a local claim the incoming record released (record is newer than the claim)', () => {
    expect(reconcileOwnedFields({ author: T1 }, {}, T2)).toEqual({})
  })
  it('keeps a local claim made after the incoming record was written', () => {
    expect(reconcileOwnedFields({ author: T2 }, {}, T1)).toEqual({ author: T2 })
  })
  it('keeps a local claim when the incoming record has no modified time (Review Focus 2)', () => {
    expect(reconcileOwnedFields({ author: T1 }, {}, null)).toEqual({ author: T1 })
    expect(reconcileOwnedFields({ author: T1 }, {}, 'garbage')).toEqual({ author: T1 })
  })
  it('keeps a local claim whose time equals the record’s (an upgrade seeds exactly that)', () => {
    expect(reconcileOwnedFields({ author: T1 }, {}, T1)).toEqual({ author: T1 })
  })
})

describe('sameOwnedFields', () => {
  it('compares by content, not key order', () => {
    expect(sameOwnedFields({ author: T1, tags: T2 }, { tags: T2, author: T1 })).toBe(true)
    expect(sameOwnedFields({ author: T1 }, { author: T2 })).toBe(false)
    expect(sameOwnedFields({}, { author: T1 })).toBe(false)
  })
})
