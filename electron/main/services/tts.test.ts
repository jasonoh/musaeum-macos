import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { join } from 'path'
import * as events from './events'
import * as sidecar from './sidecar'
import {
  MAX_TEXT_CHARS,
  SYNTH_TIMEOUT_MS,
  cancelDownload,
  downloadModel,
  modelDir,
  resetForTests,
  status,
  synthesize
} from './tts'

/** Whole-module mocks, as `reflow.test.ts` does: `assertAvailable` would otherwise start a live Python. */
vi.mock('./sidecar', () => ({
  assertAvailable: vi.fn(),
  call: vi.fn(),
  onNotification: vi.fn(() => () => {})
}))
vi.mock('./events', () => ({ broadcast: vi.fn() }))

const call = vi.mocked(sidecar.call)

beforeEach(() => {
  resetForTests()
  call.mockReset()
  vi.mocked(sidecar.assertAvailable).mockReset()
  vi.mocked(sidecar.onNotification).mockClear()
  vi.mocked(events.broadcast).mockClear()
})

function pcm(...samples: number[]): string {
  const b = Buffer.alloc(samples.length * 2)
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2))
  return b.toString('base64')
}

describe('synthesize', () => {
  it('sends the model directory, voice, speed and an empty lexicon, and maps the answer to camelCase', async () => {
    call.mockResolvedValue({
      sample_rate: 24000,
      pcm: pcm(1000, -1000, 32767),
      duration_ms: 42,
      lexicon_version: 'abc123'
    } as never)
    const audio = await synthesize({ text: ' Hello there. ', voice: 'bf_emma', speed: 1.2 })
    expect(call).toHaveBeenCalledWith(
      'tts_synthesize',
      {
        model_dir: join(app.getPath('userData'), 'tts-models'),
        text: 'Hello there.',
        voice: 'bf_emma',
        speed: 1.2,
        lexicon: []
      },
      SYNTH_TIMEOUT_MS
    )
    expect(audio.sampleRate).toBe(24000)
    expect(audio.durationMs).toBe(42)
    expect(audio.lexiconVersion).toBe('abc123')
    expect(Array.from(new Int16Array(audio.samples.buffer, audio.samples.byteOffset, 3))).toEqual([1000, -1000, 32767])
  })

  it('treats an empty pcm as silence, not an error', async () => {
    call.mockResolvedValue({ sample_rate: 24000, pcm: '', duration_ms: 0, lexicon_version: 'x' } as never)
    const audio = await synthesize({ text: '†', voice: 'af_heart', speed: 1 })
    expect(audio.samples.byteLength).toBe(0)
    expect(audio.durationMs).toBe(0)
  })

  it('surfaces the sidecar\'s refusal as the rejection message', async () => {
    call.mockResolvedValue({ error: 'The voice is not downloaded yet' } as never)
    await expect(synthesize({ text: 'Hi', voice: 'af_heart', speed: 1 })).rejects.toThrow(
      'The voice is not downloaded yet'
    )
  })

  it('clamps the speed before it reaches the sidecar', async () => {
    call.mockResolvedValue({ sample_rate: 24000, pcm: '', duration_ms: 0, lexicon_version: '' } as never)
    await synthesize({ text: 'Hi', voice: 'af_heart', speed: 9 })
    expect(call.mock.calls[0]?.[1]).toMatchObject({ speed: 1.5 })
  })

  it('refuses an unknown voice, empty text and oversize text without calling the sidecar', async () => {
    await expect(synthesize({ text: 'Hi', voice: 'af_sky' as never, speed: 1 })).rejects.toThrow(/voice/i)
    await expect(synthesize({ text: '   ', voice: 'af_heart', speed: 1 })).rejects.toThrow(/nothing to speak/i)
    await expect(
      synthesize({ text: 'a'.repeat(MAX_TEXT_CHARS + 1), voice: 'af_heart', speed: 1 })
    ).rejects.toThrow(/too long/i)
    expect(call).not.toHaveBeenCalled()
  })

  it('rejects, rather than starting nothing, when the metadata engine is unavailable', async () => {
    vi.mocked(sidecar.assertAvailable).mockImplementation(() => {
      throw new Error('Python sidecar is unavailable')
    })
    await expect(synthesize({ text: 'Hi', voice: 'af_heart', speed: 1 })).rejects.toThrow('unavailable')
  })
})

describe('status', () => {
  it('maps the sidecar answer', async () => {
    call.mockResolvedValue({ ready: false, missing: ['voices-v1.0.bin'], total_bytes: 120575669 } as never)
    expect(await status()).toEqual({ ready: false, missing: ['voices-v1.0.bin'], totalBytes: 120575669 })
    expect(call).toHaveBeenCalledWith('tts_model_status', { model_dir: modelDir() })
  })
})

describe('the download', () => {
  it('rebroadcasts the sidecar\'s progress frames in the app\'s spelling', async () => {
    call.mockResolvedValue({ status: 'ready' } as never)
    await downloadModel()
    const handler = vi.mocked(sidecar.onNotification).mock.calls.find((c) => c[0] === 'tts_model_progress')?.[1]
    expect(handler).toBeTypeOf('function')
    handler?.({ job_id: 'j', file: 'a.bin', completed: 5, total: 10 })
    expect(events.broadcast).toHaveBeenCalledWith('ttsModelProgress', {
      jobId: 'j',
      file: 'a.bin',
      completed: 5,
      total: 10
    })
  })

  it('ignores a malformed frame', async () => {
    call.mockResolvedValue({ status: 'ready' } as never)
    await downloadModel()
    const handler = vi.mocked(sidecar.onNotification).mock.calls.find((c) => c[0] === 'tts_model_progress')?.[1]
    handler?.({ file: 'a.bin' })
    handler?.(null)
    expect(events.broadcast).not.toHaveBeenCalled()
  })

  it('runs one download at a time: a second call shares the first', async () => {
    let finish: (v: unknown) => void = () => {}
    call.mockImplementation(() => new Promise((r) => (finish = r)) as never)
    const a = downloadModel()
    const b = downloadModel()
    expect(call).toHaveBeenCalledTimes(1)
    finish({ status: 'ready' })
    expect(await a).toEqual({ status: 'ready' })
    expect(await b).toEqual({ status: 'ready' })
  })

  it('cancels the running job by id, and is a no-op with none running', async () => {
    await cancelDownload()
    expect(call).not.toHaveBeenCalled()

    let finish: (v: unknown) => void = () => {}
    call.mockImplementation(((method: string) =>
      method === 'tts_download_model' ? new Promise((r) => (finish = r)) : Promise.resolve({ cancelled: true })) as never)
    const running = downloadModel()
    const jobId = (call.mock.calls[0]?.[1] as { job_id: string }).job_id
    await cancelDownload()
    expect(call).toHaveBeenCalledWith('tts_cancel_download', { job_id: jobId })
    finish({ status: 'cancelled' })
    expect(await running).toEqual({ status: 'cancelled' })
  })

  it('reports a failed download as a result, not a rejection', async () => {
    call.mockResolvedValue({ status: 'failed', error: 'offline' } as never)
    expect(await downloadModel()).toEqual({ status: 'failed', error: 'offline' })
  })

  it('allows a new download after the last one settled', async () => {
    call.mockResolvedValue({ status: 'ready' } as never)
    await downloadModel()
    await downloadModel()
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('cancels the sidecar job when its call rejects, and a later download starts a fresh job', async () => {
    call.mockRejectedValueOnce(new Error('timed out'))
    await expect(downloadModel()).rejects.toThrow('timed out')
    await Promise.resolve()
    const first = call.mock.calls[0]?.[1] as { job_id: string }
    expect(call).toHaveBeenCalledWith('tts_cancel_download', { job_id: first.job_id })
    call.mockResolvedValue({ status: 'ready' } as never)
    await downloadModel()
    const starts = call.mock.calls.filter((c) => c[0] === 'tts_download_model')
    expect(starts).toHaveLength(2)
    expect((starts[1]?.[1] as { job_id: string }).job_id).not.toBe(first.job_id)
  })
})
