/**
 * The voice reader's contract (docs/superpowers/specs/2026-10-15-voice-reader-design.md).
 * Shared by the main-process service and, in slice 2, the reader.
 */

/** The five voices Jason chose by ear on 2026-10-15; more are available and nobody has heard them. */
export const TTS_VOICES = ['af_heart', 'af_bella', 'bf_emma', 'bm_george', 'am_michael'] as const
export type TtsVoice = (typeof TTS_VOICES)[number]
export const TTS_DEFAULT_VOICE: TtsVoice = 'af_heart'

/** What a rendered file's stamp will name (D9). */
export const TTS_MODEL_ID = 'kokoro-v1.0-int8'

export const TTS_SPEED_MIN = 0.8
export const TTS_SPEED_MAX = 1.5

/** Out-of-range speeds clamp, NaN falls back to 1.0, and the step is 0.1 (D7). */
export function clampTtsSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1.0
  const clamped = Math.min(TTS_SPEED_MAX, Math.max(TTS_SPEED_MIN, speed))
  return Math.round(clamped * 10) / 10
}

/** Voice, speed and model as one value, so a cache key or a stamp never has to assemble it (D9). */
export interface VoiceSpec {
  model: typeof TTS_MODEL_ID
  voice: TtsVoice
  speed: number
}

export interface TtsRequest {
  text: string
  voice: TtsVoice
  speed: number
}

/** A pre-warm: the voice and speed a first sentence would be spoken with. No text — see `tts.warm`. */
export interface TtsWarmRequest {
  voice: TtsVoice
  speed: number
}

/**
 * What a pre-warm answered. False is not a failure: the bar opening is not a request to speak,
 * so a missing model or an unavailable engine just means nothing was warmed.
 */
export interface TtsWarmResult {
  warmed: boolean
}

/** One synthesized sentence: mono signed 16-bit little-endian PCM. Empty `samples` is silence. */
export interface TtsAudio {
  sampleRate: number
  samples: Uint8Array
  durationMs: number
  /** A hash of the lexicon entries that applied — what a rendered file's stamp will need. */
  lexiconVersion: string
}

export interface TtsModelStatus {
  ready: boolean
  missing: string[]
  totalBytes: number
}

export interface TtsDownloadProgress {
  jobId: string
  file: string
  /** Bytes, across both files. */
  completed: number
  total: number
}

export type TtsDownloadResult =
  { status: 'ready' } | { status: 'cancelled' } | { status: 'failed'; error: string }
