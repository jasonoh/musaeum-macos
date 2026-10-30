import { expect, it } from 'vitest'
import { BUCKETS, bucketFromSlug, bucketSlug, initialBucket } from './initials'

it('buckets by the first letter, case-insensitively', () => {
  expect(initialBucket('Dickinson, Seth')).toBe('D')
  expect(initialBucket('dune')).toBe('D')
})

it('folds accents through NFD', () => {
  expect(initialBucket('Éric Vuillard')).toBe('E')
  expect(initialBucket('Ångström')).toBe('A')
})

it('puts Ł in # because it has no NFD decomposition (the known limit)', () => {
  expect(initialBucket('Łukasz')).toBe('#')
})

it('skips leading punctuation', () => {
  expect(initialBucket("'Salem's Lot")).toBe('S')
  expect(initialBucket('"Hello"')).toBe('H')
})

it('sends digits, non-Latin scripts and empties to #', () => {
  expect(initialBucket('1984')).toBe('#')
  expect(initialBucket('東野圭吾')).toBe('#')
  expect(initialBucket('')).toBe('#')
  expect(initialBucket('   ')).toBe('#')
  expect(initialBucket(null)).toBe('#')
  expect(initialBucket(undefined)).toBe('#')
  expect(initialBucket('—')).toBe('#')
})

it('lists A-Z then #', () => {
  expect(BUCKETS).toHaveLength(27)
  expect(BUCKETS[0]).toBe('A')
  expect(BUCKETS[25]).toBe('Z')
  expect(BUCKETS[26]).toBe('#')
})

it('parses slugs case-insensitively and rejects everything else', () => {
  expect(bucketFromSlug('s')).toBe('S')
  expect(bucketFromSlug('other')).toBe('#')
  for (const bad of ['', 'AB', '1', '#', '%41']) expect(bucketFromSlug(bad)).toBeNull()
})

it('round-trips every bucket through its slug', () => {
  expect(bucketSlug('#')).toBe('other')
  for (const b of BUCKETS) expect(bucketFromSlug(bucketSlug(b))).toBe(b)
})
