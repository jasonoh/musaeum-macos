import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { FoliateView } from '@vendor/foliate-js/view.js'
import type { TtsAudio, TtsDownloadResult, TtsModelStatus, TtsRequest } from '@shared/tts.types'
import { isSavedValue } from '@/lib/annotations'
import { SpeechController } from '@/lib/speech-controller'
import { SentenceCache, SpeechPlayer } from '@/lib/speech-player'
import {
  INITIAL_SPEECH_STATE,
  RETRY_DELAY_MS,
  speechReducer,
  type SpeechEvent,
  type SpeechPhase,
  type SpeechState
} from '@/lib/speech-state'
import { resolveReaderPalette } from '@/lib/theme/reader-palette'
import { useReaderStore } from '@/stores/reader.store'
import { useThemeStore } from '@/stores/theme.store'

export type { SpeechPhase } from '@/lib/speech-state'

export interface UseSpeechArgs {
  /** The reader's engine, as `ReaderView` already holds it for the chrome's buttons. */
  viewRef: MutableRefObject<FoliateView | null>
  /** The open book: a change (or null) tears speech down. */
  bookId: string | null
}

export interface SpeechApi {
  phase: SpeechPhase
  /** One line beside the phase — today only "The voice file is damaged; download it again." */
  notice: string | null
  /** False for `RETRY_DELAY_MS` after an error: the bar disables Retry (Review Focus 8). */
  retryReady: boolean
  /** From `from` (Read from here), or else from the page on screen. Paused, no range: resume. */
  play(from?: Range): Promise<void>
  pause(): void
  resume(): void
  skip(delta: -1 | 1): void
  download(): Promise<void>
  cancelDownload(): void
  retry(): void
  /** Stop speech and close the bar. */
  close(): void
  /**
   * Feed it every engine `relocate`'s `range` (AC17). Read in the handler, never held: the
   * controller clones it before anything else.
   */
  onRelocate(range: Range | null): void
}

interface Session {
  controller: SpeechController
  player: SpeechPlayer
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function offline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

/**
 * The voice reader's wiring (spec D5/D6): the IPC bridge, one `SpeechController` over the
 * engine and one `SpeechPlayer` on one `AudioContext`, per play. Mounted by the reader, not
 * by `App.tsx`: it is the reader's session, and it lives and dies with the open book.
 *
 * Decisions taken here:
 * - **Every phase is the pure reducer's** (`src/lib/speech-state.ts`); this hook only turns
 *   callbacks into events. The state is mirrored into a ref as it is computed, so a callback
 *   reads the phase the last event produced, not the last render's.
 * - **A play with a range, or from a finished/failed state, builds a fresh session.** Moving
 *   a live controller under a running player is a race the controller's `begin()` and the
 *   player's `restartAt()` do not settle between them (a woken take can be dropped by the
 *   restart's abort); a new `AudioContext` costs nothing that a sentence does not.
 * - **A session survives the end of the book**, so a page turn back restarts there (AC17,
 *   `restartAt` after `onEnd`). It is torn down by a new play, the bar closing, the book
 *   changing, and unmount.
 * - **`generation`** counts teardowns: a continuation that awaited `status()` or `begin()`
 *   while the book closed finds it changed and does nothing.
 */
export function useSpeech({ viewRef, bookId }: UseSpeechArgs): SpeechApi {
  const [state, setState] = useState<SpeechState>(INITIAL_SPEECH_STATE)
  const stateRef = useRef<SpeechState>(INITIAL_SPEECH_STATE)
  const session = useRef<Session | null>(null)
  const generation = useRef(0)
  const synthesize = useRef<((r: TtsRequest) => Promise<TtsAudio>) | null>(null)
  const mounted = useRef(true)

  const listenOpen = useReaderStore((s) => s.listenOpen)
  const voice = useReaderStore((s) => s.prefs.voice)
  const speed = useReaderStore((s) => s.prefs.speed)

  const send = useCallback((event: SpeechEvent) => {
    const next = speechReducer(stateRef.current, event)
    if (next === stateRef.current) return
    stateRef.current = next
    setState(next)
  }, [])

  const teardown = useCallback(() => {
    generation.current += 1
    const s = session.current
    session.current = null
    if (!s) return
    // stop first: it settles the controller's pending take before the controller goes
    void s.player.stop().catch(() => {})
    s.controller.dispose()
  }, [])

  const resume = useCallback(() => {
    const s = session.current
    if (!s) return
    void s.player.resume().catch(() => {})
    send({ type: 'resumed' })
  }, [send])

  const play = useCallback(
    async (from?: Range) => {
      const kind = stateRef.current.phase.kind
      if (kind === 'downloading') return
      if (!from && session.current) {
        if (kind === 'paused') return resume()
        if (kind === 'playing' || kind === 'loading') return
      }
      teardown()
      const gen = generation.current
      send({ type: 'play-requested' })

      let status: TtsModelStatus
      try {
        status = await window.Musaeum.tts.status()
      } catch (e) {
        if (gen === generation.current) send({ type: 'failed', message: message(e) })
        return
      }
      if (gen !== generation.current) return
      if (!status.ready) {
        send({
          type: 'model-missing',
          totalBytes: status.totalBytes,
          offline: navigator.onLine === false
        })
        return
      }
      const view = viewRef.current
      if (!view) {
        send({ type: 'failed', message: 'The book is not open yet.' })
        return
      }

      const live = (): boolean => gen === generation.current
      let next: Session
      try {
        const controller = new SpeechController({
          view,
          speechColor: () =>
            resolveReaderPalette(
              useReaderStore.getState().prefs.theme,
              useThemeStore.getState().view?.active.tokens ?? null
            ).speech,
          isSaved: (cfi) => isSavedValue(useReaderStore.getState().annotations, cfi),
          onError: (m) => {
            if (live()) send({ type: 'failed', message: m })
          }
        })
        synthesize.current ??= new SentenceCache(50).wrap((r) => window.Musaeum.tts.synthesize(r))
        const player = new SpeechPlayer({
          context: new AudioContext(),
          synthesize: synthesize.current,
          source: controller,
          spec: () => {
            const { voice, speed } = useReaderStore.getState().prefs
            return { voice, speed }
          },
          onUnitStart: () => {
            if (live()) send({ type: 'unit-started' })
          },
          onEnd: () => {
            if (live()) send({ type: 'ended' })
          },
          onError: (m) => {
            if (live()) send({ type: 'failed', message: m })
          }
        })
        next = { controller, player }
      } catch (e) {
        send({ type: 'failed', message: message(e) })
        return
      }
      session.current = next

      try {
        await next.controller.begin(from)
      } catch (e) {
        if (gen === generation.current) send({ type: 'failed', message: message(e) })
        return
      }
      if (gen !== generation.current) return
      // A book with nothing to say from here: the first take answers null and `onEnd` fires.
      next.player.start()
    },
    [viewRef, send, teardown, resume]
  )

  const pause = useCallback(() => {
    const s = session.current
    if (!s) return
    void s.player.pause().catch(() => {})
    send({ type: 'paused' })
  }, [send])

  const skip = useCallback((delta: -1 | 1) => {
    session.current?.player.skip(delta)
  }, [])

  const runDownload = useCallback(async () => {
    let result: TtsDownloadResult
    try {
      result = await window.Musaeum.tts.downloadModel()
    } catch (e) {
      if (mounted.current)
        send({ type: 'download-rejected', message: message(e), offline: offline() })
      return
    }
    if (!mounted.current) return
    send({ type: 'download-finished', result, offline: offline() })
    if (result.status !== 'ready' || !useReaderStore.getState().listenOpen) return
    const s = session.current
    if (s) {
      // the model was damaged mid-book: back to the sentence that failed
      send({ type: 'play-requested' })
      s.player.start()
    } else {
      void play()
    }
  }, [send, play])

  const download = useCallback(async () => {
    if (stateRef.current.phase.kind === 'downloading') return
    send({ type: 'download-started' })
    await runDownload()
  }, [send, runDownload])

  const cancelDownload = useCallback(() => {
    // the outcome arrives as the download's own `{ status: 'cancelled' }`
    void window.Musaeum.tts.cancelDownload().catch(() => {})
  }, [])

  const retry = useCallback(() => {
    const before = stateRef.current
    send({ type: 'retry' })
    if (stateRef.current === before) return // not an error, or not armed yet
    if (before.retryOf === 'download') {
      void runDownload()
      return
    }
    const s = session.current
    if (s) s.player.start()
    else void play()
  }, [send, runDownload, play])

  const close = useCallback(() => {
    teardown()
    send({ type: 'closed' })
    useReaderStore.getState().closeListen()
  }, [send, teardown])

  const onRelocate = useCallback(
    (range: Range | null) => {
      const s = session.current
      if (!s || !range) return
      const kind = stateRef.current.phase.kind
      if (kind !== 'playing' && kind !== 'paused' && kind !== 'loading' && kind !== 'idle') return
      const gen = generation.current
      s.controller.onRelocate(range).then(
        (unit) => {
          if (!unit || gen !== generation.current) return
          s.player.restartAt(unit)
          send({ type: 'restarted' })
        },
        () => {}
      )
    },
    [send]
  )

  // Progress is broadcast on the app's channel, not handed to the caller: subscribed once.
  useEffect(
    () =>
      window.Musaeum.on.ttsModelProgress((p) =>
        send({ type: 'download-progress', completed: p.completed, total: p.total })
      ),
    [send]
  )

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // A book change, and unmount: no audio from a closed book (Review Focus 6).
  useEffect(() => {
    return () => {
      teardown()
      synthesize.current = null
      send({ type: 'closed' })
    }
  }, [bookId, teardown, send])

  // The bar closed — its own close, the `L` key, or the store closing it with the book.
  useEffect(() => {
    if (!listenOpen) {
      teardown()
      send({ type: 'closed' })
    }
  }, [listenOpen, teardown, send])

  useEffect(() => {
    session.current?.player.specChanged()
  }, [voice, speed])

  const { phase, retryArmed } = state
  useEffect(() => {
    if (phase.kind !== 'error' || retryArmed) return
    const timer = setTimeout(() => send({ type: 'retry-armed' }), RETRY_DELAY_MS)
    return () => clearTimeout(timer)
  }, [phase, retryArmed, send])

  return {
    phase: state.phase,
    notice: state.notice,
    retryReady: state.phase.kind === 'error' && state.phase.canRetry && state.retryArmed,
    play,
    pause,
    resume,
    skip,
    download,
    cancelDownload,
    retry,
    close,
    onRelocate
  }
}
