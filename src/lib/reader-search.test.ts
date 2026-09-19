import { describe, expect, it } from 'vitest'
import {
  applySearchEvent,
  countHits,
  EMPTY_SEARCH,
  groupLabel,
  nextHit,
  parseSearchYield,
  runSearch,
  startSearch,
  type SearchGroup,
  type SearchRunOptions,
  type SearchSource,
  type SearchState,
  type SearchYield
} from './reader-search'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The shape the engine yields for a section that matched (`view.js:560-570`). */
function group(label: string, cfis: string[]): SearchYield {
  return {
    label,
    subitems: cfis.map((cfi) => ({
      cfi,
      excerpt: { pre: '…before ', match: 'alice', post: ' after…' }
    }))
  }
}

/**
 * A source over a recorded yield sequence, reporting whether the consumer
 * stopped it early. `returned` is how the token guard is proved: breaking the
 * `for await` is the only cancellation the engine offers, so a superseded run
 * that *stopped* shows up here as the generator's `finally` having run.
 */
function recorded(yields: SearchYield[], failAfter?: number) {
  const life = { returned: false, started: 0 }
  const source: SearchSource = {
    async *search() {
      life.started += 1
      try {
        for (const [i, value] of yields.entries()) {
          if (failAfter !== undefined && i === failAfter) throw new Error('the engine fell over')
          yield value
        }
      } finally {
        life.returned = true
      }
    }
  }
  return { source, life }
}

/** A source that pauses between two yields until `release()` is called. */
function gated(yields: SearchYield[]) {
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const source: SearchSource = {
    async *search() {
      yield yields[0]
      await gate
      for (const value of yields.slice(1)) yield value
    }
  }
  return { source, release }
}

interface Run {
  result: Awaited<ReturnType<typeof runSearch>>
  states: SearchState[]
}

function drive(source: SearchSource, over: Partial<SearchRunOptions> = {}): Promise<Run> {
  const states: SearchState[] = []
  return runSearch(source, {
    query: 'alice',
    color: '#d4a24e',
    isStale: () => false,
    onState: (state) => states.push(state),
    ...over
  }).then((result) => ({ result, states }))
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// ---------------------------------------------------------------------------

describe('parseSearchYield', () => {
  it('discriminates the three shapes the generator interleaves', () => {
    expect(parseSearchYield('done')).toEqual({ type: 'done' })
    expect(parseSearchYield({ progress: 0.25 })).toEqual({ type: 'progress', progress: 0.25 })
    expect(parseSearchYield(group('Chapter 1', ['cfi-1']))).toEqual({
      type: 'hits',
      label: 'Chapter 1',
      hits: [{ cfi: 'cfi-1', excerpt: { pre: '…before ', match: 'alice', post: ' after…' } }]
    })
  })

  it('carries an empty label through rather than inventing one', () => {
    // The fallback is `groupLabel`'s job, not the parser's: the parser reports
    // what the book said, which for a TOC-less book is nothing.
    expect(parseSearchYield(group('', ['cfi-1']))).toEqual({
      type: 'hits',
      label: '',
      hits: [{ cfi: 'cfi-1', excerpt: expect.anything() }]
    })
  })

  it('ignores a yield it does not recognise instead of throwing', () => {
    // Someone else's JavaScript: one malformed yield must not cost the reader a
    // whole book's results (invariant #12).
    expect(parseSearchYield(undefined)).toBeNull()
    expect(parseSearchYield(7)).toBeNull()
    expect(parseSearchYield({})).toBeNull()
    expect(parseSearchYield({ progress: 'half' })).toBeNull()
    expect(parseSearchYield({ label: 'x' })).toBeNull()
    expect(parseSearchYield({ subitems: 'not-an-array' })).toBeNull()
  })

  it('drops a hit with no CFI, and tolerates a partial excerpt', () => {
    const parsed = parseSearchYield({
      label: 'Part',
      subitems: [
        { excerpt: { pre: 'a', match: 'b', post: 'c' } },
        { cfi: 'cfi-2' },
        { cfi: 'cfi-3', excerpt: { match: 'only' } }
      ]
    })
    expect(parsed).toEqual({
      type: 'hits',
      label: 'Part',
      hits: [
        { cfi: 'cfi-2', excerpt: { pre: '', match: '', post: '' } },
        { cfi: 'cfi-3', excerpt: { pre: '', match: 'only', post: '' } }
      ]
    })
  })
})

describe('groupLabel', () => {
  it('names a label-less section by its place among the sections that matched', () => {
    // `view.js:564` yields the empty string when the TOC has no label, and a
    // wall of blank headers is worse than no grouping at all.
    expect(groupLabel('', 1)).toBe('Part 1')
    expect(groupLabel('   ', 3)).toBe('Part 3')
    expect(groupLabel('Chapter 2', 1)).toBe('Chapter 2')
  })
})

describe('applySearchEvent', () => {
  it('numbers hits continuously across groups, in the order they arrived', () => {
    let state = startSearch()
    state = applySearchEvent(state, { type: 'progress', progress: 0.5 })
    state = applySearchEvent(state, {
      type: 'hits',
      label: 'One',
      hits: [{ cfi: 'a', excerpt: { pre: '', match: '', post: '' } }]
    })
    state = applySearchEvent(state, {
      type: 'hits',
      label: '',
      hits: [{ cfi: 'b', excerpt: { pre: '', match: '', post: '' } }]
    })

    expect(state.results.map((g) => g.label)).toEqual(['One', 'Part 2'])
    expect(countHits(state.results)).toBe(2)
    expect(state.results.flatMap((g) => g.hits.map((h) => h.index))).toEqual([0, 1])
    expect(state.progress).toBe(0.5)
  })

  it('clamps progress to the range the panel draws', () => {
    expect(applySearchEvent(startSearch(), { type: 'progress', progress: 1.4 }).progress).toBe(1)
    expect(applySearchEvent(startSearch(), { type: 'progress', progress: -1 }).progress).toBe(0)
  })

  it('returns the same state for an event that changes nothing', () => {
    // A book where most sections match nothing: the ~390 misses must not notify
    // a subscriber each, which is what the identical return is for.
    const state = startSearch()
    expect(applySearchEvent(state, { type: 'hits', label: 'Empty', hits: [] })).toBe(state)
    expect(applySearchEvent(state, { type: 'progress', progress: 0 })).toBe(state)
    expect(applySearchEvent(EMPTY_SEARCH, { type: 'done' })).toBe(EMPTY_SEARCH)
  })

  it('settles on the terminator, and stays settled', () => {
    const searching = startSearch()
    const done = applySearchEvent(searching, { type: 'done' })
    expect(done.searching).toBe(false)
    expect(applySearchEvent(done, { type: 'done' })).toBe(done)
  })
})

describe('runSearch', () => {
  it('reports the run as it goes, and settles it at the end', async () => {
    const { source } = recorded([
      { progress: 1 / 3 },
      group('Chapter 1', ['cfi-1', 'cfi-2']),
      { progress: 2 / 3 },
      { progress: 1 },
      group('', ['cfi-3']),
      'done'
    ])

    const { result, states } = await drive(source)

    expect(result).toEqual({ outcome: 'done' })
    expect(states[0]).toEqual(startSearch())
    expect(states.at(-1)).toEqual({
      searching: false,
      progress: 1,
      results: [
        {
          label: 'Chapter 1',
          hits: [
            { cfi: 'cfi-1', excerpt: expect.anything(), index: 0 },
            { cfi: 'cfi-2', excerpt: expect.anything(), index: 1 }
          ]
        },
        {
          label: 'Part 2',
          hits: [{ cfi: 'cfi-3', excerpt: expect.anything(), index: 2 }]
        }
      ]
    })
  })

  it('settles a sequence that never says done', async () => {
    const { source } = recorded([{ progress: 0.5 }, group('One', ['cfi-1'])])
    const { result, states } = await drive(source)
    expect(result).toEqual({ outcome: 'done' })
    expect(states.at(-1)?.searching).toBe(false)
    expect(countHits(states.at(-1)?.results ?? [])).toBe(1)
  })

  it('refuses an empty query before a generator exists', async () => {
    // The matcher would otherwise match at every position in the book.
    const { source, life } = recorded(['done'])
    const { result, states } = await drive(source, { query: '   ' })
    expect(result).toEqual({ outcome: 'done' })
    expect(states).toEqual([])
    expect(life.started).toBe(0)
  })

  it('reports a failed run rather than leaving the panel searching', async () => {
    // The engine throws on its second section, after one progress report
    const { source } = recorded([{ progress: 0.5 }, group('One', ['cfi-1'])], 1)
    const { result, states } = await drive(source)
    expect(result).toEqual({ outcome: 'failed', message: 'the engine fell over' })
    expect(states.at(-1)?.searching).toBe(false)
    // Non-fatal (invariant #12): the failure is reported, and the results found
    // before it are not thrown away
    expect(states.at(-1)?.progress).toBe(0.5)
  })
})

/**
 * The token guard (AC1.13). This is the criterion that would otherwise be
 * decided by a user pressing Enter twice: `search()` calls `clearSearch()` on
 * entry, so the *second* run's highlights are the only ones on the page, and a
 * first run still writing would put hits for an abandoned query in front of
 * them.
 */
describe('a superseded run', () => {
  it('stops writing, and unwinds the generator it is inside', async () => {
    const { source, life } = recorded([
      group('One', ['cfi-1']),
      { progress: 1 },
      group('Two', ['cfi-2']),
      'done'
    ])

    let stale = false
    let emitAfterStale = false
    const states: SearchState[] = []

    // Superseded as soon as the first section's hits land — the moment a second
    // run would start in the app. Driven from inside the loop rather than from a
    // timer: the whole recorded sequence drains through microtasks, so anything
    // awaited here would let the run finish before the flip.
    const result = await runSearch(source, {
      query: 'alice',
      color: '#d4a24e',
      isStale: () => stale,
      onState: (state) => {
        if (stale) emitAfterStale = true
        states.push(state)
        if (countHits(state.results) > 0) stale = true
      }
    })

    expect(result).toEqual({ outcome: 'stale' })
    expect(emitAfterStale).toBe(false)
    // One start, one section's hits, and nothing after the flip
    expect(states).toHaveLength(2)
    // The engine has no abort of its own: breaking the `for await` is what
    // stopped it, so the generator's own cleanup is the proof it stopped
    expect(life.returned).toBe(true)
  })

  it('leaves the states of a run it superseded out of the display', async () => {
    const first = gated([group('First', ['cfi-first']), { progress: 1 }])
    const second = recorded([group('Second', ['cfi-second']), 'done'])

    let token = 0
    let displayed: SearchState = EMPTY_SEARCH

    // The panel's own shape: one token, bumped by whatever starts next
    const start = (source: SearchSource) => {
      const mine = ++token
      return runSearch(source, {
        query: 'alice',
        color: '#d4a24e',
        isStale: () => token !== mine,
        onState: (state) => {
          if (token === mine) displayed = state
        }
      })
    }

    const a = start(first.source)
    await tick()
    expect(displayed.results.map((g) => g.label)).toEqual(['First'])

    const b = start(second.source)
    first.release()

    expect(await a).toEqual({ outcome: 'stale' })
    expect(await b).toEqual({ outcome: 'done' })

    expect(displayed.results.map((g) => g.label)).toEqual(['Second'])
    expect(JSON.stringify(displayed)).not.toContain('cfi-first')
  })
})

describe('nextHit', () => {
  const groups: SearchGroup[] = [
    { label: 'One', hits: [{ cfi: 'a', excerpt: { pre: '', match: '', post: '' }, index: 0 }] },
    { label: 'Two', hits: [{ cfi: 'b', excerpt: { pre: '', match: '', post: '' }, index: 1 }] }
  ]

  it('steps from the active hit', () => {
    expect(nextHit(groups, 'a')?.cfi).toBe('b')
  })

  it('wraps at the end, so the last hit is not a dead key', () => {
    expect(nextHit(groups, 'b')?.cfi).toBe('a')
  })

  it('starts at the first hit with nothing active — or an active hit that is gone', () => {
    expect(nextHit(groups, null)?.cfi).toBe('a')
    // A stale CFI cannot be matched against the new results, and stepping from
    // nowhere is the only honest answer
    expect(nextHit(groups, 'gone')?.cfi).toBe('a')
  })

  it('has nowhere to go with no results', () => {
    expect(nextHit([], 'a')).toBeNull()
  })
})
