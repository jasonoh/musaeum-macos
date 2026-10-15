import { randomUUID } from 'crypto'
import { join } from 'path'
import { app } from 'electron'
import {
  TTS_VOICES,
  clampTtsSpeed,
  type TtsAudio,
  type TtsDownloadResult,
  type TtsModelStatus,
  type TtsRequest
} from '@shared/tts.types'
import * as events from './events'
import * as sidecar from './sidecar'

/**
 * The app's one door to the speech engine — the sidecar's `tts_*` methods
 * (docs/superpowers/specs/2026-10-15-voice-reader-design.md, D3/D4).
 *
 * Thin by rule (invariant 8): validation and the shapes between the two worlds, and
 * nothing that a sidecar test already decides. Three choices are worth saying:
 *
 * - **The model lives under `userData`, never in the bundle.** `modelDir()` is the one
 *   place that spells it; the sidecar is told, so it reads no configuration.
 * - **A refusal is a rejection here and `{ error }` there.** The sidecar answers a normal
 *   outcome (no model yet, no pronunciation data) in its result, as the reflow does; the
 *   IPC envelope's `error` is where the renderer reads a sentence, so it is thrown here.
 * - **One download at a time.** A second press shares the first; progress is rebroadcast
 *   on the app's own channel rather than handed to a caller, because the sidecar's frames
 *   arrive whether or not anything awaits the result.
 */

/** A sentence is ~0.3–0.5 s warm. Thirty seconds is a stuck engine, not a slow one. */
export const SYNTH_TIMEOUT_MS = 30_000
/** One sentence, not one chapter: a request this long is a caller bug. */
export const MAX_TEXT_CHARS = 4_000
/**
 * The lexicon is the library's `lexicon.json` (slice 3). Until that service exists there
 * is nothing to read, and this is the one line slice 3 replaces.
 */
const NO_LEXICON: never[] = []

export function modelDir(): string {
  return join(app.getPath('userData'), 'tts-models')
}

interface SidecarAudio {
  sample_rate?: unknown
  pcm?: unknown
  duration_ms?: unknown
  lexicon_version?: unknown
  error?: unknown
}

interface SidecarStatus {
  ready?: unknown
  missing?: unknown
  total_bytes?: unknown
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export async function status(): Promise<TtsModelStatus> {
  sidecar.assertAvailable()
  const answer = await sidecar.call<SidecarStatus>('tts_model_status', { model_dir: modelDir() })
  return {
    ready: answer.ready === true,
    missing: Array.isArray(answer.missing) ? answer.missing.filter((m): m is string => typeof m === 'string') : [],
    totalBytes: count(answer.total_bytes)
  }
}

export async function synthesize(request: TtsRequest): Promise<TtsAudio> {
  if (!(TTS_VOICES as readonly string[]).includes(request.voice)) {
    throw new Error(`Unknown voice: ${String(request.voice)}`)
  }
  const sentence = request.text.trim()
  if (!sentence) throw new Error('There is nothing to speak')
  if (sentence.length > MAX_TEXT_CHARS) throw new Error('That passage is too long to speak at once')
  sidecar.assertAvailable()
  const answer = await sidecar.call<SidecarAudio>(
    'tts_synthesize',
    {
      model_dir: modelDir(),
      text: sentence,
      voice: request.voice,
      speed: clampTtsSpeed(request.speed),
      lexicon: NO_LEXICON
    },
    SYNTH_TIMEOUT_MS
  )
  if (typeof answer.error === 'string' && answer.error) throw new Error(answer.error)
  const bytes = Buffer.from(text(answer.pcm), 'base64')
  return {
    sampleRate: count(answer.sample_rate) || 24000,
    // A copy, not a view: `Buffer.from` may sit in Node's shared pool slab, and structured
    // clone (which Electron's IPC uses) sends a view's *whole* underlying buffer.
    samples: Uint8Array.from(bytes),
    durationMs: count(answer.duration_ms),
    lexiconVersion: text(answer.lexicon_version)
  }
}

let running: { jobId: string; promise: Promise<TtsDownloadResult> } | null = null
let subscribed = false

function subscribeOnce(): void {
  if (subscribed) return
  subscribed = true
  sidecar.onNotification('tts_model_progress', (params) => {
    const frame = (params ?? {}) as Record<string, unknown>
    const jobId = text(frame.job_id)
    const file = text(frame.file)
    if (!jobId || !file) return
    events.broadcast('ttsModelProgress', {
      jobId,
      file,
      completed: count(frame.completed),
      total: count(frame.total)
    })
  })
}

export function downloadModel(): Promise<TtsDownloadResult> {
  if (running) return running.promise
  sidecar.assertAvailable()
  subscribeOnce()
  const jobId = randomUUID()
  const promise = sidecar
    .call<TtsDownloadResult>('tts_download_model', { model_dir: modelDir(), job_id: jobId }, 30 * 60_000)
    .catch((err: unknown) => {
      // The call gave up (app-side timeout, sidecar restart) but the Python job may still be
      // running: stop it, so the next download cannot race it on the same `.part`.
      void Promise.resolve()
        .then(() => sidecar.call('tts_cancel_download', { job_id: jobId }))
        .catch(() => undefined)
      throw err
    })
    .finally(() => {
      if (running?.jobId === jobId) running = null
    })
  running = { jobId, promise }
  return promise
}

export async function cancelDownload(): Promise<void> {
  if (!running) return
  await sidecar.call('tts_cancel_download', { job_id: running.jobId })
}

/** Forget the in-flight download and the subscription. For tests only. */
export function resetForTests(): void {
  running = null
  subscribed = false
}
