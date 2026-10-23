import { randomUUID } from 'crypto'
import { join } from 'path'
import { app } from 'electron'
import {
  cleanRespelling,
  cleanWord,
  toSpokenEntry,
  type LexiconPreviewRequest,
  type SpokenLexiconEntry
} from '@shared/lexicon.types'
import {
  TTS_VOICES,
  clampTtsSpeed,
  type TtsAudio,
  type TtsDownloadResult,
  type TtsModelStatus,
  type TtsRequest,
  type TtsWarmRequest,
  type TtsWarmResult
} from '@shared/tts.types'
import * as events from './events'
import * as lexicon from './lexicon'
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
 *
 * **Every sentence is phonemized with the library's pronunciations** (D8, annex R1): the
 * entries come from `services/lexicon.ts` on each call, so a respelling saved mid-book is
 * in the next sentence and no restart is needed (AC26). The read is stat-keyed, so this
 * costs one `stat` on the share rather than a read, and it never throws — a library that
 * cannot be read is a sentence with no respellings, not a sentence that fails to speak.
 */

/** A sentence is ~0.3–0.5 s warm. Thirty seconds is a stuck engine, not a slow one. */
export const SYNTH_TIMEOUT_MS = 30_000
/** One sentence, not one chapter: a request this long is a caller bug. */
export const MAX_TEXT_CHARS = 4_000

/**
 * What a pre-warm speaks, and never plays. The point is not the sentence: it is that the
 * model's load plus its first inference — measured at 1.0 to 1.7 s of a cold first sentence
 * (3.186 s cold against 1.499 s warm for the same 329-character sentence, and 1.462 s after
 * this call) — are paid when the bar opens rather than in front of the first thing a person
 * hears. Short on purpose: the cost is the load and the graph's first run, not the text.
 */
export const WARM_SENTENCE = 'Ready.'

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

function asText(value: unknown): string {
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
    missing: Array.isArray(answer.missing)
      ? answer.missing.filter((m): m is string => typeof m === 'string')
      : [],
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
  return speak(sentence, request.voice, request.speed, await lexicon.spokenEntries())
}

/**
 * Speak one word as a respelling says it (D8's Preview, annex R3).
 *
 * The word goes to the engine **with a one-entry lexicon**, which is deliberately the
 * same path saving it and reading the word aloud would take: the respelling is phonemized
 * and spliced at the word boundary, so what a person hears is what the library will do —
 * not espeak reading the letters of `HAY-gul`. It writes nothing.
 *
 * This is also AC24's instrument: the derivation from a respelling is the substitution D8
 * named as not yet listened to, and this is the only path that produces it.
 */
export async function preview(request: LexiconPreviewRequest): Promise<TtsAudio> {
  if (!(TTS_VOICES as readonly string[]).includes(request.voice)) {
    throw new Error(`Unknown voice: ${String(request.voice)}`)
  }
  const word = cleanWord(request.word)
  if (!word) throw new Error('A pronunciation needs a word.')
  const soundsLike = cleanRespelling(request.soundsLike)
  if (!soundsLike) {
    throw new Error('A respelling is letters, spaces and hyphens — like HAY-gul.')
  }
  const entry = toSpokenEntry({ word, soundsLike, addedAt: '' })
  return speak(word, request.voice, request.speed, [entry])
}

/**
 * Load the voice and pay its first inference, so the model's load does not land in front of the
 * first sentence a person hears (spec AC21's cold start; the measurement is in `tasks.md`).
 *
 * **Quiet by rule.** A bar opening is not a request to speak, so nothing here may fail loudly:
 * an unknown voice, an unavailable sidecar, a missing model, a failed load or the engine's own
 * refusal all answer `{ warmed: false }` and never reject. Nothing is shown for either answer,
 * and the audio is discarded. It reads no lexicon — a share `stat` for a sentence nobody hears
 * is a cost this call does not need (the entries do not change what the model loads).
 */
export async function warm(request: TtsWarmRequest): Promise<TtsWarmResult> {
  if (!(TTS_VOICES as readonly string[]).includes(request.voice)) return { warmed: false }
  try {
    const model = await status()
    if (!model.ready) return { warmed: false }
    await speak(WARM_SENTENCE, request.voice, request.speed, [])
    return { warmed: true }
  } catch {
    return { warmed: false }
  }
}

async function speak(
  text: string,
  voice: TtsRequest['voice'],
  speed: number,
  entries: SpokenLexiconEntry[]
): Promise<TtsAudio> {
  sidecar.assertAvailable()
  const answer = await sidecar.call<SidecarAudio>(
    'tts_synthesize',
    {
      model_dir: modelDir(),
      text,
      voice,
      speed: clampTtsSpeed(speed),
      lexicon: entries
    },
    SYNTH_TIMEOUT_MS
  )
  if (typeof answer.error === 'string' && answer.error) throw new Error(answer.error)
  const bytes = Buffer.from(asText(answer.pcm), 'base64')
  return {
    sampleRate: count(answer.sample_rate) || 24000,
    // A copy, not a view: `Buffer.from` may sit in Node's shared pool slab, and structured
    // clone (which Electron's IPC uses) sends a view's *whole* underlying buffer.
    samples: Uint8Array.from(bytes),
    durationMs: count(answer.duration_ms),
    lexiconVersion: asText(answer.lexicon_version)
  }
}

let running: { jobId: string; promise: Promise<TtsDownloadResult> } | null = null
let subscribed = false

function subscribeOnce(): void {
  if (subscribed) return
  subscribed = true
  sidecar.onNotification('tts_model_progress', (params) => {
    const frame = (params ?? {}) as Record<string, unknown>
    const jobId = asText(frame.job_id)
    const file = asText(frame.file)
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
    .call<TtsDownloadResult>(
      'tts_download_model',
      { model_dir: modelDir(), job_id: jobId },
      30 * 60_000
    )
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
