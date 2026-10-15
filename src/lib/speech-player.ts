/**
 * The voice reader's player (spec D5): sentences from a `PlayerSource`, synthesized ahead and
 * scheduled back to back on one Web Audio clock. Nothing audible waits on a timer — a hidden
 * window throttles timers, not the audio clock. Scheduling advances on promise resolution and on
 * a buffer's `ended`; the only timer is the 100 ms highlight check, which compares the clock with
 * each item's start, so a suspended context (frozen `currentTime`) stops the highlight for free.
 */
import type { TtsAudio, TtsRequest, TtsVoice } from '@shared/tts.types'
import type { SpeechUnit } from './speech-queue'

/** The slice of the Web Audio API the player uses; a real `AudioContext` satisfies it. */
export interface AudioBufferLike {
  readonly length: number
  readonly sampleRate: number
  getChannelData(channel: number): Float32Array
}
export interface AudioSourceLike {
  buffer: AudioBufferLike | null
  onended: ((ev: Event) => unknown) | null
  connect(destination: object): unknown
  start(when?: number): void
  stop(when?: number): void
}
export interface AudioContextLike {
  readonly currentTime: number
  readonly destination: object
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBufferLike
  createBufferSource(): AudioSourceLike
  suspend(): Promise<void>
  resume(): Promise<void>
  close(): Promise<void>
}

export interface PlayerSource {
  /** Next unit, or null at the end of the book. May wait (a section is loading). */
  take(): Promise<SpeechUnit | null>
  /** Called when a unit starts sounding: the source may now release the next block. */
  started(unit: SpeechUnit): void
  /** Move the cursor so the next take() returns `unit` again. Only ever asked for a unit of the current block. */
  rewind(unit: SpeechUnit): void
}
export interface PlayerSpec {
  voice: TtsVoice
  speed: number
}
export interface PlayerDeps {
  context: AudioContextLike
  synthesize(request: TtsRequest): Promise<TtsAudio>
  source: PlayerSource
  /** Read per request, so a change lands on the next sentence. */
  spec(): PlayerSpec
  /** Drives the highlight. */
  onUnitStart(unit: SpeechUnit): void
  /** The book ended. */
  onEnd(): void
  onError(message: string): void
  prefetch?: number
  pauseMs?: { sentence: number; block: number }
}

const TICK_MS = 100

/** Mono signed 16-bit little-endian PCM → samples in [-1, 1). Honours the view's offset. */
export function pcmToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float32Array(bytes.byteLength >> 1)
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768
  return out
}

/** A small in-memory LRU of synthesis promises (spec D9: no disk cache). */
export class SentenceCache {
  private readonly entries = new Map<string, Promise<TtsAudio>>()
  constructor(private readonly max = 50) {}

  wrap(synthesize: (r: TtsRequest) => Promise<TtsAudio>): (r: TtsRequest) => Promise<TtsAudio> {
    return (r) => {
      const key = `${r.voice}|${r.speed}|${r.text}`
      const hit = this.entries.get(key)
      if (hit) {
        this.entries.delete(key)
        this.entries.set(key, hit)
        return hit
      }
      const p = synthesize(r)
      this.entries.set(key, p)
      p.catch(() => {
        if (this.entries.get(key) === p) this.entries.delete(key)
      })
      while (this.entries.size > this.max) {
        const oldest = this.entries.keys().next().value
        if (oldest === undefined) break
        this.entries.delete(oldest)
      }
      return p
    }
  }
}

interface Item {
  unit: SpeechUnit
  audio: Promise<TtsAudio>
  scheduled: boolean
  announced: boolean
  /** Null for silence, which occupies no time on the clock. */
  node: AudioSourceLike | null
  start: number
  /** The tail state before this item was placed, restored when it is discarded unstarted. */
  tailBefore: number | null
  blockEndBefore: boolean
}

export class SpeechPlayer {
  private readonly ctx: AudioContextLike
  private readonly prefetch: number
  private readonly pauseMs: { sentence: number; block: number }
  /** Taken units not yet finished, in order: started ones first, then the unstarted queue. */
  private items: Item[] = []
  /** The source's current block as far as it has been taken, for rewinds. */
  private blockTaken: SpeechUnit[] = []
  private newBlockNext = false
  private tailEnd: number | null = null
  private prevBlockEnd = false
  private current: SpeechUnit | null = null
  private running = false
  private stopped = false
  private sourceDone = false
  private ended = false
  private failed: { unit: SpeechUnit | null } | null = null
  private taking = false
  /** A rewind deferred until the in-flight take settles; that take's result is then dropped. */
  private pendingRewind: SpeechUnit | null = null
  private scheduling = false
  private wake: () => void = () => {}
  private ticker: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: PlayerDeps) {
    this.ctx = deps.context
    this.prefetch = deps.prefetch ?? 2
    this.pauseMs = deps.pauseMs ?? { sentence: 350, block: 700 }
  }

  start(): void {
    if (this.stopped) return
    if (this.failed) {
      const unit = this.failed.unit
      this.failed = null
      if (unit) this.rewindTo(unit)
    } else if (this.running) return
    this.running = true
    this.ended = false
    this.ensureTicker()
    void this.fill()
  }

  pause(): Promise<void> {
    return this.ctx.suspend()
  }

  resume(): Promise<void> {
    return this.ctx.resume()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.running = false
    this.clearTicker()
    for (const item of this.items) this.silence(item)
    this.items = []
    this.wake()
    await this.ctx.close()
  }

  skip(delta: -1 | 1): void {
    if (this.stopped || !this.running) return
    this.tick()
    const sounding = this.current
    if (!sounding) return
    const at = this.blockTaken.indexOf(sounding)
    let target: SpeechUnit | null
    if (delta === 1) target = this.items.find((i) => !i.announced)?.unit ?? null
    else if (at > 0) target = this.blockTaken[at - 1] ?? null
    else if (at === 0) target = sounding
    else return // the source has moved past the sounding block; it cannot go back across it (Facts 1)
    this.discard(true)
    if (target) this.rewindTo(target)
    void this.fill()
  }

  restartAt(unit: SpeechUnit | null): void {
    if (this.stopped) return
    this.running = true
    this.failed = null
    this.ensureTicker()
    this.discard(true)
    this.blockTaken = []
    this.newBlockNext = false
    if (unit) this.rewindTo(unit)
    void this.fill()
  }

  specChanged(): void {
    if (this.stopped || !this.running) return
    this.tick()
    const first = this.items.find((i) => !i.announced)
    this.discard(false)
    if (first) this.rewindTo(first.unit)
    void this.fill()
  }

  // ------------------------------------------------------------ the queue

  private unstarted(): number {
    return this.items.filter((i) => !i.announced).length
  }

  /** The last taken unit ends its block and has not started: the next block must wait (Facts 1). */
  private gated(): boolean {
    const last = this.items.at(-1)
    return !!last && last.unit.blockEnd && !last.announced
  }

  private async fill(): Promise<void> {
    if (this.taking) return
    this.taking = true
    try {
      while (!this.stopped && this.running) {
        if (this.failed || this.sourceDone || this.gated()) return
        if (this.unstarted() >= this.prefetch) return
        let unit: SpeechUnit | null
        try {
          unit = await this.deps.source.take()
        } catch (e) {
          if (this.stopped) return
          this.fail(null, e)
          return
        }
        if (this.stopped) return
        if (this.pendingRewind) {
          const target = this.pendingRewind
          this.pendingRewind = null
          this.applyRewind(target)
          continue
        }
        if (this.failed) return
        if (unit === null) {
          this.sourceDone = true
          this.checkEnd()
          return
        }
        this.accept(unit)
      }
    } finally {
      this.taking = false
    }
  }

  private accept(unit: SpeechUnit): void {
    if (this.newBlockNext) this.blockTaken = []
    this.blockTaken.push(unit)
    this.newBlockNext = unit.blockEnd
    const { voice, speed } = this.deps.spec()
    const audio = this.deps.synthesize({ text: unit.text, voice, speed })
    audio.catch(() => {}) // a rejection is reported when it reaches the head, once
    this.items.push({
      unit,
      audio,
      scheduled: false,
      announced: false,
      node: null,
      start: 0,
      tailBefore: null,
      blockEndBefore: false
    })
    void this.schedule()
  }

  /** Rewind now, or — if a take is in flight — once it settles, dropping what it brings. */
  private rewindTo(unit: SpeechUnit): void {
    this.sourceDone = false
    if (this.taking) {
      this.pendingRewind = unit
    } else this.applyRewind(unit)
  }

  private applyRewind(unit: SpeechUnit): void {
    const at = this.blockTaken.indexOf(unit)
    if (at >= 0) this.blockTaken = this.blockTaken.slice(0, at)
    this.newBlockNext = false
    this.deps.source.rewind(unit)
  }

  /** Stop and drop every unstarted item (and, if `cut`, the sounding one too). */
  private discard(cut: boolean): void {
    const keep = cut ? [] : this.items.filter((i) => i.announced)
    const firstDropped = this.items.find((i) => !keep.includes(i))
    for (const item of this.items) if (!keep.includes(item)) this.silence(item)
    if (cut) {
      this.tailEnd = null
      this.prevBlockEnd = false
    } else if (firstDropped?.scheduled) {
      this.tailEnd = firstDropped.tailBefore
      this.prevBlockEnd = firstDropped.blockEndBefore
    }
    this.items = keep
    this.ended = false
    this.wake()
  }

  private silence(item: Item): void {
    if (!item.node) return
    item.node.onended = null
    try {
      item.node.stop()
    } catch {
      // already stopped
    }
  }

  // ------------------------------------------------------------ the clock

  private async schedule(): Promise<void> {
    if (this.scheduling) return
    this.scheduling = true
    try {
      for (;;) {
        if (this.stopped || this.failed) return
        const item = this.items.find((i) => !i.scheduled)
        if (!item) return
        const woken = new Promise<'woken'>((res) => (this.wake = () => res('woken')))
        let audio: TtsAudio | 'woken'
        try {
          audio = await Promise.race([item.audio, woken])
        } catch (e) {
          if (this.stopped || !this.items.includes(item)) continue
          this.fail(item.unit, e)
          return
        }
        if (audio === 'woken' || this.stopped || !this.items.includes(item)) continue
        this.place(item, audio)
      }
    } finally {
      this.scheduling = false
    }
  }

  private place(item: Item, audio: TtsAudio): void {
    const now = this.ctx.currentTime
    item.scheduled = true
    item.tailBefore = this.tailEnd
    item.blockEndBefore = this.prevBlockEnd
    const silent = audio.samples.byteLength < 2 || audio.durationMs === 0
    if (silent) {
      // no buffer and no pause: it starts (and ends) at the tail, and the next unit follows the tail
      item.start = Math.max(now, this.tailEnd ?? now)
      this.prevBlockEnd = this.prevBlockEnd || item.unit.blockEnd
    } else {
      const samples = pcmToFloat32(audio.samples)
      const buffer = this.ctx.createBuffer(1, samples.length, audio.sampleRate)
      buffer.getChannelData(0).set(samples)
      const pause = (this.prevBlockEnd ? this.pauseMs.block : this.pauseMs.sentence) / 1000
      item.start = this.tailEnd === null ? now : Math.max(now, this.tailEnd + pause)
      const node = this.ctx.createBufferSource()
      node.buffer = buffer
      node.connect(this.ctx.destination)
      node.onended = () => this.onNodeEnded(item)
      node.start(item.start)
      item.node = node
      this.tailEnd = item.start + samples.length / audio.sampleRate
      this.prevBlockEnd = item.unit.blockEnd
    }
    this.tick()
  }

  private onNodeEnded(item: Item): void {
    if (this.stopped) return
    this.tick() // a throttled interval may not have announced it yet
    this.items = this.items.filter((i) => i !== item)
    this.checkEnd()
  }

  /** Announce every scheduled item the clock has reached, in order; then refill. */
  private tick(): void {
    if (this.stopped) return
    const now = this.ctx.currentTime
    let announced = false
    for (const item of this.items) {
      if (item.announced) continue
      if (!item.scheduled || item.start > now + 1e-9) break
      item.announced = true
      announced = true
      this.current = item.unit
      this.deps.source.started(item.unit)
      this.deps.onUnitStart(item.unit)
    }
    if (!announced) return
    this.items = this.items.filter((i) => i.node !== null || !i.announced) // silence is done once started
    this.checkEnd()
    void this.fill()
  }

  private checkEnd(): void {
    if (this.ended || !this.sourceDone || this.items.length > 0 || this.failed) return
    this.ended = true
    this.running = false
    this.clearTicker()
    this.deps.onEnd()
  }

  private fail(unit: SpeechUnit | null, e: unknown): void {
    const at = unit ? this.items.findIndex((i) => i.unit === unit) : -1
    if (at >= 0) {
      const dropped = this.items.slice(at)
      for (const item of dropped) this.silence(item)
      this.items = this.items.slice(0, at)
    }
    this.failed = { unit }
    this.wake()
    this.deps.onError(e instanceof Error ? e.message : String(e))
  }

  private ensureTicker(): void {
    if (!this.ticker) this.ticker = setInterval(() => this.tick(), TICK_MS)
  }

  private clearTicker(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
  }
}
