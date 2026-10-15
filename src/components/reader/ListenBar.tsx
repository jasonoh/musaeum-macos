import type { SpeechApi } from '@/hooks/useSpeech'
import { useReaderStore } from '@/stores/reader.store'
import { TTS_SPEED_MAX, TTS_SPEED_MIN, TTS_VOICES, clampTtsSpeed } from '@shared/tts.types'
import {
  CloseIcon,
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon
} from '@/components/shared/icons'

/**
 * The voice reader's transport (spec D4, D6): a slim row at the bottom of the reader column.
 *
 * It is **not** a fifth occupant of the side slot — the table of contents, search, notes and ask
 * panels stay open beside it (AC18). Every state the voice can be in is one line in this row,
 * never a toast: the download offer, its progress, the damaged-voice line, the offline sentence,
 * and the error with its Retry.
 *
 * **Pressing a control must not take focus.** The reader's page-turn keys live on the window and
 * the book's frames; a button that held focus would swallow Space as a press of itself. So every
 * button prevents the mousedown's focus move (the way the selection chip does), and the select,
 * which has to take focus to open, gives it back when it changes.
 */
const SPEED_STEP = 0.1

const noFocus = (e: { preventDefault(): void }) => e.preventDefault()

const iconButton =
  'rounded p-1.5 text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40'
const textButton =
  'rounded-md border border-ink-600 px-2.5 py-1 text-[11px] text-parchment-dim hover:border-gold-500/50 hover:text-gold-300 disabled:opacity-40'

export function ListenBar({ speech }: { speech: SpeechApi }) {
  const voice = useReaderStore((s) => s.prefs.voice)
  const speed = useReaderStore((s) => s.prefs.speed)
  const setPrefs = useReaderStore((s) => s.setPrefs)
  const { phase } = speech

  const playing = phase.kind === 'playing' || phase.kind === 'loading'
  const transport =
    phase.kind === 'idle' ||
    phase.kind === 'playing' ||
    phase.kind === 'paused' ||
    phase.kind === 'loading'

  let line: React.ReactNode = null
  if (phase.kind === 'needs-model') {
    line = (
      <>
        {speech.notice && <span className="text-parchment-dim">{speech.notice}</span>}
        <button
          type="button"
          onMouseDown={noFocus}
          onClick={() => void speech.download()}
          className={textButton}
        >
          Download the voice (120 MB)
        </button>
      </>
    )
  } else if (phase.kind === 'downloading') {
    const fraction = phase.total > 0 ? Math.min(1, phase.completed / phase.total) : 0
    line = (
      <>
        <span className="text-parchment-dim">
          Downloading the voice… {Math.round(fraction * 100)}%
        </span>
        <span className="h-1 w-40 overflow-hidden rounded bg-ink-800">
          <span
            className="block h-full bg-gold-500 transition-[width] duration-200"
            style={{ width: `${Math.round(fraction * 100)}%` }}
          />
        </span>
        <button
          type="button"
          onMouseDown={noFocus}
          onClick={() => speech.cancelDownload()}
          className={textButton}
        >
          Cancel
        </button>
      </>
    )
  } else if (phase.kind === 'offline-no-model') {
    line = (
      <span className="text-parchment-dim">
        The voice has to be downloaded once, and this Mac is offline.
      </span>
    )
  } else if (phase.kind === 'error') {
    line = (
      <>
        <span className="min-w-0 truncate text-parchment-dim">{phase.message}</span>
        {phase.canRetry && speech.retryReady && (
          <button
            type="button"
            onMouseDown={noFocus}
            onClick={() => speech.retry()}
            className={textButton}
          >
            Retry
          </button>
        )}
      </>
    )
  } else if (phase.kind === 'idle' && speech.notice) {
    line = <span className="text-parchment-dim">{speech.notice}</span>
  }

  return (
    <div
      role="toolbar"
      aria-label="Listen"
      className="flex shrink-0 items-center gap-1 border-t border-ink-800 bg-ink-900 px-3 py-1 text-[11px]"
    >
      <button
        type="button"
        title="Previous sentence"
        aria-label="Previous sentence"
        disabled={!transport}
        onMouseDown={noFocus}
        onClick={() => speech.skip(-1)}
        className={iconButton}
      >
        <SkipBackIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        title={playing ? 'Pause' : 'Play'}
        aria-label={playing ? 'Pause' : 'Play'}
        disabled={phase.kind === 'downloading'}
        onMouseDown={noFocus}
        onClick={() => {
          if (playing) speech.pause()
          else void speech.play()
        }}
        className={`${iconButton} text-gold-300`}
      >
        {playing ? <PauseIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
      </button>
      <button
        type="button"
        title="Next sentence"
        aria-label="Next sentence"
        disabled={!transport}
        onMouseDown={noFocus}
        onClick={() => speech.skip(1)}
        className={iconButton}
      >
        <SkipForwardIcon className="h-4 w-4" />
      </button>

      <div className="mx-2 flex min-w-0 flex-1 items-center gap-2">{line}</div>

      <button
        type="button"
        title="Slower"
        aria-label="Slower"
        disabled={speed <= TTS_SPEED_MIN}
        onMouseDown={noFocus}
        onClick={() => setPrefs({ speed: clampTtsSpeed(speed - SPEED_STEP) })}
        className={iconButton}
      >
        −
      </button>
      <span className="w-9 text-center tabular-nums text-parchment-dim" aria-label="Speed">
        {speed.toFixed(1)}×
      </span>
      <button
        type="button"
        title="Faster"
        aria-label="Faster"
        disabled={speed >= TTS_SPEED_MAX}
        onMouseDown={noFocus}
        onClick={() => setPrefs({ speed: clampTtsSpeed(speed + SPEED_STEP) })}
        className={iconButton}
      >
        +
      </button>
      <select
        aria-label="Voice"
        value={voice}
        onChange={(e) => {
          setPrefs({ voice: e.target.value as (typeof TTS_VOICES)[number] })
          e.target.blur()
        }}
        className="rounded border border-ink-700 bg-ink-800 px-1.5 py-0.5 text-[11px] text-parchment-dim"
      >
        {TTS_VOICES.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
      <button
        type="button"
        title="Close (L)"
        aria-label="Close listen bar"
        onMouseDown={noFocus}
        onClick={() => speech.close()}
        className={iconButton}
      >
        <CloseIcon className="h-4 w-4" />
      </button>
    </div>
  )
}
