import { describe, expect, it } from 'vitest'
import {
  DAMAGED_NOTICE,
  INITIAL_SPEECH_STATE,
  NOTHING_TO_READ_NOTICE,
  TTS_MODEL_BYTES,
  isOfflineFailure,
  speechReducer,
  type SpeechEvent,
  type SpeechState
} from './speech-state'

/**
 * The listen bar's state machine (voice reader slice 2, Task 7), without a DOM: the hook
 * (`src/hooks/useSpeech.ts`) dispatches these events and does the side effects; every
 * phase the bar can show is decided here.
 */

function run(events: SpeechEvent[], from: SpeechState = INITIAL_SPEECH_STATE): SpeechState {
  return events.reduce(speechReducer, from)
}

const NEEDS_MODEL: SpeechEvent = { type: 'model-missing', totalBytes: 120, offline: false }

describe('speechReducer — the model', () => {
  it('starts idle with the pinned download size', () => {
    expect(INITIAL_SPEECH_STATE.phase).toEqual({ kind: 'idle' })
    expect(INITIAL_SPEECH_STATE.totalBytes).toBe(TTS_MODEL_BYTES)
    expect(TTS_MODEL_BYTES).toBe(92_361_271 + 28_214_398)
  })

  it('play with no model → needs-model, carrying the size the status reported', () => {
    const s = run([{ type: 'play-requested' }, NEEDS_MODEL])
    expect(s.phase).toEqual({ kind: 'needs-model', totalBytes: 120 })
  })

  it('needs-model → downloading on start and progress → needs-model again on cancel', () => {
    let s = run([{ type: 'play-requested' }, NEEDS_MODEL, { type: 'download-started' }])
    expect(s.phase).toEqual({ kind: 'downloading', completed: 0, total: 120 })
    s = speechReducer(s, { type: 'download-progress', completed: 60, total: 120 })
    expect(s.phase).toEqual({ kind: 'downloading', completed: 60, total: 120 })
    s = speechReducer(s, {
      type: 'download-finished',
      result: { status: 'cancelled' },
      offline: false
    })
    expect(s.phase).toEqual({ kind: 'needs-model', totalBytes: 120 })
  })

  it('progress outside a download is ignored', () => {
    const s = run([{ type: 'download-progress', completed: 1, total: 2 }])
    expect(s).toBe(INITIAL_SPEECH_STATE)
  })

  it('a finished download goes back to idle (the hook then plays)', () => {
    const s = run([
      NEEDS_MODEL,
      { type: 'download-started' },
      { type: 'download-finished', result: { status: 'ready' }, offline: false }
    ])
    expect(s.phase).toEqual({ kind: 'idle' })
  })

  it('a failed download → error with canRetry, retry not armed until the delay passes', () => {
    let s = run([
      NEEDS_MODEL,
      { type: 'download-started' },
      {
        type: 'download-finished',
        result: {
          status: 'failed',
          error: 'voices-v1.0.bin did not download correctly — try again'
        },
        offline: false
      }
    ])
    expect(s.phase).toEqual({
      kind: 'error',
      message: 'voices-v1.0.bin did not download correctly — try again',
      canRetry: true
    })
    expect(s.retryArmed).toBe(false)
    // too soon: Retry is disabled, so the event changes nothing
    expect(speechReducer(s, { type: 'retry' })).toBe(s)
    s = speechReducer(s, { type: 'retry-armed' })
    expect(s.retryArmed).toBe(true)
    s = speechReducer(s, { type: 'retry' })
    expect(s.phase).toEqual({ kind: 'downloading', completed: 0, total: 120 })
  })

  it('a rejected download is the same error', () => {
    const s = run([
      NEEDS_MODEL,
      { type: 'download-started' },
      { type: 'download-rejected', message: 'Python sidecar is unavailable', offline: false }
    ])
    expect(s.phase).toMatchObject({ kind: 'error', canRetry: true })
    expect(s.retryOf).toBe('download')
  })

  it('offline with no model is one sentence, from the browser flag or from the failure text', () => {
    expect(run([{ type: 'play-requested' }, { ...NEEDS_MODEL, offline: true }]).phase).toEqual({
      kind: 'offline-no-model'
    })
    const viaText = run([
      NEEDS_MODEL,
      { type: 'download-started' },
      {
        type: 'download-finished',
        result: {
          status: 'failed',
          error:
            "HTTPSConnectionPool(host='github.com', port=443): Max retries exceeded with url: /x (Caused by NameResolutionError(\"Failed to resolve 'github.com'\"))"
        },
        offline: false
      }
    ])
    expect(viaText.phase).toEqual({ kind: 'offline-no-model' })
    const viaFlag = run([
      NEEDS_MODEL,
      { type: 'download-started' },
      { type: 'download-rejected', message: 'anything', offline: true }
    ])
    expect(viaFlag.phase).toEqual({ kind: 'offline-no-model' })
  })

  it('from offline-no-model a later download may start', () => {
    const s = run([{ ...NEEDS_MODEL, offline: true }, { type: 'download-started' }])
    expect(s.phase).toEqual({ kind: 'downloading', completed: 0, total: 120 })
  })

  it('isOfflineFailure reads the transport failures and not a hash failure', () => {
    expect(isOfflineFailure('offline')).toBe(true)
    expect(isOfflineFailure('[Errno 8] nodename nor servname provided, or not known')).toBe(true)
    expect(
      isOfflineFailure('Failed to establish a new connection: [Errno 51] Network is unreachable')
    ).toBe(true)
    expect(isOfflineFailure('kokoro-v1.0.int8.onnx did not download correctly — try again')).toBe(
      false
    )
  })
})

describe('speechReducer — synthesis failures', () => {
  it('"damaged" → needs-model with its one line, not an error with a retry', () => {
    const s = run([
      { type: 'play-requested' },
      { type: 'unit-started' },
      { type: 'failed', message: 'The voice files are damaged — download them again' }
    ])
    expect(s.phase).toEqual({ kind: 'needs-model', totalBytes: TTS_MODEL_BYTES })
    expect(s.notice).toBe(DAMAGED_NOTICE)
    expect(DAMAGED_NOTICE).toBe('The voice file is damaged; download it again.')
    // the line goes when the download starts
    expect(speechReducer(s, { type: 'download-started' }).notice).toBeNull()
  })

  it('"not downloaded" (the files went away) → needs-model, no line', () => {
    const s = run([
      { type: 'play-requested' },
      { type: 'failed', message: 'The voice is not downloaded yet' }
    ])
    expect(s.phase).toEqual({ kind: 'needs-model', totalBytes: TTS_MODEL_BYTES })
    expect(s.notice).toBeNull()
  })

  it('any other rejection → error, canRetry; retry (once armed) goes back to loading', () => {
    let s = run([
      { type: 'play-requested' },
      { type: 'unit-started' },
      { type: 'failed', message: 'Python sidecar is unavailable' }
    ])
    expect(s.phase).toEqual({
      kind: 'error',
      message: 'Python sidecar is unavailable',
      canRetry: true
    })
    expect(s.retryOf).toBe('play')
    expect(speechReducer(s, { type: 'retry' })).toBe(s)
    s = run([{ type: 'retry-armed' }, { type: 'retry' }], s)
    expect(s.phase).toEqual({ kind: 'loading' })
  })

  it('the end the player reports after a failure does not hide the error', () => {
    const s = run([
      { type: 'play-requested' },
      { type: 'unit-started' },
      { type: 'failed', message: 'Could not continue to the next chapter.' },
      { type: 'ended' }
    ])
    expect(s.phase).toMatchObject({ kind: 'error' })
  })

  it('a sentence scheduled before the failure starting late does not flip it to playing', () => {
    const s = run([
      { type: 'play-requested' },
      { type: 'failed', message: 'boom' },
      { type: 'unit-started' }
    ])
    expect(s.phase).toMatchObject({ kind: 'error' })
  })
})

describe('speechReducer — the transport', () => {
  it('play → loading → playing on the first sentence → paused → playing', () => {
    let s = run([{ type: 'play-requested' }])
    expect(s.phase).toEqual({ kind: 'loading' })
    s = speechReducer(s, { type: 'unit-started' })
    expect(s.phase).toEqual({ kind: 'playing' })
    // every later sentence leaves the state as it is (no re-render per sentence)
    expect(speechReducer(s, { type: 'unit-started' })).toBe(s)
    s = speechReducer(s, { type: 'paused' })
    expect(s.phase).toEqual({ kind: 'paused' })
    // a skip while paused moves the highlight; the bar stays paused
    expect(speechReducer(s, { type: 'unit-started' }).phase).toEqual({ kind: 'paused' })
    s = speechReducer(s, { type: 'resumed' })
    expect(s.phase).toEqual({ kind: 'playing' })
  })

  it('pause before the first sentence is still a pause', () => {
    expect(run([{ type: 'play-requested' }, { type: 'paused' }]).phase).toEqual({ kind: 'paused' })
  })

  it('pause and resume mean nothing when nothing is playing', () => {
    expect(run([{ type: 'paused' }])).toBe(INITIAL_SPEECH_STATE)
    expect(run([{ type: 'resumed' }])).toBe(INITIAL_SPEECH_STATE)
  })

  it('the end of the book → idle; a relocate restart after it → loading', () => {
    let s = run([{ type: 'play-requested' }, { type: 'unit-started' }, { type: 'ended' }])
    expect(s.phase).toEqual({ kind: 'idle' })
    s = speechReducer(s, { type: 'restarted' })
    expect(s.phase).toEqual({ kind: 'loading' })
  })

  it('a relocate restart while playing or paused keeps the bar as it is', () => {
    const playing = run([{ type: 'play-requested' }, { type: 'unit-started' }])
    expect(speechReducer(playing, { type: 'restarted' })).toBe(playing)
    const paused = speechReducer(playing, { type: 'paused' })
    expect(speechReducer(paused, { type: 'restarted' })).toBe(paused)
  })

  it('close → idle, the notice cleared; a download in flight keeps going', () => {
    const s = run([
      { type: 'play-requested' },
      { type: 'failed', message: 'The voice files are damaged' },
      { type: 'closed' }
    ])
    expect(s.phase).toEqual({ kind: 'idle' })
    expect(s.notice).toBeNull()
    // closing what is already closed changes nothing (no re-render on mount)
    expect(speechReducer(INITIAL_SPEECH_STATE, { type: 'closed' })).toBe(INITIAL_SPEECH_STATE)
    const dl = run([NEEDS_MODEL, { type: 'download-started' }])
    expect(speechReducer(dl, { type: 'closed' })).toBe(dl)
  })
})

describe('speechReducer — review fixes (Task 7a)', () => {
  it('M3: a stray failure during a download does not leave the download', () => {
    const dl = run([NEEDS_MODEL, { type: 'download-started' }])
    expect(speechReducer(dl, { type: 'failed', message: 'boom' })).toBe(dl)
  })

  it('M4: play from needs-model keeps the damaged line when the model is still missing', () => {
    const s = run([
      { type: 'play-requested' },
      { type: 'failed', message: 'The voice files are damaged — download them again' },
      { type: 'play-requested' },
      NEEDS_MODEL
    ])
    expect(s.phase).toEqual({ kind: 'needs-model', totalBytes: 120 })
    expect(s.notice).toBe(DAMAGED_NOTICE)
    // and goes once a sentence sounds
    expect(
      speechReducer(speechReducer(s, { type: 'play-requested' }), { type: 'unit-started' }).notice
    ).toBeNull()
  })

  it('M2: nothing to read from here → idle with one line, cleared by the next play', () => {
    const s = run([{ type: 'play-requested' }, { type: 'nothing-to-read' }])
    expect(s.phase).toEqual({ kind: 'idle' })
    expect(s.notice).toBe(NOTHING_TO_READ_NOTICE)
    expect(speechReducer(s, { type: 'play-requested' }).notice).toBeNull()
  })

  it('M1: a pause before the first sentence resumes to loading, not playing', () => {
    const early = run([{ type: 'play-requested' }, { type: 'paused' }, { type: 'resumed' }])
    expect(early.phase).toEqual({ kind: 'loading' })
    const late = run([
      { type: 'play-requested' },
      { type: 'unit-started' },
      { type: 'paused' },
      { type: 'resumed' }
    ])
    expect(late.phase).toEqual({ kind: 'playing' })
    // a fresh play forgets that the last one had sounded
    const again = run(
      [{ type: 'ended' }, { type: 'play-requested' }, { type: 'paused' }, { type: 'resumed' }],
      late
    )
    expect(again.phase).toEqual({ kind: 'loading' })
  })

  it('I1: pause means nothing in a failed, ended or model state (so nothing is suspended there)', () => {
    const failed = run([{ type: 'play-requested' }, { type: 'failed', message: 'boom' }])
    expect(speechReducer(failed, { type: 'paused' })).toBe(failed)
    const ended = run([{ type: 'play-requested' }, { type: 'unit-started' }, { type: 'ended' }])
    expect(speechReducer(ended, { type: 'paused' })).toBe(ended)
  })
})
