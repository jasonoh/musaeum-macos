/**
 * The voice reader's engine arm (spec D5): the only code that touches foliate's TTS
 * cursor. It turns the engine's own marked sentences (`view.initTTS('sentence')`) into
 * `SpeechUnit`s for the `SpeechPlayer`, draws the sentence being spoken, and follows the
 * reader when the user moves.
 *
 * **The one ordering it owns** (plan, *Facts found while planning* 1): foliate rebuilds its
 * sentence-range map every time the cursor lands on a block (`tts.js:213-216`), and
 * `setMark(name)` looks the name up in the block the cursor is on *now* — with names that
 * restart at `"0"` in every block. So `tts.next()` is never called until the current
 * block's last unit has `started()` (its `setMark` already made): a `setMark` after the move
 * would highlight the next block's sentence of the same number, or nothing. And `started()`
 * for a unit of a block the cursor has already left (a restart superseded it) draws nothing,
 * for the same reason.
 *
 * Format-blind by rule (reader invariant D10): a reflowed PDF is an EPUB here.
 */
import type { FoliateTTS } from '@vendor/foliate-js/view.js'
import type { PlayerSource } from './speech-player'
import { flattenSsml, type SpeechUnit } from './speech-queue'

/** The annotation kind the engine's `draw-annotation` arm draws speech with. Never persisted. */
export const SPEECH_DRAW_KIND = 'speech' as const

/** What the controller hands `addAnnotation`: a CFI key, and the kind and color the draw reads back. */
export interface SpeechAnnotation {
  value: string
  kind: typeof SPEECH_DRAW_KIND
  color: string
}

/**
 * The slice of `foliate-view` the controller drives, structurally — a `FoliateView`
 * satisfies it, and so does the test's fake.
 */
export interface SpeechView {
  renderer?: {
    getContents(): { index: number; doc: Document }[]
    scrollToAnchor?(anchor: Range, select?: boolean): Promise<void>
    nextSection?(): Promise<void>
  }
  tts?: FoliateTTS | null
  lastLocation?: { range?: Range | null } | null
  initTTS(granularity: 'sentence', highlight: (range: Range) => void): Promise<void>
  getCFI(index: number, range: Range): string
  addAnnotation(annotation: SpeechAnnotation): Promise<unknown>
  deleteAnnotation(annotation: SpeechAnnotation): Promise<unknown>
  addEventListener(type: 'load', listener: (event: Event) => void): void
  removeEventListener(type: 'load', listener: (event: Event) => void): void
}

export interface SpeechControllerDeps {
  view: SpeechView
  /** The resolved palette literal (`ReaderPalette.speech`), read fresh at every sentence. */
  speechColor(): string
  onError(message: string): void
}

/** How long a section change may take before speech gives up on it. */
export const SECTION_LOAD_TIMEOUT_MS = 10_000
export const SECTION_LOAD_ERROR = 'Could not continue to the next chapter.'

// `Range.START_TO_START` / `START_TO_END`, spelled out: the tests run without a DOM.
const START_TO_START = 0
const START_TO_END = 1

interface Ticket {
  settled: boolean
  settle(unit: SpeechUnit | null): void
}

function docOf(range: Range): Node {
  const node = range.startContainer
  return node.ownerDocument ?? node
}

/** Whether `inner` starts on the page `page` covers (both ends inclusive). */
function startsInside(page: Range, inner: Range): boolean {
  try {
    return (
      page.compareBoundaryPoints(START_TO_START, inner) <= 0 &&
      page.compareBoundaryPoints(START_TO_END, inner) >= 0
    )
  } catch {
    return false
  }
}

function collapsedStart(range: Range): Range {
  const r = range.cloneRange()
  r.collapse(true)
  return r
}

/**
 * Decisions the brief left open, taken here:
 * - **The highlight scrolls without selecting** (`scrollToAnchor(range, false)`). Foliate's
 *   default passes `true`, which makes the paginator *select* the sentence — and a selection
 *   in the book raises the reader's selection chip and becomes the ask panel's selection, on
 *   every sentence. `false` scrolls the same way and leaves a caret.
 * - **"Did the section move" is read from the renderer, not from `nextSection()`'s result**,
 *   which is `undefined` both when it moved and at the last section. A `load` seen, or a new
 *   document in `getContents()`, means it moved; neither means the book is over.
 * - **The sounding sentence is the last one highlighted**, kept until a restart replaces it
 *   with the restart page's start, so a second relocate onto that same page is not a move.
 */
export class SpeechController implements PlayerSource {
  private readonly view: SpeechView
  private tts: FoliateTTS | null = null
  /** The spine index `tts` was built over: `getCFI` needs it. */
  private ttsIndex = 0
  private blockUnits: SpeechUnit[] = []
  private idx = 0
  /** The current block's last unit has started: the cursor may move on. */
  private lastStarted = false
  /** Where speech is: the last highlighted range, or a restart's page start. */
  private sounding: Range | null = null
  private mark: SpeechAnnotation | null = null
  private drawing: Promise<void> = Promise.resolve()
  private pending: Ticket | null = null
  private wakers: (() => void)[] = []
  /** Every cursor move runs here, one at a time. */
  private queue: Promise<unknown> = Promise.resolve()
  /** A section change of our own is in flight; its relocates are ours, not the user's. */
  private moving = false
  private cancelMove: (() => void) | null = null
  private disposed = false

  constructor(private readonly deps: SpeechControllerDeps) {
    this.view = deps.view
  }

  async begin(from?: Range): Promise<boolean> {
    if (this.disposed) return false
    return this.serial(async () => {
      if (this.disposed || !(await this.bind())) return false
      const tts = this.tts
      if (!tts) return false
      const anchor = from ?? this.view.lastLocation?.range ?? null
      const ssml = anchor && docOf(anchor) === tts.doc ? tts.from(anchor) : tts.start()
      this.setBlock(flattenSsml(ssml))
      this.sounding = null
      return this.blockUnits.length > 0 || (await this.nextBlock())
    })
  }

  take(): Promise<SpeechUnit | null> {
    if (this.disposed) return Promise.resolve(null)
    this.pending?.settle(null)
    return new Promise<SpeechUnit | null>((resolve, reject) => {
      const ticket: Ticket = {
        settled: false,
        settle: (unit) => {
          if (ticket.settled) return
          ticket.settled = true
          if (this.pending === ticket) this.pending = null
          resolve(unit)
        }
      }
      this.pending = ticket
      this.produce(ticket).then(ticket.settle, (e: unknown) => {
        if (ticket.settled) return
        ticket.settled = true
        if (this.pending === ticket) this.pending = null
        reject(e instanceof Error ? e : new Error(String(e)))
      })
    })
  }

  started(unit: SpeechUnit): void {
    if (this.disposed) return
    const at = this.blockUnits.indexOf(unit)
    // A unit of a block the cursor has left: its name now means another block's sentence.
    if (at < 0) return
    try {
      this.tts?.setMark(unit.mark)
    } catch {
      // a highlight is never worth the voice
    }
    if (at === this.blockUnits.length - 1) {
      this.lastStarted = true
      this.wake()
    }
  }

  rewind(unit: SpeechUnit): void {
    const at = this.blockUnits.indexOf(unit)
    if (at < 0) throw new Error('The voice reader lost its place in the book.')
    this.idx = at
    // the block's last unit will sound again, and the cursor must wait for it again
    this.lastStarted = false
  }

  abort(): void {
    this.pending?.settle(null)
    this.wake()
  }

  async onRelocate(pageRange: Range | null): Promise<SpeechUnit | null> {
    if (this.disposed || this.moving || !pageRange || !this.sounding) return null
    const page = pageRange.cloneRange()
    const pageDoc = docOf(page)
    if (docOf(this.sounding) === pageDoc) {
      if (startsInside(page, this.sounding)) return null
    } else if (this.tts && pageDoc === this.tts.doc) {
      // our own section change: the old section's last sentence is still sounding, and the
      // next highlight lands on this document
      return null
    }
    return this.serial(async () => {
      if (this.disposed) return null
      if (!this.tts || this.tts.doc !== pageDoc) {
        if (!(await this.bind()) || !this.tts || this.tts.doc !== pageDoc) return null
      }
      this.setBlock(flattenSsml(this.tts.from(page)))
      this.sounding = collapsedStart(page)
      this.wake()
      if (this.blockUnits.length === 0 && !(await this.nextBlock())) return null
      return this.blockUnits[0] ?? null
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pending?.settle(null)
    this.wake()
    this.cancelMove?.()
    const last = this.mark
    this.mark = null
    if (last) this.draw(async () => void (await this.view.deleteAnnotation(last)))
    this.tts = null
    this.blockUnits = []
    this.sounding = null
  }

  // ------------------------------------------------------------ the cursor

  private async produce(ticket: Ticket): Promise<SpeechUnit | null> {
    for (;;) {
      if (ticket.settled || this.disposed) return null
      const unit = this.blockUnits[this.idx]
      if (unit) {
        this.idx += 1
        return unit
      }
      if (this.blockUnits.length > 0 && !this.lastStarted) {
        await this.sleep()
        continue
      }
      // The block is spent and its last unit has started: the cursor may move.
      const ok = await this.serial(async () => {
        if (ticket.settled || this.disposed) return false
        // a restart or a rewind landed while this waited its turn: look again
        if (this.idx < this.blockUnits.length || (this.blockUnits.length > 0 && !this.lastStarted))
          return true
        return this.nextBlock()
      })
      if (!ok) return null
    }
  }

  /** Move to the next block that has something to say, crossing sections. False at the end. */
  private async nextBlock(): Promise<boolean> {
    for (;;) {
      if (this.disposed || !this.tts) return false
      let ssml = this.tts.next()
      if (ssml === undefined) {
        if (!(await this.advanceSection()) || !this.tts) return false
        ssml = this.tts.start()
      }
      const units = flattenSsml(ssml)
      if (units.length > 0) {
        this.setBlock(units)
        return true
      }
    }
  }

  private async advanceSection(): Promise<boolean> {
    const renderer = this.view.renderer
    if (!renderer?.nextSection) return false
    const before = renderer.getContents()[0]?.doc
    let loaded = false
    const onLoad = (): void => {
      loaded = true
    }
    this.view.addEventListener('load', onLoad)
    this.moving = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let outcome: 'moved' | 'failed' | 'timeout' | 'cancelled'
    try {
      outcome = await new Promise<typeof outcome>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), SECTION_LOAD_TIMEOUT_MS)
        this.cancelMove = () => resolve('cancelled')
        renderer.nextSection?.().then(
          () => resolve('moved'),
          () => resolve('failed')
        )
      })
    } finally {
      clearTimeout(timer)
      this.view.removeEventListener('load', onLoad)
      this.moving = false
      this.cancelMove = null
    }
    if (outcome === 'cancelled' || this.disposed) return false
    if (outcome !== 'moved') {
      this.deps.onError(SECTION_LOAD_ERROR)
      return false
    }
    // `nextSection()` resolves the same way at the last section: it is over only if nothing moved
    if (!loaded && renderer.getContents()[0]?.doc === before) return false
    return this.bind()
  }

  /** Build (or re-adopt) the engine's cursor over the section on screen, with our highlight. */
  private async bind(): Promise<boolean> {
    const contents = this.view.renderer?.getContents()[0]
    if (!contents) return false
    await this.view.initTTS('sentence', this.highlight)
    const tts = this.view.tts
    if (this.disposed || !tts) return false
    // `initTTS` keeps an existing cursor on the same document, and with it the old highlight
    tts.highlight = this.highlight
    this.tts = tts
    this.ttsIndex = contents.index
    return true
  }

  private setBlock(units: SpeechUnit[]): void {
    this.blockUnits = units
    this.idx = 0
    this.lastStarted = false
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  private sleep(): Promise<void> {
    return new Promise<void>((resolve) => this.wakers.push(resolve))
  }

  private wake(): void {
    const wakers = this.wakers
    this.wakers = []
    for (const w of wakers) w()
  }

  // ------------------------------------------------------------ the highlight

  /** Foliate's `highlight` hook: scroll to the sentence and redraw the one speech annotation. */
  private readonly highlight = (range: Range): void => {
    if (this.disposed) return
    this.sounding = range
    try {
      void this.view.renderer?.scrollToAnchor?.(range, false)?.catch(() => {})
    } catch {
      // the page stays where it is; the voice goes on
    }
    let value: string
    try {
      value = this.view.getCFI(this.ttsIndex, range)
    } catch {
      return
    }
    const next: SpeechAnnotation = { value, kind: SPEECH_DRAW_KIND, color: this.deps.speechColor() }
    const previous = this.mark
    this.mark = next
    this.draw(async () => {
      if (previous) await this.view.deleteAnnotation(previous)
    })
    this.draw(async () => {
      if (this.mark === next) await this.view.addAnnotation(next)
    })
  }

  /** Draws run in order; a refusal (an unresolvable value throws) is swallowed. */
  private draw(step: () => Promise<void>): void {
    this.drawing = this.drawing.then(step).catch(() => {})
  }
}
