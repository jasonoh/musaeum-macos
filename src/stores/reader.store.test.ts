import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PREFS,
  PREF_RANGES,
  persistedReaderState,
  sanitizePrefs,
  useReaderStore,
  type SearchPatch
} from './reader.store'
import { countHits } from '@/lib/reader-search'
import { makeBook } from '../../test/helpers/book'

/**
 * A run in flight with one hit already in — what the store looks like between
 * the start of a search and its terminator. The panel writes this shape through
 * `setSearchState`, one reduced state per yield.
 */
function searchingWithHits(): SearchPatch {
  return {
    searching: true,
    progress: 0.5,
    results: [
      {
        label: 'Chapter 1',
        hits: [{ cfi: 'cfi-1', excerpt: { pre: 'a', match: 'b', post: 'c' }, index: 0 }]
      }
    ]
  }
}

/**
 * `localStorage` is only as trustworthy as the build that wrote it: these are
 * the shapes a stale or hand-edited `musaeum.reader` entry can hand back, all
 * of which the popover and the engine's injected CSS would otherwise consume
 * unchecked.
 */
describe('sanitizePrefs', () => {
  it('fills in everything a missing or non-object entry leaves out', () => {
    expect(sanitizePrefs(undefined)).toEqual(DEFAULT_PREFS)
    expect(sanitizePrefs(null)).toEqual(DEFAULT_PREFS)
    expect(sanitizePrefs('serif')).toEqual(DEFAULT_PREFS)
    expect(sanitizePrefs({})).toEqual(DEFAULT_PREFS)
  })

  it('keeps a valid value for every field', () => {
    const prefs = { typeface: 'sans', theme: 'paper', fontSize: 22, lineHeight: 1.8, margin: 96 }
    expect(sanitizePrefs(prefs)).toEqual(prefs)
  })

  it('rejects values outside the union', () => {
    expect(sanitizePrefs({ typeface: 'comic' }).typeface).toBe(DEFAULT_PREFS.typeface)
    expect(sanitizePrefs({ theme: 'sepia' }).theme).toBe(DEFAULT_PREFS.theme)
    expect(sanitizePrefs({ typeface: 7 }).typeface).toBe(DEFAULT_PREFS.typeface)
  })

  it('rejects numbers that are the wrong type, unbounded, or out of range', () => {
    expect(sanitizePrefs({ fontSize: '22' }).fontSize).toBe(DEFAULT_PREFS.fontSize)
    expect(sanitizePrefs({ fontSize: NaN }).fontSize).toBe(DEFAULT_PREFS.fontSize)
    expect(sanitizePrefs({ fontSize: Infinity }).fontSize).toBe(DEFAULT_PREFS.fontSize)
    expect(sanitizePrefs({ fontSize: PREF_RANGES.fontSize.max + 1 }).fontSize).toBe(
      DEFAULT_PREFS.fontSize
    )
    expect(sanitizePrefs({ margin: -40 }).margin).toBe(DEFAULT_PREFS.margin)
    expect(sanitizePrefs({ lineHeight: 0 }).lineHeight).toBe(DEFAULT_PREFS.lineHeight)
  })

  it('keeps the slider bounds themselves', () => {
    expect(sanitizePrefs({ fontSize: PREF_RANGES.fontSize.min }).fontSize).toBe(
      PREF_RANGES.fontSize.min
    )
    expect(sanitizePrefs({ margin: PREF_RANGES.margin.max }).margin).toBe(PREF_RANGES.margin.max)
  })

  it('falls back one field at a time rather than discarding the object', () => {
    // One stale value must not cost someone the rest of their typography
    expect(sanitizePrefs({ typeface: 'sans', theme: 'midnight', fontSize: 24 })).toEqual({
      ...DEFAULT_PREFS,
      typeface: 'sans',
      fontSize: 24
    })
  })
})

/**
 * The ask panel's wiring, as opposed to its decisions (`src/lib/ask-session.ts`
 * owns those). What is tested here is the routing — which stream an event lands
 * in, and what happens to an event for a request nobody is waiting on — because
 * that is the part a reader of `ReaderAsk.tsx` cannot check by looking.
 */
describe('the ask stream', () => {
  const get = () => useReaderStore.getState()

  const SECTION = `Alice was beginning to get very tired of sitting by her sister on the bank, and of having nothing to do.`
  const VERBATIM_OPENING = `RECALL: yes\nOPENING: Alice was beginning to get very tired of sitting by her sister`

  beforeEach(() => {
    // The store is a singleton across this file; `close()` is its reset
    get().close()
  })

  it('keeps the probe’s reply out of the transcript', () => {
    get().openBook(makeBook('b1'))
    get().beginProbe('p1')
    get().aiChunk({ requestId: 'p1', delta: 'RECALL: no\n' })
    get().aiChunk({ requestId: 'p1', delta: 'OPENING:' })
    expect(get().askSession.turns).toEqual([])

    get().aiDone({ requestId: 'p1', reason: 'stop' })
    expect(get().askSession.turns).toEqual([])
    expect(get().askProbe).toBeNull()
    expect(get().askVerdict).toBe('weak')
  })

  it('scores the probe against the section the engine reported', () => {
    get().setSection({ index: 3, text: SECTION })
    get().beginProbe('p1')
    get().aiChunk({ requestId: 'p1', delta: VERBATIM_OPENING })
    get().aiDone({ requestId: 'p1', reason: 'stop' })

    expect(get().askVerdict).toBe('strong')
    expect(get().askRung).toBe('pointer')
  })

  it('widens the rung for a weak verdict, and the switch cannot narrow it back', () => {
    get().setSection({ index: 3, text: SECTION })
    get().beginProbe('p1')
    get().aiChunk({ requestId: 'p1', delta: 'RECALL: no\nOPENING:' })
    get().aiDone({ requestId: 'p1', reason: 'stop' })

    expect(get().askRung).toBe('passage')
    get().setOverride(false)
    expect(get().askRung).toBe('passage')
  })

  it('widens on the switch for a verdict that already held up', () => {
    get().setVerdict('strong')
    expect(get().askRung).toBe('pointer')
    get().setOverride(true)
    expect(get().askRung).toBe('passage')
    get().setOverride(false)
    expect(get().askRung).toBe('pointer')
  })

  it('keeps a failed probe out of the transcript and leaves the verdict unverified', () => {
    get().setSection({ index: 0, text: SECTION })
    get().beginProbe('p1')
    get().aiError({ requestId: 'p1', message: 'Nothing is listening at http://localhost:11434/v1' })

    expect(get().askProbe).toBeNull()
    expect(get().askVerdict).toBe('unknown')
    expect(get().askRung).toBe('pointer')
    // Not an error the panel reports: the failure was the probe's, and the
    // reader can still ask — D6's non-fatal rule
    expect(get().askSession.phase).toBe('idle')
    expect(get().askSession.notice).toBeNull()
  })

  it('routes a question, its chunks and its terminal event', () => {
    get().beginAsk('q1', 'Who is Alice?')
    get().aiChunk({ requestId: 'q1', delta: 'Alice ' })
    get().aiChunk({ requestId: 'q1', delta: 'is a girl.' })
    expect(get().askSession.turns).toEqual([
      { role: 'user', text: 'Who is Alice?' },
      { role: 'assistant', text: 'Alice is a girl.', streaming: true }
    ])

    get().aiDone({ requestId: 'q1', reason: 'stop' })
    expect(get().askSession.phase).toBe('idle')
    expect(get().askSession.turns[1].streaming).toBeUndefined()
  })

  it('reports a failed question as an error rather than a silent stop', () => {
    get().beginAsk('q1', 'Who is Alice?')
    get().aiError({
      requestId: 'q1',
      message: 'Nothing is listening at http://localhost:11434/v1'
    })
    expect(get().askSession.phase).toBe('error')
    expect(get().askSession.notice).toBe('Nothing is listening at http://localhost:11434/v1')
  })

  it('drops a late chunk from a question that has been superseded', () => {
    get().beginAsk('q1', 'first')
    get().beginAsk('q2', 'second')
    get().aiChunk({ requestId: 'q1', delta: 'late' })
    expect(get().askSession.turns).toEqual([
      { role: 'user', text: 'first' },
      { role: 'user', text: 'second' },
      { role: 'assistant', text: '', streaming: true }
    ])
  })

  /**
   * The mechanism the reducer's identity returns depend on: a chunk nobody is
   * waiting for must not merely leave the state equal — it must not notify, or
   * every panel in the app re-renders on every stale chunk.
   */
  it('does not notify subscribers for an event nobody is waiting on', () => {
    const listener = vi.fn()
    const unsubscribe = useReaderStore.subscribe(listener)
    get().aiChunk({ requestId: 'nobody', delta: 'x' })
    get().aiDone({ requestId: 'nobody', reason: 'stop' })
    get().aiError({ requestId: 'nobody', message: 'x' })
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })
})

describe('the reader’s one side slot (D4)', () => {
  const get = () => useReaderStore.getState()
  const occupants = () => [get().tocOpen, get().searchOpen, get().askOpen]

  it('opens any one of the three by closing the other two', () => {
    get().toggleToc()
    expect(occupants()).toEqual([true, false, false])

    get().toggleSearch()
    expect(occupants()).toEqual([false, true, false])

    get().toggleAsk()
    expect(occupants()).toEqual([false, false, true])

    get().toggleSearch()
    expect(occupants()).toEqual([false, true, false])

    get().toggleToc()
    expect(occupants()).toEqual([true, false, false])
  })

  it('closes the search panel on its own toggle, and takes the run with it', () => {
    get().toggleSearch()
    get().setQuery('alice')
    get().setSearchState(searchingWithHits())
    get().toggleSearch()

    expect(get().searchOpen).toBe(false)
    expect([get().query, get().searching, countHits(get().results), get().activeCfi]).toEqual([
      '',
      false,
      0,
      null
    ])
  })

  it('leaves the typography popover alone — it is not in the slot', () => {
    get().togglePrefs()
    get().toggleAsk()
    expect(get().prefsOpen).toBe(true)
    expect(get().askOpen).toBe(true)
  })

  /**
   * AC1.8, over the serialized whole rather than the field we suspect: the
   * absence that matters is that nothing about a search reaches storage — not
   * the query, not the CFIs, not the active hit.
   */
  it('persists nothing of a search', () => {
    const QUERY = 'sentinel-query-hobbit'
    const CFI = 'sentinel-cfi(/6/4!/4/2)'
    get().toggleSearch()
    get().setQuery(QUERY)
    get().setSearchState({
      ...searchingWithHits(),
      results: [
        {
          label: 'Chapter 1',
          hits: [{ cfi: CFI, excerpt: { pre: 'a', match: 'b', post: 'c' }, index: 0 }]
        }
      ],
      activeCfi: CFI
    })

    // Over the serialized whole, not the field we suspect, and against the very
    // function the middleware is given — the test env has no `localStorage`, so
    // zustand returns the config untouched and `.persist` is not attached.
    const serialized = JSON.stringify(persistedReaderState(get()))

    expect(serialized).not.toContain(QUERY)
    expect(serialized).not.toContain(CFI)
    expect(serialized).toContain('prefs')
  })

  it('clears the run when another book opens, and when the reader closes', () => {
    const ran = () => {
      get().toggleSearch()
      get().setQuery('alice')
      get().setSearchState(searchingWithHits())
      get().setSearchState({ activeCfi: 'cfi-1' })
    }

    get().openBook(makeBook('b1'))
    ran()
    get().openBook(makeBook('b2'))
    expect([get().searchOpen, get().query, countHits(get().results), get().activeCfi]).toEqual([
      false,
      '',
      0,
      null
    ])

    ran()
    get().close()
    expect([get().searchOpen, get().query, countHits(get().results)]).toEqual([false, '', 0])
  })

  /**
   * Escape's first step: the results go and the query goes with them, which is
   * what makes the second Escape's "open and empty" true (AC1.6) — and the panel
   * is untouched, because the reader has not asked for it to close yet.
   */
  it('clears the results and the query, and keeps the panel standing', () => {
    get().toggleSearch()
    get().setQuery('alice')
    get().setSearchState(searchingWithHits())
    get().setSearchState({ activeCfi: 'cfi-1' })

    get().clearSearch()

    expect(get().searchOpen).toBe(true)
    expect([get().query, get().searching, countHits(get().results), get().activeCfi]).toEqual([
      '',
      false,
      0,
      null
    ])
  })

  it('does not notify for a patch that changes nothing', () => {
    get().setSearchState({ searching: false })
    const listener = vi.fn()
    const unsubscribe = useReaderStore.subscribe(listener)
    get().setSearchState({ searching: false })
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  /**
   * A defect the live probe exposed rather than a criterion the spec wrote: the
   * engine keys its effect on `(bookId, format)`, so a second `openBook` for the
   * book that is already open runs nothing that could report ready — and the
   * reader sat under "Opening…" with a blank percentage, for good.
   */
  it('does not strand the reader in loading when the open book is opened again', () => {
    get().openBook(makeBook('b1'))
    get().setStatus('ready')
    get().openBook(makeBook('b1'))
    expect(get().status).toBe('ready')

    // A different book is a load, and says so
    get().openBook(makeBook('b2'))
    expect(get().status).toBe('loading')
  })
})

describe('a book is a new conversation', () => {
  const get = () => useReaderStore.getState()

  const asked = () => {
    get().setSection({ index: 2, text: 'Some section text.' })
    get().setSectionLabel('Chapter 2')
    get().setSelection('a quote')
    get().beginAsk('q1', 'Who is Alice?')
    get().aiChunk({ requestId: 'q1', delta: 'Alice ' })
    get().setVerdict('weak')
  }

  it('clears the transcript, the verdict and the pointer when another book opens', () => {
    get().openBook(makeBook('b1'))
    asked()

    get().openBook(makeBook('b2'))
    expect(get().askSession.turns).toEqual([])
    expect(get().askVerdict).toBeNull()
    expect(get().askRung).toBe('pointer')
    expect(get().askOverride).toBe(false)
    expect(get().section).toBeNull()
    expect(get().sectionLabel).toBeNull()
    expect(get().selection).toBeNull()
    expect(get().askSession.requestId).toBeNull()
  })

  it('clears them when the reader closes', () => {
    asked()
    get().close()
    expect(get().askSession.turns).toEqual([])
    expect(get().askVerdict).toBeNull()
    expect(get().section).toBeNull()
    expect(get().selection).toBeNull()
  })

  it('keeps the transcript when only the panel is closed', () => {
    get().beginAsk('q1', 'Who is Alice?')
    get().aiDone({ requestId: 'q1', reason: 'stop' })
    get().toggleAsk()
    get().toggleAsk()
    expect(get().askOpen).toBe(false)
    // The empty answer is dropped rather than left as a blank bubble, and the
    // question survives the panel — it belongs to the book, not to the panel
    expect(get().askSession.turns).toEqual([{ role: 'user', text: 'Who is Alice?' }])
  })
})
