import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TtsAudio, TtsRequest, TtsVoice } from '@shared/tts.types'
import type { SpeechUnit } from './speech-queue'
import {
  SentenceCache,
  SpeechPlayer,
  pcmToFloat32,
  type AudioBufferLike,
  type AudioContextLike,
  type AudioSourceLike,
  type PlayerSource,
  type PlayerSpec
} from './speech-player'

const RATE = 24000

// ---------------------------------------------------------------- fakes

class FakeBuffer implements AudioBufferLike {
  readonly data: Float32Array
  constructor(
    readonly length: number,
    readonly sampleRate: number
  ) {
    this.data = new Float32Array(length)
  }
  get duration(): number {
    return this.length / this.sampleRate
  }
  getChannelData(): Float32Array {
    return this.data
  }
}

class FakeSource implements AudioSourceLike {
  buffer: FakeBuffer | null = null
  onended: ((ev: Event) => unknown) | null = null
  when: number | null = null
  stopped = false
  ended = false
  connect(): void {}
  start(when = 0): void {
    this.when = when
  }
  stop(): void {
    this.stopped = true
  }
  /** The unit's mark, encoded in the first sample by `pcm()`. */
  get mark(): string {
    return String(Math.round((this.buffer?.data[0] ?? 0) * 32768))
  }
  get end(): number {
    return (this.when ?? 0) + (this.buffer?.duration ?? 0)
  }
}

class FakeContext implements AudioContextLike {
  nowMs = 0
  suspended = false
  readonly destination = {}
  readonly sources: FakeSource[] = []
  readonly suspend = vi.fn(async () => {
    this.suspended = true
  })
  readonly resume = vi.fn(async () => {
    this.suspended = false
  })
  readonly close = vi.fn(async () => {})
  get currentTime(): number {
    return this.nowMs / 1000
  }
  createBuffer(_channels: number, length: number, sampleRate: number): FakeBuffer {
    return new FakeBuffer(length, sampleRate)
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource()
    this.sources.push(s)
    return s
  }
  started(): FakeSource[] {
    return this.sources.filter((s) => s.when !== null)
  }
  /** Fire `ended` for every buffer the clock has run past, as Web Audio does. */
  fireEnded(): void {
    for (const s of this.sources) {
      if (s.when === null || s.stopped || s.ended) continue
      if (s.end <= this.currentTime + 1e-9) {
        s.ended = true
        s.onended?.(new Event('ended'))
      }
    }
  }
}

class ArraySource implements PlayerSource {
  i = 0
  readonly log: string[] = []
  constructor(readonly units: SpeechUnit[]) {}
  readonly take = vi.fn(async (): Promise<SpeechUnit | null> => {
    const u = this.units[this.i++] ?? null
    this.log.push(`take:${u ? u.mark : 'null'}`)
    return u
  })
  readonly started = vi.fn((u: SpeechUnit): void => {
    this.log.push(`started:${u.mark}`)
  })
  readonly rewind = vi.fn((u: SpeechUnit): void => {
    const k = this.units.findIndex((x) => x.mark === u.mark)
    if (k < 0) throw new Error(`rewind to unknown unit ${u.mark}`)
    this.log.push(`rewind:${u.mark}`)
    this.i = k
  })
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(v: T): void
  reject(e: unknown): void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ---------------------------------------------------------------- helpers

const u = (mark: number, blockEnd = false): SpeechUnit => ({
  mark: String(mark),
  text: `Sentence ${mark}.`,
  blockEnd
})

/** `seconds` of mono Int16 LE PCM whose first sample carries `tag`, so a buffer names its unit. */
function pcm(seconds: number, tag: number): TtsAudio {
  const n = Math.round(seconds * RATE)
  const samples = new Uint8Array(n * 2)
  new DataView(samples.buffer).setInt16(0, tag, true)
  return { sampleRate: RATE, samples, durationMs: seconds * 1000, lexiconVersion: 'l' }
}
const SILENCE: TtsAudio = {
  sampleRate: RATE,
  samples: new Uint8Array(0),
  durationMs: 0,
  lexiconVersion: 'l'
}
const tagOf = (r: TtsRequest): number => Number(/(\d+)/.exec(r.text)?.[1] ?? -1)

/** Synthesis that answers 1.0 s of audio for every sentence, after `latencyMs` on the (fake) clock. */
function latencySynth(latencyMs: number, seconds = 1) {
  return vi.fn(
    (r: TtsRequest): Promise<TtsAudio> =>
      new Promise((res) => {
        if (latencyMs === 0) res(pcm(seconds, tagOf(r)))
        else setTimeout(() => res(pcm(seconds, tagOf(r))), latencyMs)
      })
  )
}

/** Synthesis the test answers by hand. */
function manualSynth() {
  const calls: { request: TtsRequest; d: Deferred<TtsAudio> }[] = []
  const fn = vi.fn((request: TtsRequest): Promise<TtsAudio> => {
    const d = deferred<TtsAudio>()
    calls.push({ request, d })
    return d.promise
  })
  return { fn, calls }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

interface Rig {
  ctx: FakeContext
  source: ArraySource
  player: SpeechPlayer
  spec: PlayerSpec
  starts: { mark: string; t: number }[]
  onEnd: ReturnType<typeof vi.fn>
  onError: ReturnType<typeof vi.fn>
  /** Step the audio clock and the timers together, 10 ms at a time. */
  advance(ms: number): Promise<void>
}

function rig(
  units: SpeechUnit[],
  synthesize: (r: TtsRequest) => Promise<TtsAudio>,
  prefetch?: number
): Rig {
  const ctx = new FakeContext()
  const source = new ArraySource(units)
  const spec: PlayerSpec = { voice: 'af_heart', speed: 1 }
  const starts: { mark: string; t: number }[] = []
  const onEnd = vi.fn()
  const onError = vi.fn()
  const player = new SpeechPlayer({
    context: ctx,
    synthesize,
    source,
    spec: () => spec,
    onUnitStart: (unit) => starts.push({ mark: unit.mark, t: ctx.currentTime }),
    onEnd,
    onError,
    ...(prefetch === undefined ? {} : { prefetch })
  })
  const advance = async (ms: number): Promise<void> => {
    for (let t = 0; t < ms; t += 10) {
      if (!ctx.suspended) ctx.nowMs += 10
      ctx.fireEnded()
      await vi.advanceTimersByTimeAsync(10)
      await flush()
    }
  }
  return { ctx, source, player, spec, starts, onEnd, onError, advance }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------- the player

describe('SpeechPlayer', () => {
  it('takes a real AudioContext', () => {
    const fits: AudioContext extends AudioContextLike ? true : false = true
    expect(fits).toBe(true)
  })

  it('plays gaplessly: with 500 ms synthesis latency the gap after each sentence is exactly 350 ms (AC13)', async () => {
    const r = rig([u(0), u(1), u(2, true)], latencySynth(500), 2)
    r.player.start()
    await flush()
    await r.advance(5000)

    const played = r.ctx.started()
    expect(played.map((s) => s.mark)).toEqual(['0', '1', '2'])
    for (const s of played) expect(s.buffer?.duration).toBe(1)
    expect(played[0]?.when).toBeCloseTo(0.5, 9)
    for (let n = 0; n + 1 < played.length; n++) {
      const gap = (played[n + 1]?.when ?? NaN) - (played[n]?.end ?? NaN)
      expect(gap).toBeCloseTo(0.35, 9)
    }
  })

  it('pauses 700 ms after a block, 350 ms within one', async () => {
    const r = rig([u(0), u(1, true), u(2, true)], latencySynth(0))
    r.player.start()
    await flush()
    await r.advance(5000)

    const [a, b, c] = r.ctx.started()
    expect([a?.mark, b?.mark, c?.mark]).toEqual(['0', '1', '2'])
    expect((b?.when ?? NaN) - (a?.end ?? NaN)).toBeCloseTo(0.35, 9)
    expect((c?.when ?? NaN) - (b?.end ?? NaN)).toBeCloseTo(0.7, 9)
  })

  it('keeps at most `prefetch` requests in flight beyond the sounding sentence', async () => {
    const units = Array.from({ length: 10 }, (_, i) => u(i, i === 9))
    const synth = manualSynth()
    const r = rig(units, synth.fn, 2)
    r.player.start()
    await flush()
    expect(synth.calls.map((c) => c.request.text)).toEqual(['Sentence 0.', 'Sentence 1.'])

    synth.calls[0]?.d.resolve(pcm(1, 0))
    await r.advance(10)
    expect(r.starts.map((s) => s.mark)).toEqual(['0'])
    // sentence 0 sounds; 1 and 2 are the two in flight
    expect(synth.calls).toHaveLength(3)

    await r.advance(500)
    expect(synth.calls).toHaveLength(3)

    // 1 arrives and is scheduled, but has not started: still two unstarted, no new request
    synth.calls[1]?.d.resolve(pcm(1, 1))
    await r.advance(10)
    expect(r.ctx.started().map((s) => s.mark)).toEqual(['0', '1'])
    expect(synth.calls).toHaveLength(3)

    // 1 starts at 1.35 s: now the third is requested
    await r.advance(900)
    expect(r.starts.map((s) => s.mark)).toEqual(['0', '1'])
    expect(synth.calls).toHaveLength(4)
    expect(synth.calls[3]?.request.text).toBe('Sentence 3.')
  })

  it('does not take the next block until the last unit of this one has started (Facts 1)', async () => {
    const r = rig([u(0), u(1), u(2, true), u(3), u(4, true)], latencySynth(0), 2)
    r.player.start()
    await flush()
    await r.advance(10)
    expect(r.source.log.filter((l) => l.startsWith('take'))).toEqual(['take:0', 'take:1', 'take:2'])

    // 1 sounds from 1.35 s, 2 is the only unstarted unit (fewer than prefetch), and still no take of 3
    await r.advance(2600)
    expect(r.starts.map((s) => s.mark)).toEqual(['0', '1'])
    expect(r.source.take).toHaveBeenCalledTimes(3)

    // 2 starts at 2.70 s: started(2) first, then the next block is taken
    await r.advance(200)
    expect(r.starts.map((s) => s.mark)).toEqual(['0', '1', '2'])
    const log = r.source.log
    expect(log.indexOf('take:3')).toBeGreaterThan(log.indexOf('started:2'))
    expect(log).toContain('take:3')
  })

  it('with the highlight timer starved (a hidden window, AC20) the audio clock alone keeps it going', async () => {
    const r = rig([u(0), u(1, true), u(2, true)], latencySynth(0))
    r.player.start()
    await flush()
    // advance only the audio clock: no interval tick ever fires
    for (let t = 0; t < 2400; t += 10) {
      r.ctx.nowMs += 10
      r.ctx.fireEnded()
      await flush()
    }
    // 1 ended at 2.35 s; its `ended` announced it, releasing the next block
    expect(r.source.started).toHaveBeenCalledWith(u(1, true))
    expect(r.source.log.indexOf('take:2')).toBeGreaterThan(r.source.log.indexOf('started:1'))
    const two = r.ctx.started().find((s) => s.mark === '2')
    expect(two?.when).toBeCloseTo(2.35 + 0.7, 9)
  })

  it('pause is suspend and resume is resume, with no re-synthesis between them (AC14)', async () => {
    const synth = latencySynth(0)
    const r = rig([u(0), u(1), u(2), u(3, true)], synth)
    r.player.start()
    await flush()
    await r.advance(500) // 0 sounds; 1 and 2 are scheduled
    const synthBefore = synth.mock.calls.length
    const sourcesBefore = r.ctx.sources.length
    expect(r.starts.map((s) => s.mark)).toEqual(['0'])

    await r.player.pause()
    expect(r.ctx.suspend).toHaveBeenCalledTimes(1)
    await r.advance(3000) // the audio clock is frozen: the highlight does not advance
    expect(r.starts.map((s) => s.mark)).toEqual(['0'])

    await r.player.resume()
    expect(r.ctx.resume).toHaveBeenCalledTimes(1)
    await flush()
    expect(synth.mock.calls.length).toBe(synthBefore)
    expect(r.ctx.sources.length).toBe(sourcesBefore)
    // and it carries on from the same place on the clock
    await r.advance(1000)
    expect(r.starts.map((s) => s.mark)).toEqual(['0', '1'])
  })

  it('skip(1) cuts the sounding sentence and plays the next at once; skip(-1) the one before', async () => {
    const synth = latencySynth(0)
    const r = rig([u(0), u(1), u(2), u(3), u(4), u(5, true)], synth)
    r.player.start()
    await flush()
    await r.advance(1500) // 1 sounds (from 1.35 s); 2 and 3 are queued
    expect(r.starts.map((s) => s.mark)).toEqual(['0', '1'])
    const sounding = r.ctx.started().find((s) => s.mark === '1')
    const queued = r.ctx.started().filter((s) => s.mark === '2')
    expect(queued).toHaveLength(1)

    const before = synth.mock.calls.length
    r.player.skip(1)
    await flush()
    expect(sounding?.stopped).toBe(true)
    expect(queued[0]?.stopped).toBe(true)
    expect(r.source.rewind).toHaveBeenLastCalledWith(u(2))
    expect(synth.mock.calls[before]?.[0].text).toBe('Sentence 2.')
    const next = r.ctx.started().filter((s) => !s.stopped && !s.ended)[0]
    expect(next?.mark).toBe('2')
    expect(next?.when).toBeCloseTo(1.5, 9)
    expect(r.starts.at(-1)).toEqual({ mark: '2', t: 1.5 })

    await r.advance(200)
    const beforeBack = synth.mock.calls.length
    r.player.skip(-1)
    await flush()
    expect(r.source.rewind).toHaveBeenLastCalledWith(u(1))
    expect(synth.mock.calls[beforeBack]?.[0].text).toBe('Sentence 1.')
    const back = r.ctx.started().filter((s) => !s.stopped && !s.ended)[0]
    expect(back?.mark).toBe('1')
    expect(back?.when).toBeCloseTo(1.7, 9)
    expect(r.starts.at(-1)).toEqual({ mark: '1', t: 1.7 })
  })

  it('a voice change re-requests the queued sentences in the new voice, not the sounding one (AC14)', async () => {
    const synth = latencySynth(0)
    const r = rig([u(0), u(1), u(2), u(3, true)], synth)
    r.player.start()
    await flush()
    await r.advance(500) // 0 sounds; 1 and 2 queued (1 scheduled at 1.35)
    const before = synth.mock.calls.length
    const oldOne = r.ctx.started().find((s) => s.mark === '1')

    r.spec.voice = 'bm_george' satisfies TtsVoice
    r.player.specChanged()
    await flush()

    const after = synth.mock.calls.slice(before).map((c) => c[0])
    expect(after.map((q) => [q.text, q.voice])).toEqual([
      ['Sentence 1.', 'bm_george'],
      ['Sentence 2.', 'bm_george']
    ])
    expect(r.source.rewind).toHaveBeenLastCalledWith(u(1))
    expect(oldOne?.stopped).toBe(true)
    const zero = r.ctx.started().find((s) => s.mark === '0')
    expect(zero?.stopped).toBe(false)
    // the new 1 keeps its place on the clock
    const newOne = r.ctx.started().filter((s) => s.mark === '1' && !s.stopped)
    expect(newOne).toHaveLength(1)
    expect(newOne[0]?.when).toBeCloseTo(1.35, 9)
  })

  it('silence schedules nothing and adds no pause (Review Focus 3)', async () => {
    const synth = vi.fn(async (r: TtsRequest): Promise<TtsAudio> =>
      tagOf(r) === 1 ? SILENCE : pcm(1, tagOf(r))
    )
    const r = rig([u(0), u(1), u(2, true)], synth)
    r.player.start()
    await flush()
    await r.advance(3000)

    const played = r.ctx.started()
    expect(played.map((s) => s.mark)).toEqual(['0', '2'])
    expect(r.ctx.sources).toHaveLength(2)
    expect((played[1]?.when ?? NaN) - (played[0]?.end ?? NaN)).toBeCloseTo(0.35, 9)
    // the silent unit still counts as started, so a source gated on it is released
    expect(r.source.started).toHaveBeenCalledWith(u(1))
  })

  it('a failed synthesis reports once, schedules nothing more, and start() retries it (Review Focus 4)', async () => {
    const synth = manualSynth()
    const r = rig([u(0), u(1), u(2), u(3, true)], synth.fn)
    r.player.start()
    await flush()
    synth.calls[0]?.d.resolve(pcm(1, 0))
    await r.advance(10)
    expect(synth.calls).toHaveLength(3) // 0 sounding, 1 and 2 in flight

    synth.calls[1]?.d.reject(new Error('The voice engine stopped.'))
    await flush()
    synth.calls[2]?.d.resolve(pcm(1, 2))
    await r.advance(2000)

    expect(r.onError).toHaveBeenCalledTimes(1)
    expect(r.onError).toHaveBeenCalledWith('The voice engine stopped.')
    expect(r.ctx.sources.map((s) => s.mark)).toEqual(['0'])
    expect(synth.calls).toHaveLength(3)
    expect(r.ctx.close).not.toHaveBeenCalled()
    expect(r.onEnd).not.toHaveBeenCalled()

    r.player.start()
    await flush()
    expect(r.source.rewind).toHaveBeenLastCalledWith(u(1))
    expect(synth.calls[3]?.request.text).toBe('Sentence 1.')
    synth.calls[3]?.d.resolve(pcm(1, 1))
    await flush()
    const retried = r.ctx.sources.at(-1)
    expect(retried?.mark).toBe('1')
    expect(retried?.when).toBeCloseTo(2.01, 9)
    expect(r.onError).toHaveBeenCalledTimes(1)
  })

  it('ends after the last buffer ends, not when the source runs dry', async () => {
    const r = rig([u(0), u(1, true)], latencySynth(0))
    r.player.start()
    await flush()
    await r.advance(1400) // 1 (the block's last) has started, so the source was asked again
    expect(r.source.log).toContain('take:null')
    expect(r.onEnd).not.toHaveBeenCalled()

    await r.advance(940) // 2.34 s: 1 ends at 2.35 s
    expect(r.onEnd).not.toHaveBeenCalled()
    await r.advance(20)
    expect(r.onEnd).toHaveBeenCalledTimes(1)
  })

  it('restartAt (a page turn) drops the old queue, mid-flight synthesis included, and plays from the new unit (Review Focus 1)', async () => {
    const synth = manualSynth()
    const r = rig([u(0), u(1), u(2), u(3), u(4), u(5, true)], synth.fn)
    r.player.start()
    await flush()
    synth.calls[0]?.d.resolve(pcm(1, 0))
    await r.advance(300) // 0 sounds; 1 and 2 are in flight
    const zero = r.ctx.sources[0]
    expect(synth.calls.map((c) => c.request.text)).toEqual([
      'Sentence 0.',
      'Sentence 1.',
      'Sentence 2.'
    ])

    r.player.restartAt(u(4))
    await flush()
    expect(zero?.stopped).toBe(true)
    expect(r.source.rewind).toHaveBeenLastCalledWith(u(4))
    expect(synth.calls.slice(3).map((c) => c.request.text)).toEqual(['Sentence 4.', 'Sentence 5.'])

    // the old page's sentences arrive late and are not spoken
    synth.calls[1]?.d.resolve(pcm(1, 1))
    synth.calls[2]?.d.resolve(pcm(1, 2))
    synth.calls[3]?.d.resolve(pcm(1, 4))
    await flush()
    expect(r.ctx.sources.map((s) => s.mark)).toEqual(['0', '4'])
    expect(r.ctx.sources[1]?.when).toBeCloseTo(0.3, 9) // at once, on the restart
    expect(r.starts.map((s) => s.mark)).toEqual(['0', '4'])
  })

  it('stop() stops every started source, closes the context, and ignores late synthesis', async () => {
    const synth = manualSynth()
    const r = rig([u(0), u(1), u(2), u(3, true)], synth.fn)
    r.player.start()
    await flush()
    synth.calls[0]?.d.resolve(pcm(1, 0))
    synth.calls[1]?.d.resolve(pcm(1, 1))
    await r.advance(10)
    expect(r.ctx.started()).toHaveLength(2)
    expect(synth.calls).toHaveLength(3)

    await r.player.stop()
    expect(r.ctx.started().every((s) => s.stopped)).toBe(true)
    expect(r.ctx.close).toHaveBeenCalledTimes(1)

    const announced = r.starts.length
    synth.calls[2]?.d.resolve(pcm(1, 2))
    await r.advance(3000)
    expect(r.ctx.sources).toHaveLength(2)
    expect(r.starts).toHaveLength(announced)
    expect(synth.calls).toHaveLength(3)
    expect(r.onEnd).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------- the cache and the conversion

describe('SentenceCache', () => {
  const req = (text: string, voice: TtsVoice = 'af_heart', speed = 1): TtsRequest => ({
    text,
    voice,
    speed
  })

  it('serves a repeat from the cache and a different voice from the engine', async () => {
    const inner = vi.fn(async (r: TtsRequest) => pcm(1, tagOf(r)))
    const synth = new SentenceCache().wrap(inner)
    const [a, b] = await Promise.all([synth(req('One 1.')), synth(req('One 1.'))])
    expect(a).toBe(b)
    expect(inner).toHaveBeenCalledTimes(1)
    await synth(req('One 1.', 'bf_emma'))
    expect(inner).toHaveBeenCalledTimes(2)
    await synth(req('One 1.', 'af_heart', 1.2))
    expect(inner).toHaveBeenCalledTimes(3)
  })

  it('evicts the oldest beyond 50 entries', async () => {
    const inner = vi.fn(async (r: TtsRequest) => pcm(0.01, tagOf(r)))
    const synth = new SentenceCache().wrap(inner)
    for (let i = 0; i <= 50; i++) await synth(req(`S ${i}`))
    expect(inner).toHaveBeenCalledTimes(51)
    await synth(req('S 50'))
    expect(inner).toHaveBeenCalledTimes(51)
    await synth(req('S 0'))
    expect(inner).toHaveBeenCalledTimes(52)
  })

  it('does not keep a rejected request', async () => {
    const inner = vi
      .fn<(r: TtsRequest) => Promise<TtsAudio>>()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(pcm(1, 7))
    const synth = new SentenceCache().wrap(inner)
    await expect(synth(req('Seven 7.'))).rejects.toThrow('timeout')
    await expect(synth(req('Seven 7.'))).resolves.toMatchObject({ sampleRate: RATE })
    expect(inner).toHaveBeenCalledTimes(2)
  })
})

describe('pcmToFloat32', () => {
  it('reads signed 16-bit little-endian samples into [-1, 1)', () => {
    const out = pcmToFloat32(new Uint8Array([0x00, 0x40, 0x00, 0xc0]))
    expect(out).toHaveLength(2)
    expect(Math.abs((out[0] ?? NaN) - 0.5)).toBeLessThanOrEqual(1 / 32768)
    expect(Math.abs((out[1] ?? NaN) + 0.5)).toBeLessThanOrEqual(1 / 32768)
  })

  it('honours a view that starts at an odd offset', () => {
    const backing = new Uint8Array([0xff, 0x00, 0x40, 0x00, 0xc0])
    const out = pcmToFloat32(backing.subarray(1))
    expect(Array.from(out)).toEqual([0.5, -0.5])
  })
})
