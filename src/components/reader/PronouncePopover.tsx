import { useCallback, useEffect, useRef, useState } from 'react'
import type { LexiconEntryView, LexiconRead } from '@shared/lexicon.types'
import type { TtsAudio } from '@shared/tts.types'
import { pcmToFloat32 } from '@/lib/speech-player'
import { notifyError } from '@/lib/notify'
import { useReaderStore } from '@/stores/reader.store'
import type { SelectionRect } from './SelectionChip'

/**
 * **Pronounce…** — the lexicon's one surface (voice reader spec D8; slice annex
 * `docs/superpowers/plans/2026-10-22-voice-reader-lexicon.md`, R3/R8).
 *
 * Select a word, press Pronounce…, and this shows the word, a "sounds like" field, a
 * **Preview**, and **Save**; a word that already has a respelling opens in the same
 * popover with the field filled and a **Delete**. Preview exists because a respelling can
 * come out slightly wrong and the cure is hearing it, not reasoning about it — so it is
 * the safeguard, and it deliberately runs the *saved* path (`tts.preview` speaks the word
 * with a one-entry lexicon, not the respelling's letters).
 *
 * It floats like the chip that opens it — `fixed`, in the selection's own viewport
 * coordinates, `app-no-drag` because the rect can land in the reader's draggable top band
 * (`docs/invariants/reader.md`). The word itself is not editable: the gesture that named
 * it was the selection, and a field here would be a second way to misspell the name.
 */

interface Props {
  word: string
  rect: SelectionRect
  onClose(): void
}

/** Roughly the box's own width, used only to keep it on screen. */
const WIDTH = 272
const GAP = 8

/**
 * Speak one synthesized buffer and resolve when it has finished — its own short-lived
 * `AudioContext`, closed afterwards, so Preview works whether or not a listening session
 * is running and never touches the speech player's clock.
 */
async function playOnce(audio: TtsAudio): Promise<void> {
  const samples = pcmToFloat32(audio.samples)
  if (samples.length === 0) return
  const context = new AudioContext()
  try {
    await context.resume()
    const buffer = context.createBuffer(1, samples.length, audio.sampleRate)
    buffer.getChannelData(0).set(samples)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    await new Promise<void>((resolve) => {
      source.onended = () => resolve()
      source.start()
    })
  } finally {
    void context.close()
  }
}

export function PronouncePopover({ word, rect, onClose }: Props) {
  const voice = useReaderStore((s) => s.prefs.voice)
  const speed = useReaderStore((s) => s.prefs.speed)

  /** `undefined` while the list is being read; `null` when this word has no entry. */
  const [existing, setExisting] = useState<LexiconEntryView | null | undefined>(undefined)
  const [soundsLike, setSoundsLike] = useState('')
  const [reading, setReading] = useState<LexiconRead['state'] | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [saving, setSaving] = useState(false)
  const fieldRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let disposed = false
    void window.Musaeum.lexicon
      .list()
      .then((read) => {
        if (disposed) return
        setReading(read.state)
        const found = read.entries.find((entry) => entry.word === word) ?? null
        setExisting(found)
        if (found) setSoundsLike(found.soundsLike)
      })
      .catch(() => {
        // `list` answers a state rather than throwing; a rejection is the bridge itself,
        // and the popover still lets a person save — the write path refuses clearly.
        if (!disposed) setExisting(null)
      })
    return () => {
      disposed = true
    }
  }, [word])

  useEffect(() => {
    // The field is the only control here, so it takes the focus — a keyboard selection
    // that ends here should not need a second gesture to start typing.
    fieldRef.current?.focus()
  }, [])

  const canSpeak = soundsLike.trim().length > 0

  const preview = useCallback(async () => {
    if (!canSpeak || previewing) return
    setPreviewing(true)
    try {
      await playOnce(await window.Musaeum.tts.preview({ word, soundsLike, voice, speed }))
    } catch (err) {
      notifyError(err)
    } finally {
      setPreviewing(false)
    }
  }, [canSpeak, previewing, soundsLike, voice, speed, word])

  const save = useCallback(async () => {
    if (!canSpeak || saving) return
    setSaving(true)
    try {
      await window.Musaeum.lexicon.save({ word, soundsLike })
      onClose()
    } catch (err) {
      notifyError(err)
    } finally {
      setSaving(false)
    }
  }, [canSpeak, saving, word, soundsLike, onClose])

  const remove = useCallback(async () => {
    if (saving) return
    setSaving(true)
    try {
      await window.Musaeum.lexicon.remove(word)
      onClose()
    } catch (err) {
      notifyError(err)
    } finally {
      setSaving(false)
    }
  }, [saving, word, onClose])

  const left = Math.min(
    Math.max(rect.left + rect.width / 2, WIDTH / 2 + 8),
    window.innerWidth - WIDTH / 2 - 8
  )
  const buttonClass =
    'app-no-drag rounded-md border border-gold-500/50 bg-ink-900 px-2.5 py-1 text-[11px] font-medium text-gold-300 transition-colors hover:bg-ink-800 disabled:opacity-40'

  return (
    <>
      {/* Click-to-dismiss over the whole reader, transparent: the page stays visible while
          a respelling is being heard, and a click anywhere else puts the popover away. */}
      <div className="fixed inset-0 z-10" onClick={onClose} onContextMenu={onClose} />
      <div
        role="dialog"
        aria-label={`Pronounce “${word}”`}
        className="app-no-drag fixed z-20 w-[272px] space-y-2.5 rounded-xl border border-ink-700 bg-ink-900 p-3 shadow-cover-lift"
        style={{ left, top: rect.top + rect.height + GAP, transform: 'translateX(-50%)' }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
        }}
      >
        <p className="font-display text-[13px] text-parchment">{word}</p>
        <label className="block space-y-1">
          <span className="text-[10px] uppercase tracking-wide text-parchment-faint">
            Sounds like
          </span>
          <input
            ref={fieldRef}
            value={soundsLike}
            onChange={(event) => setSoundsLike(event.target.value)}
            placeholder="HAY-gul"
            aria-label="Sounds like"
            spellCheck={false}
            className="w-full rounded-md border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-[12px] text-parchment placeholder:text-parchment-faint focus:border-gold-500/50 focus:outline-none"
            onKeyDown={(event) => {
              // Enter previews rather than saves: hearing it first is the point.
              if (event.key === 'Enter') void preview()
            }}
          />
        </label>
        <p className="text-[10px] leading-snug text-parchment-faint">
          Capitals carry the stress — <span className="text-parchment-dim">HAY-gul</span>.
        </p>
        {reading === 'unreadable' && (
          <p className="text-[10px] leading-snug text-gold-300">
            The pronunciation list could not be read, so saving will be refused until it is
            repaired.
          </p>
        )}
        <div className="flex items-center gap-1.5 pt-0.5">
          <button
            type="button"
            className={buttonClass}
            disabled={!canSpeak || previewing}
            onClick={() => void preview()}
            title="Hear this respelling in the current voice"
          >
            {previewing ? 'Speaking…' : 'Preview'}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={!canSpeak || saving}
            onClick={() => void save()}
            title="Save this pronunciation for the whole library"
          >
            Save
          </button>
          {existing && (
            <button
              type="button"
              className="app-no-drag ml-auto rounded-md px-2 py-1 text-[11px] text-parchment-faint transition-colors hover:text-parchment disabled:opacity-40"
              disabled={saving}
              onClick={() => void remove()}
              title="Delete this pronunciation"
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </>
  )
}
