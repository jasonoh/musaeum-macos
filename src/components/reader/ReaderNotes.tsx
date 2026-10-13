import { useEffect, useState } from 'react'
import type { KeyboardEvent, MutableRefObject } from 'react'
import type { FoliateView } from '@vendor/foliate-js/view.js'
import { annotationGroups } from '@/lib/annotations'
import { useReaderStore } from '@/stores/reader.store'
import { CloseIcon, NotesIcon } from '@/components/shared/icons'

/**
 * The Notes panel — the reader's one side slot's **fourth** occupant (spec D8.2).
 *
 * Thin on purpose, the shape `ReaderSearch` has: the grouping, the document
 * order and the draw plan are `src/lib/annotations.ts`'s, where vitest can decide
 * them; this file lays out the states, the list and the editor.
 *
 * Two things live here and nowhere else: the panel's own key handling (it owns
 * the keys while focus is inside it, as the find panel does), and the note
 * *draft* — which is deliberately not a store field, for the reason the ask
 * panel's composer is not one either: a keystroke is not a product decision, and
 * a store that held one would notify every subscriber per letter.
 */
export function ReaderNotes({ viewRef }: { viewRef: MutableRefObject<FoliateView | null> }) {
  const bookId = useReaderStore((s) => s.bookId)
  const format = useReaderStore((s) => s.format)
  const annotations = useReaderStore((s) => s.annotations)
  const state = useReaderStore((s) => s.annotationsState)
  const loading = useReaderStore((s) => s.annotationsLoading)
  const activeId = useReaderStore((s) => s.activeAnnotationId)
  const load = useReaderStore((s) => s.loadAnnotations)
  const setActive = useReaderStore((s) => s.setActiveAnnotation)
  const saveNote = useReaderStore((s) => s.saveAnnotationNote)
  const removeHighlight = useReaderStore((s) => s.deleteHighlight)
  const close = useReaderStore((s) => s.closeNotes)

  /**
   * The read happens when the panel opens, for the book that is open.
   *
   * Keyed on the pair rather than run once: a panel left standing while another
   * book is opened must not show the first book's notes, and `openBook` has
   * already emptied the list — this is what fills it again.
   */
  useEffect(() => {
    void load()
  }, [load, bookId, format])

  const active = annotations.find((annotation) => annotation.id === activeId) ?? null
  const groups = annotationGroups(annotations)

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    // Every other unmodified key stops here, so Space on one of the panel's own
    // controls is a press rather than also a page turn underneath — the same
    // rule the find panel carries, and for the same reason.
    if (!event.metaKey && !event.ctrlKey && !event.altKey) event.stopPropagation()
  }

  return (
    <aside
      onKeyDown={onKeyDown}
      className="flex w-72 shrink-0 flex-col border-r border-ink-800 bg-ink-950"
    >
      <div className="flex shrink-0 items-center justify-between px-5 pb-2 pt-4">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-parchment-faint">
          <NotesIcon className="h-3.5 w-3.5" />
          Notes
        </span>
        <button
          onClick={close}
          title="Close (Esc)"
          aria-label="Close notes"
          className="rounded p-1 text-parchment-faint hover:bg-ink-800 hover:text-parchment"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        {loading ? (
          <p className="px-5 pt-1 text-[13px] italic text-parchment-faint">Reading your notes…</p>
        ) : state === 'unreadable' ? (
          // The state slice 1's R3 was settled for: this is *not* the empty
          // list's sentence, because the person's notes are still on the share
          // and saying nothing would read as "you never wrote one".
          <p className="mx-4 mt-1 rounded-md border border-ink-700 px-2.5 py-2 text-[12px] leading-snug text-parchment-dim">
            Your notes are still on disk — they just could not be read.
          </p>
        ) : annotations.length === 0 ? (
          <p className="px-5 pt-1 text-[13px] italic text-parchment-faint">
            No highlights in this book yet. Select some text to mark it.
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.label}>
              <div className="flex items-baseline justify-between gap-2 px-5 pb-1 pt-3">
                <span className="truncate text-[11px] font-semibold uppercase tracking-widest text-parchment-faint">
                  {group.label}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-parchment-faint">
                  {group.items.length}
                </span>
              </div>
              <ul>
                {group.items.map((annotation) => {
                  const isActive = annotation.id === activeId
                  return (
                    <li key={annotation.id}>
                      <button
                        onClick={() => {
                          setActive(annotation.id)
                          // A stale `cfi` points into a document the reader is
                          // not serving: it is listed with its quote and never
                          // navigated to (spec D6). `goTo` returns `undefined`
                          // rather than rejecting, so there is nothing to catch.
                          if (!annotation.stale) void viewRef.current?.goTo(annotation.cfi)
                        }}
                        title={annotation.quote}
                        className={`w-full border-l-2 px-4 py-1.5 text-left text-[12px] leading-snug transition-colors ${
                          isActive
                            ? 'border-gold-500 bg-ink-900 text-parchment'
                            : 'border-transparent text-parchment-dim hover:bg-ink-900 hover:text-parchment'
                        }`}
                      >
                        <span className="line-clamp-3">{annotation.quote}</span>
                        {annotation.note && (
                          <span className="mt-0.5 block line-clamp-2 italic text-parchment-faint">
                            {annotation.note}
                          </span>
                        )}
                        {annotation.stale && (
                          <span className="mt-1 block text-[10px] uppercase tracking-wider text-parchment-faint">
                            Not drawn — the book was re-prepared
                          </span>
                        )}
                      </button>
                      {isActive && (
                        // Keyed on the row *and* its stored note, so the box is
                        // re-seeded by a save, by a delete-and-undo elsewhere, or
                        // by the other Mac's note arriving in a later answer —
                        // and never while the person is typing, because neither
                        // half of the key moves on a keystroke.
                        <NoteEditor
                          key={`${annotation.id}:${annotation.note ?? ''}`}
                          note={annotation.note}
                          onSave={(note) => void saveNote(annotation.id, note)}
                          onDelete={() => void removeHighlight(annotation.id)}
                        />
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          ))
        )}
      </div>

      {active && (
        <p className="shrink-0 border-t border-ink-800 px-5 py-2 text-[11px] text-parchment-faint">
          {active.percent > 0 ? `${Math.round(active.percent * 100)}% through the book` : 'Marked'}
        </p>
      )}
    </aside>
  )
}

/**
 * The active row's editor.
 *
 * **Save appears only when the text actually changed** (D8), which is the guard
 * `settings-and-editing.md:83` and `field-overrides` both carry: a control that
 * can write the value it already holds makes a write mean nothing, and here it
 * would stamp `updated_at` on a re-save. `Delete` is beside it rather than
 * behind a menu — it is one row in a panel, and undo is not in v1.
 */
function NoteEditor({
  note,
  onSave,
  onDelete
}: {
  note: string | null
  onSave(note: string | null): void
  onDelete(): void
}) {
  const [draft, setDraft] = useState(note ?? '')
  // Main trims the note and stores a blank one as `null` (slice 1's R4), so the
  // comparison is against the trimmed draft: whitespace is not a change.
  const changed = draft.trim() !== (note ?? '')

  return (
    <div className="px-4 pb-3 pt-1">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={3}
        placeholder="Write a note…"
        aria-label="Note"
        className="w-full resize-y rounded-md border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-[12px] leading-snug text-parchment placeholder:text-parchment-faint focus:border-gold-500/50 focus:outline-none"
      />
      <div className="flex items-center justify-between pt-1.5">
        <button
          onClick={onDelete}
          className="rounded px-1.5 py-0.5 text-[11px] text-parchment-faint transition-colors hover:bg-ink-800 hover:text-danger-400"
        >
          Delete
        </button>
        {changed && (
          <button
            onClick={() => onSave(draft)}
            className="rounded-md border border-gold-500/50 px-2 py-0.5 text-[11px] text-gold-300 transition-colors hover:bg-ink-800"
          >
            Save
          </button>
        )}
      </div>
    </div>
  )
}
