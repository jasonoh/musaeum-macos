import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FoliateView } from '@vendor/foliate-js/view.js'
import type { SpeechUnit } from './speech-queue'
import { SPEECH_DRAW_KIND, SpeechController, type SpeechView } from './speech-controller'

/**
 * The controller against a fake foliate: no DOM here (vitest runs in node), so the
 * fake carries the two engine facts the controller exists to respect.
 *
 * 1. **The range map is rebuilt on every cursor move** (`vendor/foliate-js/tts.js:213-216`):
 *    `start`/`next`/`from` reassign `ranges`, and `setMark(name)` looks the name up in
 *    whichever block the cursor is on *now* — with names that restart at `"0"` in every
 *    block, exactly as the engine's segmenter numbers them. So a `setMark` for block 1's
 *    second sentence after `next()` highlights block 2's second sentence.
 * 2. **`load` fires before the renderer's contents move** (`paginator.js:971-998`): a
 *    controller that rebinds inside the `load` listener rebinds to the old section.
 */

const START_TO_START = 0
const START_TO_END = 1
const END_TO_END = 2

interface FakeDoc {
  name: string
}

class FakeRange {
  constructor(
    readonly doc: FakeDoc,
    public start: number,
    public end: number
  ) {}
  get startContainer(): { ownerDocument: FakeDoc } {
    return { ownerDocument: this.doc }
  }
  cloneRange(): FakeRange {
    return new FakeRange(this.doc, this.start, this.end)
  }
  collapse(toStart = false): void {
    if (toStart) this.end = this.start
    else this.start = this.end
  }
  /** The DOM's semantics: this point (per `how`) against the source's, -1/0/1. */
  compareBoundaryPoints(how: number, other: FakeRange): number {
    if (other.doc !== this.doc) throw new Error('WrongDocumentError')
    const [a, b] =
      how === START_TO_START
        ? [this.start, other.start]
        : how === START_TO_END
          ? [this.end, other.start]
          : how === END_TO_END
            ? [this.end, other.end]
            : [this.start, other.end]
    return Math.sign(a - b)
  }
}

interface FakeSentence {
  text: string
  range: FakeRange
}
interface FakeBlock {
  sentences: FakeSentence[]
  range: FakeRange
}
interface FakeSection {
  doc: FakeDoc
  blocks: FakeBlock[]
  linear?: 'no'
}

/** The page the fake paginator shows for a position: fixed 30-position windows. */
const PAGE = 30
function pageAt(doc: FakeDoc, pos: number): FakeRange {
  const start = Math.floor(pos / PAGE) * PAGE
  return new FakeRange(doc, start, start + PAGE - 1)
}

/** Blocks of sentences; `[]` is a block with nothing to say (an image, whitespace). */
function section(name: string, blocks: string[][], linear?: 'no'): FakeSection {
  const doc = { name }
  let pos = 0
  return {
    doc,
    linear,
    blocks: blocks.map((texts) => {
      const from = pos
      const sentences = texts.map((text) => {
        const range = new FakeRange(doc, pos, pos + 9)
        pos += 10
        return { text, range }
      })
      if (texts.length === 0) pos += 10
      return { sentences, range: new FakeRange(doc, from, pos - 1) }
    })
  }
}

class FakeTTS {
  cursor = -1
  ranges = new Map<string, FakeRange>()
  readonly marks: string[] = []
  constructor(
    readonly doc: FakeDoc,
    readonly sec: FakeSection,
    public highlight: (range: FakeRange) => void
  ) {}
  private land(i: number, from = 0): string {
    this.cursor = i
    const block = this.sec.blocks[i]!
    this.ranges = new Map(block.sentences.map((s, k) => [String(k), s.range]))
    if (block.sentences.length === 0) return '<speak><mark name="0"/>  </speak>'
    const body = block.sentences
      .slice(from)
      .map((s, k) => `<mark name="${k + from}"/>${s.text} `)
      .join('')
    return `<speak>${body}</speak>`
  }
  start(): string | undefined {
    return this.sec.blocks.length ? this.land(0) : undefined
  }
  next(): string | undefined {
    // like ListIterator: past the end the cursor (and the map) stay where they were
    if (this.cursor + 1 >= this.sec.blocks.length) return undefined
    return this.land(this.cursor + 1)
  }
  from(range: FakeRange): string | undefined {
    const i = this.sec.blocks.findIndex((b) => range.start <= b.range.end)
    // the vendor destructures `#list.find(...)` with no `?? []` (`tts.js:261`): past the
    // section's last text block — or in a section with none, like an image-only cover — it throws
    if (i < 0) throw new TypeError('undefined is not iterable')
    const k = this.sec.blocks[i]!.sentences.findIndex((s) => range.start <= s.range.start)
    return this.land(i, k < 0 ? 0 : k)
  }
  setMark(name: string): void {
    this.marks.push(name)
    const range = this.ranges.get(name)
    if (range) this.highlight(range.cloneRange())
  }
}

interface Ann {
  value: string
  kind: string
  color: string
}

class FakeView {
  index = 0
  tts: FakeTTS | null = null
  lastLocation: { range: FakeRange } | null = null
  initCalls = 0
  readonly added: Ann[] = []
  readonly deleted: Ann[] = []
  addThrows = false
  hang = false
  /** How many `nextSection()` calls return without moving, as the paginator does while locked. */
  locked = 0
  /** Fed every relocate synchronously, as the engine emits it — the test's stand-in for Task 7. */
  relocated: (range: FakeRange) => void = () => {}
  private readonly loadListeners = new Set<(e: Event) => void>()
  readonly book: { sections: { linear?: string }[] }
  readonly renderer = {
    getContents: () => [{ index: this.index, doc: this.sections[this.index]!.doc }],
    scrollToAnchor: vi.fn(async (range: FakeRange, _select?: boolean) => {
      this.relocate(pageAt(range.doc, range.start))
    }),
    nextSection: vi.fn(async (): Promise<void> => {
      if (this.hang) return new Promise<void>(() => {})
      if (this.locked > 0) {
        this.locked -= 1
        return
      }
      let next = this.index + 1
      while (next < this.sections.length && this.sections[next]!.linear === 'no') next += 1
      if (next >= this.sections.length) return
      // the paginator's order: `load` first, the contents after, then `relocate` before it resolves
      for (const l of this.loadListeners) l(new Event('load'))
      await Promise.resolve()
      this.index = next
      this.relocate(pageAt(this.sections[next]!.doc, 0))
    })
  }
  constructor(readonly sections: FakeSection[]) {
    this.book = { sections: sections.map((s) => (s.linear ? { linear: s.linear } : {})) }
  }
  relocate(page: FakeRange): void {
    this.lastLocation = { range: page }
    this.relocated(page.cloneRange())
  }
  async initTTS(_granularity: string, highlight: (range: FakeRange) => void): Promise<void> {
    this.initCalls += 1
    const sec = this.sections[this.renderer.getContents()[0]!.index]!
    if (this.tts && this.tts.doc === sec.doc) return
    this.tts = new FakeTTS(sec.doc, sec, highlight)
  }
  getCFI(index: number, range: FakeRange): string {
    return `${index}@${range.start}`
  }
  async addAnnotation(a: Ann): Promise<{ index: number; label: string }> {
    if (this.addThrows) throw new Error('could not resolve')
    this.added.push(a)
    return { index: this.index, label: '' }
  }
  async deleteAnnotation(a: Ann): Promise<{ index: number; label: string }> {
    this.deleted.push(a)
    return { index: this.index, label: '' }
  }
  addEventListener(type: string, fn: (e: Event) => void): void {
    if (type === 'load') this.loadListeners.add(fn)
  }
  removeEventListener(type: string, fn: (e: Event) => void): void {
    if (type === 'load') this.loadListeners.delete(fn)
  }
  listenerCount(): number {
    return this.loadListeners.size
  }
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

function make(sections: FakeSection[], opts: { color?: () => string; saved?: Set<string> } = {}) {
  const view = new FakeView(sections)
  const onError = vi.fn()
  const saved = opts.saved ?? new Set<string>()
  const controller = new SpeechController({
    view: view as unknown as SpeechView,
    speechColor: opts.color ?? (() => '#d4a24e'),
    isSaved: (cfi) => saved.has(cfi),
    onError
  })
  return { view, controller, onError }
}

/** A take that records whether it has settled. */
function track(p: Promise<SpeechUnit | null>): {
  settled: boolean
  value: Promise<SpeechUnit | null>
} {
  const t = { settled: false, value: p }
  void p.then(
    () => (t.settled = true),
    () => (t.settled = true)
  )
  return t
}

/** The engine's own view is a `SpeechView` — a typecheck, so the slice cannot drift from the d.ts. */
const realViewFits = (view: FoliateView): SpeechView => view

afterEach(() => {
  vi.useRealTimers()
})

describe('SpeechController', () => {
  it("takes the engine's own view", () => {
    expect(typeof realViewFits).toBe('function')
  })

  it('(a) hands out a block in order and holds the next block until its last unit has started', async () => {
    const { controller } = make([
      section('s0', [
        ['A one.', 'A two.'],
        ['B one.', 'B two.']
      ])
    ])
    expect(await controller.begin()).toBe(true)
    const u0 = await controller.take()
    const u1 = await controller.take()
    expect([u0?.text, u1?.text]).toEqual(['A one.', 'A two.'])
    expect(u1?.blockEnd).toBe(true)

    const third = track(controller.take())
    await flush()
    expect(third.settled).toBe(false)
    controller.started(u0!)
    await flush()
    expect(third.settled).toBe(false)
    controller.started(u1!)
    expect((await third.value)?.text).toBe('B one.')
  })

  it("(b) highlights block 1's last sentence even though block 2 is next: the cursor never moves early", async () => {
    const s = section('s0', [
      ['A one.', 'A two.'],
      ['B one.', 'B two.']
    ])
    const { view, controller } = make([s])
    await controller.begin()
    const u0 = (await controller.take())!
    const u1 = (await controller.take())!
    // the player asks for the next block's first unit while block 1 is still to sound
    const third = track(controller.take())
    await flush()
    controller.started(u0)
    await flush()
    controller.started(u1)
    await flush()
    const a = s.blocks[0]!.sentences
    // a controller that called next() on the third take would have drawn block 2's "B two."
    expect(view.added.map((x) => x.value)).toEqual([
      `0@${a[0]!.range.start}`,
      `0@${a[1]!.range.start}`
    ])
    // the first sentence brought its page up; the second was already on it, so no scroll
    expect(view.renderer.scrollToAnchor.mock.calls.map((c) => c[0].start)).toEqual([
      a[0]!.range.start
    ])
    expect((await third.value)?.text).toBe('B one.')
  })

  it('(c) skips a block that has nothing to say', async () => {
    const { controller } = make([section('s0', [['A one.'], [], ['C one.']])])
    await controller.begin()
    const u0 = (await controller.take())!
    controller.started(u0)
    expect((await controller.take())?.text).toBe('C one.')
  })

  it('(c) begins past leading empty blocks', async () => {
    const { controller } = make([section('s0', [[], [], ['C one.']])])
    expect(await controller.begin()).toBe(true)
    expect((await controller.take())?.text).toBe('C one.')
  })

  it('(d) continues into the next section: nextSection, then initTTS again on the new document, then start', async () => {
    const s0 = section('s0', [['A one.']])
    const s1 = section('s1', [['N one.', 'N two.']])
    const { view, controller } = make([s0, s1])
    await controller.begin()
    expect(view.initCalls).toBe(1)
    const u0 = (await controller.take())!
    controller.started(u0)
    controller.ended(u0)
    const n0 = (await controller.take())!
    expect(n0.text).toBe('N one.')
    expect(view.renderer.nextSection).toHaveBeenCalledTimes(1)
    expect(view.initCalls).toBe(2)
    // bound to the section the contents moved to, not the one `load` fired over
    expect(view.tts?.doc).toBe(s1.doc)
    expect(view.listenerCount()).toBe(0)
    controller.started(n0)
    await flush()
    expect(view.added.at(-1)?.value).toBe(`1@${s1.blocks[0]!.sentences[0]!.range.start}`)
  })

  it('(e) answers null at the end of the book', async () => {
    const { view, controller, onError } = make([section('s0', [['A one.']])])
    await controller.begin()
    const u0 = (await controller.take())!
    controller.started(u0)
    expect(await controller.take()).toBeNull()
    // decided from the book's structure: there is no later section to ask for
    expect(view.renderer.nextSection).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('begin resolves false when the whole book has nothing to say', async () => {
    const { controller } = make([section('s0', [[]]), section('s1', [[]])])
    expect(await controller.begin()).toBe(false)
  })

  it('(f) rewind replays a unit of the current block', async () => {
    const { controller } = make([section('s0', [['A one.', 'A two.', 'A three.']])])
    await controller.begin()
    const u0 = (await controller.take())!
    await controller.take()
    controller.rewind(u0)
    expect(await controller.take()).toBe(u0)
    expect(() => controller.rewind({ mark: '9', text: 'x', blockEnd: false })).toThrow()
  })

  it('(f) a rewind to the last unit closes the gate again until it re-starts', async () => {
    const { controller } = make([section('s0', [['A one.', 'A two.'], ['B one.']])])
    await controller.begin()
    const u0 = (await controller.take())!
    const u1 = (await controller.take())!
    controller.started(u0)
    controller.started(u1)
    controller.rewind(u1)
    expect(await controller.take()).toBe(u1)
    const next = track(controller.take())
    await flush()
    expect(next.settled).toBe(false)
    controller.started(u1)
    expect((await next.value)?.text).toBe('B one.')
  })

  it('(g) a relocate onto the page being read is not a move', async () => {
    const s = section('s0', [['A one.', 'A two.'], ['B one.']])
    const { controller } = make([s])
    await controller.begin()
    const u0 = (await controller.take())!
    controller.started(u0)
    const page = new FakeRange(s.doc, 0, 25)
    expect(await controller.onRelocate(page as unknown as Range)).toBeNull()
    expect(await controller.onRelocate(null)).toBeNull()
  })

  it('(g) nothing sounding: a relocate is not a move', async () => {
    const s = section('s0', [['A one.'], ['B one.']])
    const { controller } = make([s])
    await controller.begin()
    expect(await controller.onRelocate(new FakeRange(s.doc, 10, 19) as unknown as Range)).toBeNull()
  })

  it('(g) a page turn before the first sentence sounds is a move away from where begin() started', async () => {
    const s = section('s0', [['A one.', 'A two.'], ['B one.', 'B two.'], ['C one.']])
    const { view, controller } = make([s])
    view.lastLocation = { range: pageAt(s.doc, 0) }
    await controller.begin()
    await controller.take() // taken, synthesizing, not yet started
    // the same page again (the engine re-reporting it) is not a move
    expect(await controller.onRelocate(pageAt(s.doc, 0) as unknown as Range)).toBeNull()
    // the reader turned the page while the first sentence was still being synthesized
    const c = s.blocks[2]!.sentences[0]!
    const page = new FakeRange(s.doc, c.range.start, c.range.end)
    const first = await controller.onRelocate(page as unknown as Range)
    expect(first?.text).toBe('C one.')
  })

  it("(g) a relocate away restarts at that page's first sentence, and takes continue from there (AC17)", async () => {
    const s = section('s0', [['A one.', 'A two.'], ['B one.', 'B two.', 'B three.'], ['C one.']])
    const { view, controller } = make([s])
    await controller.begin()
    const u0 = (await controller.take())!
    await controller.take()
    controller.started(u0)
    // the user turned to a page starting just after "B one." begins
    const b = s.blocks[1]!.sentences
    const page = new FakeRange(s.doc, b[0]!.range.start + 3, b[2]!.range.end)
    const first = await controller.onRelocate(page as unknown as Range)
    expect(first?.text).toBe('B two.')
    expect(await controller.take()).toBe(first)
    const second = (await controller.take())!
    expect(second.text).toBe('B three.')
    // the old block's sentence, if it is still reported, no longer draws anything
    view.added.length = 0
    controller.started(u0)
    await flush()
    expect(view.added).toEqual([])
    controller.started(first!)
    await flush()
    expect(view.added.map((a) => a.value)).toEqual([`0@${b[1]!.range.start}`])
    // the restarted page is now where speech is: the same page again is not a move
    expect(await controller.onRelocate(page as unknown as Range)).toBeNull()
  })

  it('(g) a relocate into another section rebinds there and restarts', async () => {
    const s0 = section('s0', [['A one.', 'A two.']])
    const s1 = section('s1', [['N one.'], ['M one.']])
    const { view, controller } = make([s0, s1])
    await controller.begin()
    const u0 = (await controller.take())!
    controller.started(u0)
    view.index = 1 // the user jumped through the contents
    const page = new FakeRange(s1.doc, s1.blocks[1]!.range.start, s1.blocks[1]!.range.end)
    const first = await controller.onRelocate(page as unknown as Range)
    expect(first?.text).toBe('M one.')
    expect(view.tts?.doc).toBe(s1.doc)
  })

  it('(h) dispose deletes the speech highlight', async () => {
    const { view, controller } = make([section('s0', [['A one.']])])
    await controller.begin()
    const u0 = (await controller.take())!
    controller.started(u0)
    await flush()
    expect(view.added).toHaveLength(1)
    controller.dispose()
    await flush()
    expect(view.deleted.map((a) => a.value)).toContain(view.added[0]!.value)
    expect(await controller.take()).toBeNull()
  })

  it('draws one speech annotation at a time, of the speech kind, in the color read fresh', async () => {
    let color = '#111111'
    const { view, controller } = make([section('s0', [['A one.', 'A two.']])], {
      color: () => color
    })
    await controller.begin()
    const u0 = (await controller.take())!
    const u1 = (await controller.take())!
    controller.started(u0)
    await flush()
    color = '#222222'
    controller.started(u1)
    await flush()
    expect(view.added.map((a) => [a.kind, a.color])).toEqual([
      [SPEECH_DRAW_KIND, '#111111'],
      [SPEECH_DRAW_KIND, '#222222']
    ])
    expect(view.deleted.map((a) => a.value)).toEqual([view.added[0]!.value])
    // scrolling without selecting: a selected sentence would raise the selection chip
    expect(view.renderer.scrollToAnchor.mock.calls.every((c) => c[1] !== true)).toBe(true)
  })

  it('(i) a highlight the engine refuses does not reject started, and the page still scrolls', async () => {
    const { view, controller } = make([section('s0', [['A one.']])])
    await controller.begin()
    const u0 = (await controller.take())!
    view.addThrows = true
    expect(() => controller.started(u0)).not.toThrow()
    await flush()
    expect(view.renderer.scrollToAnchor).toHaveBeenCalledTimes(1)
  })

  it('abort settles a pending take with null at once', async () => {
    const { controller } = make([section('s0', [['A one.'], ['B one.']])])
    await controller.begin()
    await controller.take()
    const pending = controller.take()
    await flush()
    controller.abort()
    expect(await pending).toBeNull()
  })

  it('a section that never loads reports one line after 10 s and the take settles null', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { view, controller, onError } = make([
      section('s0', [['A one.']]),
      section('s1', [['N.']])
    ])
    await controller.begin()
    const u0 = (await controller.take())!
    controller.started(u0)
    controller.ended(u0)
    view.hang = true
    const pending = track(controller.take())
    await flush()
    expect(pending.settled).toBe(false)
    vi.advanceTimersByTime(10_000)
    expect(await pending.value).toBeNull()
    expect(onError).toHaveBeenCalledWith('Could not continue to the next chapter.')
    expect(view.listenerCount()).toBe(0)
  })

  it('abort settles a take that is waiting on a section load', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { view, controller, onError } = make([
      section('s0', [['A one.']]),
      section('s1', [['N.']])
    ])
    await controller.begin()
    const u0 = (await controller.take())!
    controller.started(u0)
    controller.ended(u0)
    view.hang = true
    const pending = controller.take()
    await flush()
    controller.abort()
    expect(await pending).toBeNull()
    expect(onError).not.toHaveBeenCalled()
    // superseded: the section wait may still end, but it says nothing
    vi.advanceTimersByTime(10_000)
    await flush()
    expect(onError).not.toHaveBeenCalled()
  })

  it('begin from a range starts at the first sentence at or after it', async () => {
    const s = section('s0', [
      ['A one.', 'A two.'],
      ['B one.', 'B two.']
    ])
    const { controller } = make([s])
    const b = s.blocks[1]!.sentences
    const from = new FakeRange(s.doc, b[1]!.range.start, b[1]!.range.end)
    expect(await controller.begin(from as unknown as Range)).toBe(true)
    expect((await controller.take())?.text).toBe('B two.')
  })

  it("begin without a range starts at the page on screen (the view's last location)", async () => {
    const s = section('s0', [
      ['A one.', 'A two.'],
      ['B one.', 'B two.']
    ])
    const { view, controller } = make([s])
    view.lastLocation = { range: new FakeRange(s.doc, s.blocks[1]!.range.start, 99) }
    await controller.begin()
    expect((await controller.take())?.text).toBe('B one.')
  })

  // ------------------------------------------------------------ review fixes

  it('begin on an image-only cover reaches the first sentence of the next section', async () => {
    const cover = section('cover', [])
    const s1 = section('s1', [['First words.']])
    const { view, controller } = make([cover, s1])
    // a freshly opened book: the page on screen is the cover, where `from()` throws
    view.lastLocation = { range: pageAt(cover.doc, 0) }
    expect(await controller.begin()).toBe(true)
    expect((await controller.take())?.text).toBe('First words.')
    expect(view.tts?.doc).toBe(s1.doc)
  })

  it('a relocate onto a page past the last text block does not reject', async () => {
    const s0 = section('s0', [['A one.'], ['A two.']])
    const s1 = section('s1', [['N one.']])
    const { controller } = make([s0, s1])
    await controller.begin()
    const u0 = (await controller.take())!
    controller.started(u0)
    // a trailing image page after the section's text
    const first = await controller.onRelocate(pageAt(s0.doc, 90) as unknown as Range)
    expect(first?.text).toBe('N one.')
  })

  it('does not scroll for a sentence already on the page', async () => {
    const s = section('s0', [['A.', 'B.', 'C.', 'D.']])
    const { view, controller } = make([s])
    view.lastLocation = { range: pageAt(s.doc, 0) }
    await controller.begin()
    const units = [(await controller.take())!, (await controller.take())!]
    units.push((await controller.take())!, (await controller.take())!)
    for (const u of units.slice(0, 3)) controller.started(u)
    expect(view.renderer.scrollToAnchor).not.toHaveBeenCalled()
    // "D." starts at 30: the next page
    controller.started(units[3]!)
    expect(view.renderer.scrollToAnchor).toHaveBeenCalledTimes(1)
    expect(view.renderer.scrollToAnchor.mock.calls[0]![0].start).toBe(30)
  })

  it('leaves a saved highlight on the same sentence alone: never drawn over, never deleted', async () => {
    const s = section('s0', [['A.', 'B.', 'C.']])
    const savedCfi = `0@${s.blocks[0]!.sentences[1]!.range.start}`
    const { view, controller } = make([s], { saved: new Set([savedCfi]) })
    await controller.begin()
    const units = [
      (await controller.take())!,
      (await controller.take())!,
      (await controller.take())!
    ]
    for (const u of units) {
      controller.started(u)
      await flush()
    }
    expect(view.added.map((a) => a.value)).not.toContain(savedCfi)
    expect(view.deleted.map((a) => a.value)).not.toContain(savedCfi)
    // the fill for "A." went when "B." started, though "B." drew none of its own
    expect(view.deleted.map((a) => a.value)).toContain(
      `0@${s.blocks[0]!.sentences[0]!.range.start}`
    )
    controller.dispose()
    await flush()
    expect(view.deleted.map((a) => a.value)).not.toContain(savedCfi)
  })

  it('a paginator that is busy (locked) does not end the book while sections remain', async () => {
    const { view, controller, onError } = make([
      section('s0', [['A one.']]),
      section('s1', [['N one.']])
    ])
    await controller.begin()
    const u0 = (await controller.take())!
    controller.started(u0)
    controller.ended(u0)
    view.locked = 2 // the user's own page turn holds the lock for two tries
    expect((await controller.take())?.text).toBe('N one.')
    expect(view.renderer.nextSection).toHaveBeenCalledTimes(3)
    expect(onError).not.toHaveBeenCalled()
  })

  it('skips non-linear sections when deciding the end of the book', async () => {
    const { view, controller } = make([
      section('s0', [['A one.']]),
      section('notes', [['X.']], 'no')
    ])
    await controller.begin()
    const u0 = (await controller.take())!
    controller.started(u0)
    expect(await controller.take()).toBeNull()
    expect(view.renderer.nextSection).not.toHaveBeenCalled()
  })

  it('a paginator that never moves while sections remain gives up after 10 s, with one line', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { view, controller, onError } = make([
      section('s0', [['A one.']]),
      section('s1', [['N.']])
    ])
    await controller.begin()
    const u0 = (await controller.take())!
    controller.started(u0)
    controller.ended(u0)
    view.locked = Number.POSITIVE_INFINITY
    const pending = track(controller.take())
    for (let t = 0; t < 10_000; t += 100) {
      await flush()
      vi.advanceTimersByTime(100)
    }
    await flush()
    expect(await pending.value).toBeNull()
    expect(onError).toHaveBeenCalledWith('Could not continue to the next chapter.')
  })

  it('a superseded section step stops retrying: a page turn mid-crossing is not followed by another step', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { view, controller, onError } = make([
      section('s0', [['A one.']]),
      section('s1', [['N.']])
    ])
    await controller.begin()
    const u0 = (await controller.take())!
    controller.started(u0)
    controller.ended(u0)
    view.locked = Number.POSITIVE_INFINITY // the reader's own page turn holds the lock
    const pending = track(controller.take())
    await flush()
    expect(view.renderer.nextSection).toHaveBeenCalledTimes(1)
    // the player restarts at the reader's page: the take is superseded
    controller.abort()
    expect(await pending.value).toBeNull()
    // the lock releases: a retry now would step the reader one section past their page
    view.locked = 0
    for (let t = 0; t < 1_000; t += 50) {
      vi.advanceTimersByTime(50)
      await flush()
    }
    expect(view.renderer.nextSection).toHaveBeenCalledTimes(1)
    expect(view.index).toBe(0)
    expect(onError).not.toHaveBeenCalled()
  })

  it('begin supersedes a take waiting at the block gate: it continues from the new place', async () => {
    const s = section('s0', [['A one.', 'A two.'], ['B one.'], ['C one.', 'C two.']])
    const { controller } = make([s])
    await controller.begin()
    await controller.take()
    await controller.take()
    const pending = track(controller.take())
    await flush()
    expect(pending.settled).toBe(false)
    const c = s.blocks[2]!.sentences
    await controller.begin(
      new FakeRange(s.doc, c[0]!.range.start, c[0]!.range.end) as unknown as Range
    )
    expect((await pending.value)?.text).toBe('C one.')
  })

  // ------------------------------------------------------------ AC15: a section boundary

  it("(AC15) the page does not move to the next section until the old section's last sentence has ended", async () => {
    const s0 = section('s0', [['A one.'], ['B one.', 'B two.']])
    const s1 = section('s1', [['N one.']])
    const { view, controller } = make([s0, s1])
    await controller.begin()
    const a = (await controller.take())!
    controller.started(a)
    // block to block inside a section: no wait for the end of the sound
    const b0 = (await controller.take())!
    const b1 = (await controller.take())!
    expect(b0.text).toBe('B one.')
    controller.started(b0)
    controller.started(b1)
    const next = track(controller.take())
    await flush()
    // "B two." is sounding: the page stays where its highlight is
    expect(next.settled).toBe(false)
    expect(view.renderer.nextSection).not.toHaveBeenCalled()
    expect(view.index).toBe(0)
    // a unit other than the section's last one ending changes nothing
    controller.ended(b0)
    await flush()
    expect(view.renderer.nextSection).not.toHaveBeenCalled()
    controller.ended(b1)
    expect((await next.value)?.text).toBe('N one.')
    expect(view.renderer.nextSection).toHaveBeenCalledTimes(1)
    expect(view.index).toBe(1)
  })

  it('(AC15) the end of the book does not wait for the last sound', async () => {
    const { controller } = make([section('s0', [['A one.']])])
    await controller.begin()
    const u0 = (await controller.take())!
    controller.started(u0)
    expect(await controller.take()).toBeNull()
  })

  it('(AC15) a take waiting on the last sound settles on abort and on dispose, and never steps the section', async () => {
    const sections = [section('s0', [['A one.']]), section('s1', [['N one.']])]
    const one = make(sections)
    await one.controller.begin()
    const u0 = (await one.controller.take())!
    one.controller.started(u0)
    const p = track(one.controller.take())
    await flush()
    one.controller.abort()
    expect(await p.value).toBeNull()
    one.controller.ended(u0)
    await flush()
    expect(one.view.renderer.nextSection).not.toHaveBeenCalled()

    const two = make([section('s0', [['A one.']]), section('s1', [['N one.']])])
    await two.controller.begin()
    const v0 = (await two.controller.take())!
    two.controller.started(v0)
    const q = track(two.controller.take())
    await flush()
    two.controller.dispose()
    expect(await q.value).toBeNull()
    expect(two.view.renderer.nextSection).not.toHaveBeenCalled()
  })

  it('(AC15) an end reported before a rewind is stale: the replayed last unit is waited for again', async () => {
    const { view, controller } = make([section('s0', [['A one.', 'A two.']]), section('s1', [['N.']])])
    await controller.begin()
    const a0 = (await controller.take())!
    const a1 = (await controller.take())!
    controller.started(a0)
    controller.started(a1)
    // skip(-1) on the last unit: the player rewinds, then cuts the sounding unit (its end)
    controller.rewind(a0)
    controller.ended(a1)
    expect(await controller.take()).toBe(a0)
    expect(await controller.take()).toBe(a1)
    controller.started(a0)
    controller.started(a1)
    const next = track(controller.take())
    await flush()
    expect(next.settled).toBe(false)
    expect(view.renderer.nextSection).not.toHaveBeenCalled()
    controller.ended(a1)
    expect((await next.value)?.text).toBe('N.')
  })

  it("(AC15) the reader's own page turn is not held up by the wait for the last sound", async () => {
    const s0 = section('s0', [['A one.'], ['B one.']])
    const s1 = section('s1', [['N one.']])
    const { view, controller } = make([s0, s1])
    await controller.begin()
    const a = (await controller.take())!
    controller.started(a)
    const b = (await controller.take())!
    controller.started(b)
    const pending = track(controller.take())
    await flush()
    // the reader turns back to "A one."'s page while "B one." is still sounding
    const page = new FakeRange(s0.doc, 0, 9)
    const first = await controller.onRelocate(page as unknown as Range)
    expect(first?.text).toBe('A one.')
    expect(view.renderer.nextSection).not.toHaveBeenCalled()
    controller.abort()
    await pending.value
  })

  // ------------------------------------------------------------ AC17: a page that continues a block

  /**
   * A figure caption that began on the page before: block 1 ("FIG. 2." + its long sentence)
   * starts at 20, and the page turned to starts at 30 — inside the caption's last sentence.
   * Foliate's `from()` finds no mark starting on the page and hands back the whole block,
   * "FIG. 2." first (`tts.js:263-269`); the fake does the same.
   */
  function captionBook() {
    // positions: A 0-9 / A' 10-19 | FIG 20-29, caption 30-39... the page starts at 35
    const s = section('s0', [['A one.', 'A two.'], ['FIG. 2.', 'Selection and history interact.'], ['Next para.']])
    return s
  }

  it('(AC17) a page turn into the tail of a block restarts at the first sentence that starts on the new page', async () => {
    const s = captionBook()
    const { view, controller } = make([s])
    await controller.begin()
    const a0 = (await controller.take())!
    controller.started(a0)
    const cap = s.blocks[1]!.sentences[1]!.range
    // the new page starts inside the caption's last sentence
    const page = new FakeRange(s.doc, cap.start + 5, 69)
    view.relocate(page)
    const first = await controller.onRelocate(page as unknown as Range)
    expect(first?.text).toBe('Next para.')
    expect(await controller.take()).toBe(first)
    // its highlight is on the new page: no scroll at all, and never back
    view.renderer.scrollToAnchor.mockClear()
    controller.started(first!)
    expect(view.renderer.scrollToAnchor).not.toHaveBeenCalled()
  })

  it('(AC17) a page that starts inside a block keeps the sentences of that block that start on it', async () => {
    const s = section('s0', [['A one.'], ['FIG. 2.', 'Caption one.', 'Caption two.']])
    const { view, controller } = make([s])
    await controller.begin()
    const a0 = (await controller.take())!
    controller.started(a0)
    const fig = s.blocks[1]!.sentences
    const page = new FakeRange(s.doc, fig[0]!.range.start + 3, 59)
    view.relocate(page)
    const first = await controller.onRelocate(page as unknown as Range)
    expect(first?.text).toBe('Caption one.')
    expect(await controller.take()).toBe(first)
    expect((await controller.take())?.text).toBe('Caption two.')
  })

  it('(AC17) Play on such a page starts on it too, not at the block start on the page before', async () => {
    const s = captionBook()
    const { view, controller } = make([s])
    const cap = s.blocks[1]!.sentences[1]!.range
    view.lastLocation = { range: new FakeRange(s.doc, cap.start + 5, 69) }
    await controller.begin()
    expect((await controller.take())?.text).toBe('Next para.')
  })

  it('ignores the relocates of its own section change, during it and after it', async () => {
    const s0 = section('s0', [['A one.']])
    const s1 = section('s1', [['N one.', 'N two.']])
    const { view, controller } = make([s0, s1])
    const answers: Promise<SpeechUnit | null>[] = []
    view.relocated = (page) => answers.push(controller.onRelocate(page as unknown as Range))
    await controller.begin()
    const u0 = (await controller.take())!
    controller.started(u0)
    controller.ended(u0)
    answers.length = 0
    const n0 = (await controller.take())!
    // the `moving` guard: the relocate nextSection emits while it is in flight
    expect(answers).toHaveLength(1)
    expect(await answers[0]).toBeNull()
    // after it: "A one." is still sounding in the old document, the page is the new one
    expect(await controller.onRelocate(pageAt(s1.doc, 0) as unknown as Range)).toBeNull()
    // no restart happened: the cursor goes on from where it was
    expect((await controller.take())?.text).toBe('N two.')
    expect(n0.text).toBe('N one.')
  })
})
