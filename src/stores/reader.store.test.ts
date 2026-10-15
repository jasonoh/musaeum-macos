import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PREFS,
  PREF_RANGES,
  persistedReaderState,
  sanitizePrefs,
  THEME_OPTIONS,
  useReaderStore,
  type SearchPatch
} from './reader.store'
import type { BookFormat, ReflowResult } from '@shared/book.types'
import type {
  Annotation,
  AnnotationsRead,
  CreateAnnotationResult,
  NewAnnotationInput
} from '@shared/annotation.types'
import type { AnnotationLocator } from '@/lib/annotations'
import { countHits } from '@/lib/reader-search'
import { useLibraryStore } from '@/stores/library.store'
import { useUIStore } from '@/stores/ui.store'
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
    const prefs = {
      typeface: 'sans',
      theme: 'paper',
      fontSize: 22,
      lineHeight: 1.8,
      margin: 96,
      voice: 'bm_george',
      speed: 1.2
    }
    expect(sanitizePrefs(prefs)).toEqual(prefs)
  })

  it('rejects values outside the union', () => {
    expect(sanitizePrefs({ typeface: 'comic' }).typeface).toBe(DEFAULT_PREFS.typeface)
    expect(sanitizePrefs({ theme: 'sepia' }).theme).toBe('auto')
    expect(sanitizePrefs({ typeface: 7 }).typeface).toBe(DEFAULT_PREFS.typeface)
  })

  /**
   * AC5.3, both halves. The theme union gained a third member (`auto`, the
   * default) and the two that existed keep their meaning — which is the point: a
   * `musaeum.reader` entry written before this slice must not change what it
   * renders.
   */
  it('keeps an old stored theme meaning what it meant, and defaults a missing one', () => {
    expect(sanitizePrefs({ theme: 'ink' }).theme).toBe('ink')
    expect(sanitizePrefs({ theme: 'paper' }).theme).toBe('paper')
    expect(sanitizePrefs({ theme: 'auto' }).theme).toBe('auto')
    expect(DEFAULT_PREFS.theme).toBe('auto')
    // The shape a pre-slice-5 entry has: no `theme` field at all.
    expect(sanitizePrefs({ typeface: 'sans', fontSize: 22 }).theme).toBe('auto')
    expect(sanitizePrefs(undefined).theme).toBe('auto')
  })

  it('agrees with THEME_OPTIONS — the list the popover renders is the list storage accepts', () => {
    // The drift AC5.3's mutation creates: the option list widened without the
    // validator (or the reverse) lets a control produce a value storage rejects.
    // `reader.store.ts` keeps one list for both for exactly this reason.
    expect(THEME_OPTIONS.map((o) => o.value)).toEqual(['auto', 'ink', 'paper'])
    for (const option of THEME_OPTIONS) {
      expect(sanitizePrefs({ theme: option.value }).theme, option.value).toBe(option.value)
    }
  })

  it('keeps a stored theme through the persist round trip (AC5.3)', () => {
    // AC5.3's second clause, against the two functions the persist middleware is
    // actually given rather than a copy of the shape: `persistedReaderState` is
    // `partialize`, and `sanitizePrefs` is what `merge` runs on the stored entry.
    // A theme chosen before this slice therefore survives a restart unchanged.
    const store = useReaderStore.getState()
    const saved = { ...store.prefs, theme: 'ink' as const }
    expect(sanitizePrefs(persistedReaderState({ ...store, prefs: saved }).prefs).theme).toBe('ink')
    expect(sanitizePrefs(persistedReaderState(store).prefs).theme).toBe('auto')
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

  it('falls back to af_heart for an unknown voice and keeps a known one', () => {
    expect(sanitizePrefs({ voice: 'nope' }).voice).toBe('af_heart')
    expect(sanitizePrefs({ voice: 'bm_george' }).voice).toBe('bm_george')
  })

  it('clamps speed to 0.8–1.5 in tenths and defaults NaN to 1.0', () => {
    expect(sanitizePrefs({ speed: 9 }).speed).toBe(1.5)
    expect(sanitizePrefs({ speed: 0.1 }).speed).toBe(0.8)
    expect(sanitizePrefs({ speed: 1.26 }).speed).toBe(1.3)
    expect(sanitizePrefs({ speed: 'fast' }).speed).toBe(1.0)
    expect(sanitizePrefs({ speed: NaN }).speed).toBe(1.0)
  })

  it('persists voice and speed but not whether the listen bar is open', () => {
    const persisted = persistedReaderState(useReaderStore.getState())
    expect(JSON.stringify(persisted)).toContain('"voice"')
    expect(JSON.stringify(persisted)).toContain('"speed"')
    expect(persisted).not.toHaveProperty('listenOpen')
  })

  it('a prefs object stored before this slice still loads, with the new defaults', () => {
    const old = { typeface: 'sans', fontSize: 20, lineHeight: 1.5, margin: 40, theme: 'auto' }
    expect(sanitizePrefs(old)).toMatchObject({ voice: 'af_heart', speed: 1.0, typeface: 'sans' })
  })

  it('closing a book closes the listen bar', () => {
    const get = () => useReaderStore.getState()
    get().openBook(makeBook('b1'))
    get().toggleListen()
    expect(get().listenOpen).toBe(true)
    get().close()
    expect(get().listenOpen).toBe(false)
    get().toggleListen()
    get().closeListen()
    expect(get().listenOpen).toBe(false)
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
    expect(get().askSession.turns[1]!.streaming).toBeUndefined()
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

describe('the passage offset', () => {
  const get = () => useReaderStore.getState()

  beforeEach(() => {
    get().close()
  })

  /**
   * The window is anchored on this, so it is the one field of the pointer that
   * must never survive the section it was measured against: 7,805 means "the
   * reader's page" in the Introduction and something else entirely in Chapter 4.
   */
  it('keeps the offset while the section stands, and drops it when one replaces it', () => {
    get().setSection({ index: 6, text: 'Introduction' })
    get().setSectionOffset(7805)
    expect(get().sectionOffset).toBe(7805)

    // A re-report of the same section (the `load` listener fires per render) is
    // not a new section.
    get().setSection({ index: 6, text: 'Introduction' })
    expect(get().sectionOffset).toBe(7805)

    get().setSection({ index: 9, text: 'Chapter 1' })
    expect(get().sectionOffset).toBeNull()
  })

  it('goes with the book, and comes back null for the next one', () => {
    get().openBook(makeBook('b1'))
    get().setSection({ index: 6, text: 'Introduction' })
    get().setSectionOffset(7805)

    get().openBook(makeBook('b2'))
    expect(get().sectionOffset).toBeNull()
  })

  it('does not notify for the same offset re-reported', () => {
    const listener = vi.fn()
    get().setSectionOffset(120)
    const unsubscribe = useReaderStore.subscribe(listener)
    get().setSectionOffset(120)
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

  /**
   * The other half of that rule, and the message is the half that was missing: a
   * session that is *in* an error keeps the reason it is showing, because nothing
   * re-ran. Nulling it left the error state's own surface drawing "Open
   * externally" with no reason above it (measured 2026-10-09 by the live pass's
   * probe, which had reopened a failed book to re-drive it).
   */
  it('keeps the reason a non-reload open is still showing', () => {
    get().openBook(makeBook('b1'))
    get().setStatus('error', 'This book’s file could not be read.')
    get().openBook(makeBook('b1'))
    expect(get().status).toBe('error')
    expect(get().error).toBe('This book’s file could not be read.')

    // …and a real reload still clears it, because a new load has no reason yet
    get().openBook(makeBook('b2'))
    expect(get().error).toBeNull()
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

/**
 * The reflow path (D1, D6, D7). `window.Musaeum` is stubbed because there is no
 * preload under vitest — the pattern `src/lib/add-books.test.ts` uses.
 *
 * The books are seeded into the *library* store as well as handed to
 * `openBook`, because that is where `beginReflow` finds the book it hands to the
 * system opener: in the app the book a card opens is always a library row, and
 * the store looks it up by id rather than trusting a caller's copy.
 */
describe('openBook — the reflow path', () => {
  let opened: [string, string][]
  let asked: string[]
  let askedAnnotations: string[]
  let answer: ReflowResult | Error
  const reflow = (id: string) => {
    asked.push(id)
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
  }

  const pdfBook = (id = 'b1', formats: BookFormat[] = ['pdf']) => ({ ...makeBook(id), formats })

  const open = (book: ReturnType<typeof pdfBook>): void => {
    useLibraryStore.setState({ books: [book] })
    useReaderStore.getState().openBook(book)
  }

  beforeEach(() => {
    opened = []
    asked = []
    askedAnnotations = []
    answer = {
      status: 'cached',
      reason: '',
      verdict: 'ok',
      epub: 'derived/reflow.epub',
      stampFile: 'derived/reflow.json',
      pages: 3,
      bytes: 10,
      seconds: 0.1
    }
    vi.stubGlobal('window', {
      Musaeum: {
        reader: { reflow: (id: string) => reflow(id) },
        annotations: {
          list: (id: string) => {
            askedAnnotations.push(id)
            return Promise.resolve({ state: 'ok', annotations: [] })
          }
        },
        files: {
          openBookFile: (id: string, format: string) => {
            opened.push([id, format])
            return Promise.resolve()
          }
        }
      }
    })
    vi.spyOn(useUIStore.getState(), 'notify')
    useReaderStore.getState().close()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('opens a PDF-only book as a reflow and asks for one', () => {
    open(pdfBook())
    expect(useReaderStore.getState().format).toBe('reflow')
    expect(useReaderStore.getState().reflow).toMatchObject({ bookId: 'b1', phase: 'start' })
    expect(asked).toEqual(['b1'])
  })

  it('leaves a book the engine can read alone', () => {
    open({ ...makeBook('b2'), formats: ['mobi', 'pdf'] })
    expect(useReaderStore.getState().format).toBe('mobi')
    expect(useReaderStore.getState().reflow).toBeNull()
    expect(asked).toEqual([])
  })

  it('leaves the reader on the artifact a cached pass found', async () => {
    open(pdfBook('b3'))
    await vi.waitFor(() => expect(useReaderStore.getState().reflow).toBeNull())
    expect(useReaderStore.getState().bookId).toBe('b3')
    expect(opened).toEqual([])
  })

  it('hands the book to the system opener, with the reason, when the pass refuses', async () => {
    answer = {
      status: 'fallback',
      reason: '3 of 5 text pages could not be laid out',
      verdict: 'unstable_layout',
      epub: '',
      stampFile: '',
      pages: 5,
      bytes: 0,
      seconds: 1.2
    }
    open(pdfBook('b4'))
    await vi.waitFor(() => expect(useReaderStore.getState().bookId).toBeNull())
    expect(opened).toEqual([['b4', 'pdf']])
    expect(useUIStore.getState().notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'info', detail: '3 of 5 text pages could not be laid out' })
    )
  })

  it('hands the book over when the pre-flight fails, too', async () => {
    answer = new Error('Python sidecar is unavailable')
    open(pdfBook('b5'))
    await vi.waitFor(() => expect(useReaderStore.getState().bookId).toBeNull())
    expect(opened).toEqual([['b5', 'pdf']])
    expect(useUIStore.getState().notify).toHaveBeenCalledWith(
      expect.objectContaining({ detail: 'Python sidecar is unavailable' })
    )
  })

  /**
   * The stale-answer guard — and the case has to answer with a **fallback** to
   * decide it. The default `cached` answer's only effect is `set({ reflow: null })`,
   * which after a `close()` is a no-op, so the mutation campaign found this case
   * **green with the guard removed** (measured 2026-10-09): it was passing for the
   * wrong reason. With a refusal for a book the reader has left, the guard is the
   * only thing standing between a departed session and Preview.
   */
  it('drops a refusal for a book the reader has left', async () => {
    answer = {
      status: 'fallback',
      reason: '3 of 5 text pages could not be laid out',
      verdict: 'unstable_layout',
      epub: '',
      stampFile: '',
      pages: 5,
      bytes: 0,
      seconds: 1.2
    }
    open(pdfBook('b6'))
    useReaderStore.getState().close()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(opened).toEqual([])
    expect(useUIStore.getState().notify).not.toHaveBeenCalled()
  })

  it('keeps a frame for another book out of this session', () => {
    open(pdfBook('b7'))
    const before = useReaderStore.getState().reflow
    useReaderStore
      .getState()
      .setReflow({ bookId: 'other', phase: 'layout', completed: 1, total: 2 })
    expect(useReaderStore.getState().reflow).toBe(before)
    useReaderStore.getState().setReflow({ bookId: 'b7', phase: 'layout', completed: 1, total: 2 })
    expect(useReaderStore.getState().reflow).toMatchObject({ phase: 'layout', completed: 1 })
  })

  it('holds identity for a repeated frame', () => {
    open(pdfBook('b8'))
    const frame = { bookId: 'b8', phase: 'reading', completed: 4, total: 9 }
    useReaderStore.getState().setReflow(frame)
    const held = useReaderStore.getState().reflow
    useReaderStore.getState().setReflow({ ...frame })
    expect(useReaderStore.getState().reflow).toBe(held)
  })

  /**
   * The ordering spec D6 forces on a reflow book, and the one that would have
   * arrived disguised as AC24's own state: the artifact's identity **is** the
   * stamp the pass writes, so a read taken before it exists finds no identity at
   * all and calls every derived annotation stale — listed and not drawn, for a
   * reason that is not the reason AC24 measures.
   */
  it('does not read a reflow book’s highlights until the artifact is in hand', async () => {
    open(pdfBook('b9'))
    // The pass is still running: nothing has been asked of the annotations yet.
    expect(askedAnnotations).toEqual([])
    await vi.waitFor(() => expect(useReaderStore.getState().reflow).toBeNull(), {
      timeout: 5_000,
      interval: 10
    })
    expect(askedAnnotations).toEqual(['b9'])
  })
})

/** A stored highlight as the bridge hands it over — the fixture the notes cases share. */
const ANNOTATION: Annotation = {
  id: 'a1',
  type: 'highlight',
  cfi: 'epubcfi(/6/4!/4/2)',
  quote: 'the protomolecule is loose',
  prefix: '',
  suffix: '',
  percent: 0.4,
  sectionLabel: 'Chapter 7',
  color: 'gold',
  note: null,
  createdAt: '2026-10-13T11:00:00.000Z',
  updatedAt: '2026-10-13T11:00:00.000Z',
  stale: false
}

/** The record a create mints — a second row, so "adopted the answer" is not "kept what it had". */
const CREATED: Annotation = { ...ANNOTATION, id: 'a2', cfi: 'epubcfi(/6/4!/4/4)', percent: 0.6 }

/**
 * A row this client has **never held** — another Mac's, arriving in a write's
 * answer. The fixture the create case needs and the one it did not have: with a
 * list of "what this process had, plus the new row", a local append and the
 * adopted answer are the *same array*, so the case could not tell them apart
 * (measured by the campaign: the row survived as an equivalent mutant).
 */
const OTHER: Annotation = {
  ...ANNOTATION,
  id: 'a3',
  cfi: 'epubcfi(/6/4!/4/6)',
  quote: 'a sentence the other Mac highlighted',
  percent: 0.8
}

/** What the chip hands the store: exactly the members a caller may say (AC13). */
const LOCATOR: AnnotationLocator = {
  cfi: 'epubcfi(/6/4!/4/2)',
  quote: 'the protomolecule is loose',
  prefix: '',
  suffix: '',
  percent: 0.4,
  sectionLabel: 'Chapter 7'
}

/**
 * The Notes panel's claim on the one side slot (AC17).
 *
 * Beside the three-occupant cases above rather than in place of them: rewriting
 * those into a four-tuple would make the new rule's own case indistinguishable
 * from the old one's, and the mutation that matters here — one toggle forgetting
 * to close the fourth — is only visible against a four-tuple that also exists.
 */
describe('the reader’s one side slot, fourth occupant (AC17)', () => {
  const get = () => useReaderStore.getState()
  const occupants = () => [get().tocOpen, get().searchOpen, get().askOpen, get().notesOpen]

  beforeEach(() => get().close())

  it('opens the notes panel and closes the other three', () => {
    get().toggleToc()
    get().toggleNotes()
    expect(occupants()).toEqual([false, false, false, true])
  })

  it('closes the notes panel from any of the other three toggles', () => {
    const openers: [string, () => void, boolean[]][] = [
      ['toggleToc', () => get().toggleToc(), [true, false, false, false]],
      ['toggleSearch', () => get().toggleSearch(), [false, true, false, false]],
      ['toggleAsk', () => get().toggleAsk(), [false, false, true, false]]
    ]
    for (const [name, open, expected] of openers) {
      get().toggleNotes()
      expect(occupants(), name).toEqual([false, false, false, true])
      open()
      expect(occupants(), name).toEqual(expected)
    }
  })

  it('closes on its own toggle, and keeps the list — it belongs to the book', () => {
    useReaderStore.setState({ annotations: [ANNOTATION], annotationsState: 'ok' })
    get().toggleNotes()
    get().toggleNotes()
    expect(get().notesOpen).toBe(false)
    expect(get().annotations).toEqual([ANNOTATION])
  })

  it('opens on the row a drawn highlight names, and marks it (R18)', () => {
    useReaderStore.setState({ annotations: [ANNOTATION], annotationsState: 'ok' })
    get().toggleSearch()
    get().openNotes(ANNOTATION.cfi)
    expect([get().notesOpen, get().searchOpen]).toEqual([true, false])
    expect(get().activeAnnotationId).toBe(ANNOTATION.id)
  })
})

/**
 * The four writes, against a stubbed bridge (R19, R20).
 *
 * `window.Musaeum` is stubbed because there is no preload under vitest — the
 * pattern the reflow cases above use. What each case decides is the part a reader
 * of `ReaderNotes.tsx` cannot check by looking: that the list the store holds is
 * the one the **answer** carried rather than a local patch (slice 1's R1), and
 * that the read's state is kept distinct from an empty list.
 */
describe('the notes panel’s writes (R19, R20)', () => {
  const get = () => useReaderStore.getState()

  /**
   * A poll generous enough that a *loaded* machine cannot redden it. These cases
   * wait on a bridge promise, and the default `vi.waitFor` budget is one second —
   * which one full-suite run exceeded while a mutation campaign was running
   * beside it. The wait is not the claim; the settled state is.
   */
  const settled = { timeout: 5_000, interval: 10 } as const

  let calls: string[]
  let answer: {
    list: AnnotationsRead | Error
    create: CreateAnnotationResult | Error
    mut: Annotation[] | Error
  }

  const reply = <T>(value: T | Error): Promise<T> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value)

  beforeEach(() => {
    calls = []
    answer = {
      list: { state: 'ok', annotations: [ANNOTATION] },
      create: { annotations: [CREATED, OTHER], created: CREATED },
      mut: [CREATED]
    }
    vi.stubGlobal('window', {
      Musaeum: {
        annotations: {
          list: (bookId: string, format: string) => {
            calls.push(`list ${bookId} ${format}`)
            return reply(answer.list)
          },
          create: (input: NewAnnotationInput) => {
            calls.push(`create ${input.cfi}`)
            return reply(answer.create)
          },
          update: (_bookId: string, id: string, note: string | null) => {
            calls.push(`update ${id} ${String(note)}`)
            return reply(answer.mut)
          },
          remove: (_bookId: string, id: string) => {
            calls.push(`remove ${id}`)
            return reply(answer.mut)
          }
        }
      }
    })
    vi.spyOn(useUIStore.getState(), 'notify')
    get().close()
    get().openBook(makeBook('b1'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('lands the read’s list and its state — and the read is the book’s, not the panel’s (R19)', async () => {
    // Nothing in this file opens the Notes panel: the list is in the store because
    // the **book** opened. Measured in the running app (2026-10-13): a reopened
    // book drew no highlight at all, because the panel was the only reader of the
    // file and nobody had opened it.
    await vi.waitFor(() => expect(get().annotationsState).toBe('ok'), settled)
    expect(get().annotations).toEqual([ANNOTATION])
    expect(get().annotationsLoading).toBe(false)
    expect(calls).toEqual(['list b1 epub'])
  })

  it('keeps an unreadable file a different sentence from a book with no notes (R20)', async () => {
    answer.list = { state: 'unreadable', annotations: [] }
    await get().loadAnnotations()
    expect(get().annotationsState).toBe('unreadable')
    expect(get().annotations).toEqual([])

    answer.list = { state: 'missing', annotations: [] }
    await get().loadAnnotations()
    expect(get().annotationsState).toBe('missing')
  })

  it('adopts the list a create answered with, and activates the minted row (R19)', async () => {
    calls.length = 0 // the open itself reads the list — see the case above
    await get().addHighlight(LOCATOR)
    expect(calls).toEqual(['create epubcfi(/6/4!/4/2)'])
    // **The answer, not this process's list plus the new row**: the answer carries
    // a row this client has never held (another Mac's), so a local append — which
    // is what R1 exists to forbid — would produce a different array and redden.
    expect(get().annotations).toEqual([CREATED, OTHER])
    expect(get().annotationsState).toBe('ok')
    expect(get().activeAnnotationId).toBe(CREATED.id)
  })

  it('adopts the list a note answered with, and never patches it locally', async () => {
    calls.length = 0 // the open itself reads the list
    useReaderStore.setState({ annotations: [ANNOTATION, CREATED], annotationsState: 'ok' })
    answer.mut = [{ ...ANNOTATION, note: 'the setup for book two' }]
    await get().saveAnnotationNote(ANNOTATION.id, 'the setup for book two')

    expect(calls).toEqual([`update ${ANNOTATION.id} the setup for book two`])
    // The answer is the file's whole list — one row, not two — and that is what
    // the panel shows, because the write re-read the file (slice 1's R1).
    expect(get().annotations).toEqual([{ ...ANNOTATION, note: 'the setup for book two' }])
  })

  it('adopts the list a delete answered with, and lets the active row go', async () => {
    calls.length = 0 // the open itself reads the list
    useReaderStore.setState({ annotations: [ANNOTATION, CREATED], annotationsState: 'ok' })
    get().openNotes(CREATED.cfi)
    expect(get().activeAnnotationId).toBe(CREATED.id)

    answer.mut = [ANNOTATION]
    await get().deleteHighlight(CREATED.id)

    expect(calls).toEqual([`remove ${CREATED.id}`])
    expect(get().annotations).toEqual([ANNOTATION])
    expect(get().activeAnnotationId).toBeNull()
  })

  it('reports a refused write and leaves the list alone', async () => {
    // "Leaves it alone" is about the list the read landed, not about an empty one:
    // the open read this book's highlights before anything was asked of a write.
    await vi.waitFor(() => expect(get().annotations).toEqual([ANNOTATION]), settled)
    answer.create = new Error('The notes for this book could not be read')
    await get().addHighlight(LOCATOR)
    expect(get().annotations).toEqual([ANNOTATION])
    expect(useUIStore.getState().notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'error',
        message: 'The notes for this book could not be read'
      })
    )
  })

  it('drops an answer for a book the reader has left', async () => {
    const pending = get().loadAnnotations()
    get().close()
    await pending
    expect(get().annotations).toEqual([])
    expect(get().annotationsState).toBe('missing')
    expect(get().annotationsLoading).toBe(false)
  })

  /**
   * AC18, over the serialized whole rather than the field we suspect — the same
   * instrument the search case above uses, for the same reason: the absence that
   * matters is that no part of a highlight reaches storage.
   */
  it('persists nothing of an annotation', async () => {
    const QUOTE = 'sentinel-quote-protomolecule'
    const CFI = 'sentinel-cfi(/6/4!/4/2)'
    answer.list = { state: 'ok', annotations: [{ ...ANNOTATION, quote: QUOTE, cfi: CFI }] }
    await get().loadAnnotations()

    const serialized = JSON.stringify(persistedReaderState(get()))
    expect(serialized).not.toContain(QUOTE)
    expect(serialized).not.toContain(CFI)
    expect(serialized).toContain('prefs')
  })
})
