/**
 * The listen bar's state machine (voice reader slice 2, spec D4/D6), pure so it is tested
 * without a DOM. `src/hooks/useSpeech.ts` dispatches these events and owns every side
 * effect — the IPC calls, the `AudioContext`, the controller and the player; nothing here
 * calls anything.
 */
import type { TtsDownloadResult } from '@shared/tts.types'

export type SpeechPhase =
  | { kind: 'idle' } // bar open, nothing playing
  | { kind: 'needs-model'; totalBytes: number } // "Download the voice (120 MB)"
  | { kind: 'downloading'; completed: number; total: number }
  | { kind: 'loading' } // model warming; first sentence pending
  | { kind: 'playing' }
  | { kind: 'paused' }
  | { kind: 'error'; message: string; canRetry: boolean }
  | { kind: 'offline-no-model' } // one honest sentence, not a toast

/** What Retry repeats: the download, or the player's `start()` (it rewinds to the failed sentence). */
export type SpeechRetry = 'download' | 'play'

export interface SpeechState {
  phase: SpeechPhase
  /** A one-line note beside the phase — today only the damaged-model line (Review Focus 5). */
  notice: string | null
  /** The download's size, as the last status reported it (the D4 pin until then). */
  totalBytes: number
  /** False for `RETRY_DELAY_MS` after an error: Retry is disabled (Review Focus 8). */
  retryArmed: boolean
  retryOf: SpeechRetry | null
  /** A sentence of this play has sounded: a resume goes back to `playing`, not `loading`. */
  sounded: boolean
}

/** The two pinned files of D4: 92,361,271 + 28,214,398 bytes. */
export const TTS_MODEL_BYTES = 120_575_669
export const RETRY_DELAY_MS = 2_000
export const DAMAGED_NOTICE = 'The voice file is damaged; download it again.'
/** `begin()` found no sentence from the place it was asked to start (or could not bind). */
export const NOTHING_TO_READ_NOTICE = 'Nothing to read on this page.'

export const INITIAL_SPEECH_STATE: SpeechState = {
  phase: { kind: 'idle' },
  notice: null,
  totalBytes: TTS_MODEL_BYTES,
  retryArmed: true,
  retryOf: null,
  sounded: false
}

export type SpeechEvent =
  | { type: 'play-requested' }
  /** `status()` answered `ready: false`. `offline`: `navigator.onLine === false`. */
  | { type: 'model-missing'; totalBytes: number; offline: boolean }
  | { type: 'download-started' }
  | { type: 'download-progress'; completed: number; total: number }
  | { type: 'download-finished'; result: TtsDownloadResult; offline: boolean }
  | { type: 'download-rejected'; message: string; offline: boolean }
  /** A sentence started sounding (the player's `onUnitStart`). */
  | { type: 'unit-started' }
  /** The reader moved and the player restarted at the new page (AC17). */
  | { type: 'restarted' }
  | { type: 'paused' }
  | { type: 'resumed' }
  /** The player's `onEnd`: the book ran out. */
  | { type: 'ended' }
  /** The player's or the controller's `onError`, or a play that could not begin. */
  | { type: 'failed'; message: string }
  /** `begin()` answered false: nothing from here to the end, or no section to bind. */
  | { type: 'nothing-to-read' }
  | { type: 'retry-armed' }
  | { type: 'retry' }
  /** The bar closed, the book changed or the reader closed: speech is torn down. */
  | { type: 'closed' }

/**
 * The download's transport failing — not the files failing their hash. The sidecar
 * answers with `str(requests exception)` (`sidecar/tts/models.py`), so this reads the
 * phrases `requests`/`urllib3` and the OS put in those.
 */
const OFFLINE =
  /\boffline\b|Failed to resolve|NameResolution|nodename nor servname|getaddrinfo|ENOTFOUND|Network is unreachable|Max retries exceeded|Failed to establish a new connection|Temporary failure in name resolution/i

export function isOfflineFailure(message: string): boolean {
  return OFFLINE.test(message)
}

/** `verify` refuses a same-size corrupt file with "damaged" (voice-reader.md): download again. */
function isDamaged(message: string): boolean {
  return /damaged/i.test(message)
}

/** "The voice is not downloaded yet": the files went away under a running bar. */
function isMissing(message: string): boolean {
  return /not downloaded/i.test(message)
}

function errorState(state: SpeechState, message: string, retryOf: SpeechRetry): SpeechState {
  return {
    ...state,
    phase: { kind: 'error', message, canRetry: true },
    notice: null,
    retryArmed: false,
    retryOf
  }
}

function downloadFailed(state: SpeechState, message: string, offline: boolean): SpeechState {
  if (offline || isOfflineFailure(message)) {
    return { ...state, phase: { kind: 'offline-no-model' }, notice: null, retryOf: null }
  }
  return errorState(state, message, 'download')
}

function needsModel(state: SpeechState, notice: string | null): SpeechState {
  return {
    ...state,
    phase: { kind: 'needs-model', totalBytes: state.totalBytes },
    notice,
    retryOf: null
  }
}

export function speechReducer(state: SpeechState, event: SpeechEvent): SpeechState {
  const kind = state.phase.kind
  switch (event.type) {
    case 'play-requested':
      if (kind === 'downloading') return state
      return {
        ...state,
        phase: { kind: 'loading' },
        // a play from needs-model that finds the model still missing keeps the damaged line
        notice: kind === 'needs-model' ? state.notice : null,
        retryOf: null,
        sounded: false
      }

    case 'model-missing': {
      const next = { ...state, totalBytes: event.totalBytes }
      if (event.offline) return { ...next, phase: { kind: 'offline-no-model' }, retryOf: null }
      return needsModel(next, state.notice)
    }

    case 'download-started':
      if (kind === 'downloading') return state
      return {
        ...state,
        phase: { kind: 'downloading', completed: 0, total: state.totalBytes },
        notice: null,
        retryOf: null
      }

    case 'download-progress':
      if (kind !== 'downloading') return state
      return {
        ...state,
        phase: { kind: 'downloading', completed: event.completed, total: event.total }
      }

    case 'download-finished':
      if (event.result.status === 'ready')
        return { ...state, phase: { kind: 'idle' }, notice: null }
      if (event.result.status === 'cancelled') return needsModel(state, null)
      return downloadFailed(state, event.result.error, event.offline)

    case 'download-rejected':
      return downloadFailed(state, event.message, event.offline)

    case 'unit-started': {
      if (kind !== 'loading' && kind !== 'idle' && kind !== 'playing' && kind !== 'paused')
        return state
      const phase: SpeechPhase =
        kind === 'paused' || kind === 'playing' ? state.phase : { kind: 'playing' }
      if (phase === state.phase && state.sounded && state.notice === null) return state
      return { ...state, phase, notice: null, sounded: true }
    }

    case 'restarted':
      if (kind === 'idle') return { ...state, phase: { kind: 'loading' }, sounded: false }
      return state

    case 'paused':
      if (kind === 'playing' || kind === 'loading') return { ...state, phase: { kind: 'paused' } }
      return state

    case 'resumed':
      if (kind === 'paused')
        return { ...state, phase: state.sounded ? { kind: 'playing' } : { kind: 'loading' } }
      return state

    case 'ended':
      if (kind === 'playing' || kind === 'loading') return { ...state, phase: { kind: 'idle' } }
      return state

    case 'failed':
      // a download in flight is the bar's whole story; a stale session's failure is not news
      if (kind === 'downloading') return state
      if (isDamaged(event.message)) return needsModel(state, DAMAGED_NOTICE)
      if (isMissing(event.message)) return needsModel(state, null)
      return errorState(state, event.message, 'play')

    case 'nothing-to-read':
      return { ...state, phase: { kind: 'idle' }, notice: NOTHING_TO_READ_NOTICE, retryOf: null }

    case 'retry-armed':
      return state.retryArmed ? state : { ...state, retryArmed: true }

    case 'retry': {
      if (state.phase.kind !== 'error' || !state.phase.canRetry || !state.retryArmed) return state
      if (state.retryOf === 'download') {
        return {
          ...state,
          phase: { kind: 'downloading', completed: 0, total: state.totalBytes },
          retryOf: null
        }
      }
      return { ...state, phase: { kind: 'loading' }, retryOf: null, sounded: false }
    }

    case 'closed':
      // the download is the app's, not the bar's: it goes on, and the bar shows it on reopening
      if (kind === 'downloading') return state
      if (kind === 'idle' && state.notice === null && state.retryOf === null && !state.sounded)
        return state
      return { ...INITIAL_SPEECH_STATE, totalBytes: state.totalBytes }
  }
}
