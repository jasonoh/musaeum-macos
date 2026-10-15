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
  book?: { sections?: { linear?: string }[] }
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
  /**
   * Whether a CFI is a saved highlight's, read fresh. The overlayer keys a drawing by its
   * value alone (`view.js:389` removes whatever is under it), so a speech fill under a saved
   * highlight's CFI would replace that highlight on the page and take it with it when removed.
   */
  isSaved(cfi: string): boolean
  onError(message: string): void
}

/** How long a section change may take, retries included, before speech gives up on it. */
export const SECTION_LOAD_TIMEOUT_MS = 10_000
/** The pause before asking a busy paginator again (it ignores a section step mid page turn). */
export const SECTION_RETRY_MS = 150
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
      docOf(page) === docOf(inner) &&
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
 * The block at `range`, or null when the section has no text block at or after it.
 * Foliate's `from()` *throws* for that (`tts.js:261`) rather than answering undefined — an
 * image-only cover is the everyday case, and it is where a freshly opened book sits.
 */
function blockFrom(tts: FoliateTTS, range: Range): string | null {
  try {
    return tts.from(range) ?? null
  } catch {
    return null
  }
}

/**
 * Decisions the brief left open, taken here:
 * - **The highlight scrolls only when the sentence is off the page**, and without selecting
 *   (`scrollToAnchor(range, false)`). Every `scrollToAnchor` emits a `relocate` even when the
 *   page does not move, and the paginator answers one by resetting the book's selection
 *   (`paginator.js:577-583`) — so scrolling every sentence wiped a selection the reader was
 *   holding, re-ran the highlight plan and restarted the position-save debounce each time.
 *   Foliate's default passes `true`, which *selects* the sentence and would raise the
 *   selection chip on every one.
 * - **A sentence that is a saved highlight's CFI gets no speech fill**: the saved highlight
 *   already marks it, and the overlayer could not hold both under one key.
 * - **The end of the book is read from its structure** (no linear section after this one),
 *   not from `nextSection()`, which resolves `undefined` both when it moved and when it did
 *   not — and does not move while the paginator holds its lock for the reader's own page turn.
 *   A step that did not move while sections remain is retried every `SECTION_RETRY_MS`,
 *   within the one `SECTION_LOAD_TIMEOUT_MS`.
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
  /** The take that asked for the section change was aborted: its failure is nobody's news. */
  private moveSuperseded = false
  private cancelMove: (() => void) | null = null
  private disposed = false

  constructor(private readonly deps: SpeechControllerDeps) {
    this.view = deps.view
  }

  /**
   * Safe with a take pending: the cursor moves and the waiting take continues from the new
   * place (it is woken, as a relocate wakes it).
   */
  async begin(from?: Range): Promise<boolean> {
    if (this.disposed) return false
    return this.serial(async () => {
      if (this.disposed || !(await this.bind())) return false
      const tts = this.tts
      if (!tts) return false
      const anchor = from ?? this.view.lastLocation?.range ?? null
      let ssml: string | null | undefined
      let pastEnd = false
      if (anchor && docOf(anchor) === tts.doc) {
        ssml = blockFrom(tts, anchor)
        pastEnd = ssml === null
      } else {
        ssml = tts.start()
      }
      this.setBlock(flattenSsml(ssml))
      this.sounding = null
      this.wake()
      return this.blockUnits.length > 0 || (await this.nextBlock(pastEnd))
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
    // A section change in flight is left to finish — the reader really is moving, and
    // abandoning it would make the next take step a second section — but its timeout is
    // no longer anyone's to report.
    if (this.moving) this.moveSuperseded = true
    this.pending?.settle(null)
    this.wake()
  }

  async onRelocate(pageRange: Range | null): Promise<SpeechUnit | null> {
    if (!pageRange) return null
    const page = pageRange.cloneRange()
    if (!this.isMove(page)) return null
    return this.serial(async () => {
      // looked at again: a section change or a restart may have landed while this waited
      if (!this.isMove(page)) return null
      const pageDoc = docOf(page)
      if (!this.tts || this.tts.doc !== pageDoc) {
        if (!(await this.bind()) || !this.tts || this.tts.doc !== pageDoc) return null
      }
      const ssml = blockFrom(this.tts, page)
      this.setBlock(flattenSsml(ssml))
      this.sounding = collapsedStart(page)
      this.wake()
      if (this.blockUnits.length === 0 && !(await this.nextBlock(ssml === null))) return null
      return this.blockUnits[0] ?? null
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pending?.settle(null)
    this.wake()
    this.cancelMove?.()
    this.removeFill(this.mark)
    this.mark = null
    this.tts = null
    this.blockUnits = []
    this.sounding = null
  }

  // ------------------------------------------------------------ the cursor

  /** Whether a relocate onto `page` is the reader's own move, away from where speech is. */
  private isMove(page: Range): boolean {
    if (this.disposed || this.moving || !this.sounding) return false
    const pageDoc = docOf(page)
    if (docOf(this.sounding) === pageDoc) return !startsInside(page, this.sounding)
    // our own section change: the old section's last sentence is still sounding, and the
    // next highlight lands on this document
    return !(this.tts && pageDoc === this.tts.doc)
  }

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

  /**
   * Move to the next block that has something to say, crossing sections. False at the end.
   * `sectionDone`: this section has nothing more (a `from()` past its last block), so step
   * the section first rather than asking `next()` — whose cursor may sit on an earlier block.
   */
  private async nextBlock(sectionDone = false): Promise<boolean> {
    for (;;) {
      if (this.disposed || !this.tts) return false
      let ssml = sectionDone ? undefined : this.tts.next()
      sectionDone = false
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

  /** Is there a linear section after `index`? Unknown structure: assume so, and let the step say. */
  private hasLaterSection(index: number): boolean {
    const sections = this.view.book?.sections
    if (!sections) return true
    return sections.slice(index + 1).some((s) => s.linear !== 'no')
  }

  private async advanceSection(): Promise<boolean> {
    const renderer = this.view.renderer
    const here = renderer?.getContents()[0]
    if (!renderer?.nextSection || !here || !this.hasLaterSection(here.index)) return false
    const step = renderer.nextSection.bind(renderer)

    let loaded = false
    const onLoad = (): void => {
      loaded = true
    }
    this.view.addEventListener('load', onLoad)
    this.moving = true
    this.moveSuperseded = false
    let expiryTimer: ReturnType<typeof setTimeout> | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<'timeout'>((resolve) => {
      expiryTimer = setTimeout(() => resolve('timeout'), SECTION_LOAD_TIMEOUT_MS)
    })
    const cancelled = new Promise<'cancelled'>((resolve) => {
      this.cancelMove = () => resolve('cancelled')
    })
    try {
      for (;;) {
        let stepped: Promise<'moved' | 'failed'>
        try {
          stepped = step().then(
            () => 'moved' as const,
            () => 'failed' as const
          )
        } catch {
          stepped = Promise.resolve('failed' as const)
        }
        const outcome = await Promise.race([stepped, expiry, cancelled])
        if (outcome === 'cancelled' || this.disposed) return false
        if (outcome !== 'moved') return this.moveFailed()
        if (loaded || renderer.getContents()[0]?.doc !== here.doc) break
        // Sections remain and the paginator did not move: it is busy with the reader's own
        // page turn (its lock). Ask again shortly, inside the same deadline.
        const pause = await Promise.race([
          new Promise<'retry'>((resolve) => {
            retryTimer = setTimeout(() => resolve('retry'), SECTION_RETRY_MS)
          }),
          expiry,
          cancelled
        ])
        if (pause === 'cancelled' || this.disposed) return false
        if (pause === 'timeout') return this.moveFailed()
        // Superseded while it waited (a restart at the reader's own page): the step in flight
        // was left to finish, but a fresh one now would carry the reader a section past the
        // page they just turned to.
        if (this.moveSuperseded) return false
      }
    } finally {
      clearTimeout(expiryTimer)
      clearTimeout(retryTimer)
      this.view.removeEventListener('load', onLoad)
      this.moving = false
      this.cancelMove = null
    }
    return this.bind()
  }

  private moveFailed(): false {
    if (!this.moveSuperseded) this.deps.onError(SECTION_LOAD_ERROR)
    return false
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

  /** Foliate's `highlight` hook: bring the sentence on screen and redraw the one speech fill. */
  private readonly highlight = (range: Range): void => {
    if (this.disposed) return
    this.sounding = range
    const page = this.view.lastLocation?.range
    if (!page || !startsInside(page, range)) {
      try {
        void this.view.renderer?.scrollToAnchor?.(range, false)?.catch(() => {})
      } catch {
        // the page stays where it is; the voice goes on
      }
    }
    const previous = this.mark
    this.mark = null
    this.removeFill(previous)
    let value: string
    try {
      value = this.view.getCFI(this.ttsIndex, range)
    } catch {
      return
    }
    // a saved highlight already marks this sentence, and owns its key on the overlayer
    if (this.deps.isSaved(value)) return
    const next: SpeechAnnotation = { value, kind: SPEECH_DRAW_KIND, color: this.deps.speechColor() }
    this.mark = next
    this.draw(async () => {
      if (this.mark === next) await this.view.addAnnotation(next)
    })
  }

  private removeFill(fill: SpeechAnnotation | null): void {
    if (!fill) return
    this.draw(async () => {
      // a highlight saved on this sentence since it was drawn now holds the key: leave it
      if (!this.deps.isSaved(fill.value)) await this.view.deleteAnnotation(fill)
    })
  }

  /** Draws run in order; a refusal (an unresolvable value throws) is swallowed. */
  private draw(step: () => Promise<void>): void {
    this.drawing = this.drawing.then(step).catch(() => {})
  }
}
