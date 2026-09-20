import { useEffect, useMemo, useState } from 'react'
import type { Book } from '@shared/book.types'
import { sortableAuthor, sortableTitle } from '@shared/book.types'
import type { HydratedField } from '@shared/metadata.types'
import { HYDRATED_FIELD_LABELS, HYDRATED_KEY_FIELD } from '@shared/metadata.types'
import { useLibraryStore } from '@/stores/library.store'
import { useNASStore } from '@/stores/nas.store'
import { useUIStore } from '@/stores/ui.store'
import { LockIcon, SpinnerIcon } from '@/components/shared/icons'

/**
 * Direct metadata editing — the manual counterpart to hydration, for the cases
 * automation can't reach: a wrong title baked into the file, a series the
 * fetchers didn't find, an edition mismatch.
 *
 * Every field is a string in form state and converted on save, so a half-typed
 * series index can't corrupt the book. Only fields the user actually changed
 * are sent, so a save can't clobber a value hydration filled in meanwhile.
 * Sort keys left blank fall back to the derived form (shown as placeholder).
 *
 * A field the user changed here is *theirs* from then on: it is recorded as an
 * override and a metadata fetch will not touch it. This panel is therefore also
 * where that is undone — the padlock beside a held field hands it back without
 * changing its value (see `docs/superpowers/specs/2026-09-20-field-overrides-design.md`).
 */

interface FormState {
  title: string
  sortTitle: string
  author: string
  authorSort: string
  seriesName: string
  seriesIndex: string
  seriesTotal: string
  publisher: string
  publishedDate: string
  language: string
  description: string
  tags: string
  isbn10: string
  isbn13: string
  goodreadsId: string
  openlibraryId: string
}

const EMPTY_FORM: FormState = {
  title: '',
  sortTitle: '',
  author: '',
  authorSort: '',
  seriesName: '',
  seriesIndex: '',
  seriesTotal: '',
  publisher: '',
  publishedDate: '',
  language: '',
  description: '',
  tags: '',
  isbn10: '',
  isbn13: '',
  goodreadsId: '',
  openlibraryId: ''
}

/**
 * A sort key that merely matches the derived form isn't a user choice, so it
 * starts blank — the placeholder tracks the title/author being typed and the
 * save re-derives it. Renaming a book therefore fixes its sort key instead of
 * stranding the old one. A genuinely custom key is shown and left alone.
 */
function customOnly(stored: string | null, derived: string | null): string {
  return stored && stored !== derived ? stored : ''
}

function toForm(book: Book): FormState {
  return {
    title: book.title,
    sortTitle: customOnly(book.sortTitle, sortableTitle(book.title)),
    author: book.author ?? '',
    authorSort: customOnly(book.authorSort, sortableAuthor(book.author)),
    seriesName: book.seriesName ?? '',
    seriesIndex: book.seriesIndex == null ? '' : String(book.seriesIndex),
    seriesTotal: book.seriesTotal == null ? '' : String(book.seriesTotal),
    publisher: book.publisher ?? '',
    publishedDate: book.publishedDate ?? '',
    language: book.language ?? '',
    description: book.description ?? '',
    tags: book.tags.join(', '),
    isbn10: book.isbn10 ?? '',
    isbn13: book.isbn13 ?? '',
    goodreadsId: book.goodreadsId ?? '',
    openlibraryId: book.openlibraryId ?? ''
  }
}

const trimmed = (s: string): string | null => (s.trim() ? s.trim() : null)

/** Form values → the Book fields they map to, with blanks normalized to null. */
function toBookFields(form: FormState): Partial<Book> {
  const title = form.title.trim()
  const author = trimmed(form.author)
  const seriesName = trimmed(form.seriesName)
  const index = Number.parseFloat(form.seriesIndex)
  const total = Number.parseInt(form.seriesTotal, 10)
  return {
    title,
    sortTitle: trimmed(form.sortTitle) ?? sortableTitle(title),
    author,
    authorSort: trimmed(form.authorSort) ?? sortableAuthor(author),
    // A book with no series name has no index or total either
    seriesName,
    seriesIndex: seriesName && Number.isFinite(index) ? index : null,
    seriesTotal: seriesName && Number.isFinite(total) ? total : null,
    publisher: trimmed(form.publisher),
    publishedDate: trimmed(form.publishedDate),
    language: trimmed(form.language),
    description: trimmed(form.description),
    tags: form.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    isbn10: trimmed(form.isbn10),
    isbn13: trimmed(form.isbn13),
    goodreadsId: trimmed(form.goodreadsId),
    openlibraryId: trimmed(form.openlibraryId)
  }
}

/** Only the fields whose value differs from the book as loaded. */
function changedFields(book: Book, next: Partial<Book>): Partial<Book> {
  const updates: Partial<Book> = {}
  for (const [key, value] of Object.entries(next) as [keyof Book, unknown][]) {
    const current = book[key]
    const same = Array.isArray(value)
      ? JSON.stringify(value) === JSON.stringify(current)
      : value === current
    if (!same) Object.assign(updates, { [key]: value })
  }
  return updates
}

export function BookEditor() {
  const bookId = useUIStore((s) => s.editingBookId)
  const requestEdit = useUIStore((s) => s.requestEdit)
  const books = useLibraryStore((s) => s.books)
  const load = useLibraryStore((s) => s.load)
  const online = useNASStore((s) => s.status?.state === 'connected')

  const book = useMemo(() => books.find((b) => b.id === bookId) ?? null, [books, bookId])
  // Mounted under a per-book key, so this initializer re-runs for each book
  const [form, setForm] = useState<FormState>(() => {
    const b = books.find((x) => x.id === bookId)
    return b ? toForm(b) : EMPTY_FORM
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * The fields this book's fetches must not touch. Read when the panel opens
   * for a book — it is mounted under a per-book key, so each book re-reads its
   * own — and replaced wholesale by a release, which is the only thing that
   * changes it from here.
   */
  const [overridden, setOverridden] = useState<HydratedField[]>([])

  useEffect(() => {
    if (!bookId) return
    let live = true
    void window.Musaeum.library
      .getFieldOverrides(bookId)
      .then((fields) => {
        if (live) setOverridden(fields)
      })
      .catch(() => {
        // Losing this only costs the markers: the override itself is enforced
        // in the main process, not here
        if (live) setOverridden([])
      })
    return () => {
      live = false
    }
  }, [bookId])

  const close = () => requestEdit(null)

  const overriddenFor = (key: keyof Book): HydratedField | null => {
    const field = HYDRATED_KEY_FIELD[key]
    return field && overridden.includes(field) ? field : null
  }

  const releaseOverride = async (field: HydratedField): Promise<void> => {
    if (!book) return
    setOverridden(await window.Musaeum.library.releaseFieldOverride(book.id, field))
  }

  const save = async () => {
    if (!book) return
    const updates = changedFields(book, toBookFields(form))
    if (!Object.keys(updates).length) {
      close()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await window.Musaeum.library.updateBook(book.id, updates)
      await load()
      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) close()
      // ⌘↵ from anywhere in the form, including the description textarea
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // No dep array: re-bound every render so ⌘↵ saves the current form values
  })

  if (!book) return null

  const set = (key: keyof FormState) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }))
  const titleMissing = !form.title.trim()

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-scrim/80 p-8 backdrop-blur-sm"
      onClick={() => !busy && close()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${book.title}`}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-cover-lift"
      >
        <div className="shrink-0 border-b border-ink-800 px-5 py-4">
          <h2 className="font-display text-lg leading-snug text-parchment">Edit metadata</h2>
          <p className="mt-0.5 truncate text-[12px] text-parchment-faint">{book.title}</p>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {overridden.length > 0 && (
            <p className="flex items-start gap-2 rounded-md border border-gold-500/25 bg-gold-500/5 px-3 py-2 text-[12px] leading-relaxed text-parchment-dim">
              <LockIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold-400" />
              <span>
                You set these, so a metadata fetch will not change them:{' '}
                <span className="text-parchment">
                  {overridden.map((f) => HYDRATED_FIELD_LABELS[f]).join(', ')}
                </span>
                . The padlock beside a field hands it back to Musaeum — its value stays.
              </span>
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Title"
              value={form.title}
              onChange={set('title')}
              required
              overridden={overriddenFor('title')}
              onReleaseOverride={releaseOverride}
            />
            <Field
              label="Sort title"
              value={form.sortTitle}
              onChange={set('sortTitle')}
              placeholder={sortableTitle(form.title.trim() || book.title)}
            />
            <Field
              label="Author"
              value={form.author}
              onChange={set('author')}
              overridden={overriddenFor('author')}
              onReleaseOverride={releaseOverride}
            />
            <Field
              label="Author sort"
              value={form.authorSort}
              onChange={set('authorSort')}
              placeholder={sortableAuthor(form.author) ?? '—'}
            />
          </div>

          <div className="grid grid-cols-[1fr_5rem_5rem] gap-3">
            <Field
              label="Series"
              value={form.seriesName}
              onChange={set('seriesName')}
              overridden={overriddenFor('seriesName')}
              onReleaseOverride={releaseOverride}
            />
            <Field
              label="Book #"
              value={form.seriesIndex}
              onChange={set('seriesIndex')}
              disabled={!form.seriesName.trim()}
              placeholder="1"
            />
            <Field
              label="Of"
              value={form.seriesTotal}
              onChange={set('seriesTotal')}
              disabled={!form.seriesName.trim()}
              placeholder="9"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Field
              label="Publisher"
              value={form.publisher}
              onChange={set('publisher')}
              overridden={overriddenFor('publisher')}
              onReleaseOverride={releaseOverride}
            />
            <Field
              label="Published"
              value={form.publishedDate}
              onChange={set('publishedDate')}
              placeholder="2015-09-15"
              overridden={overriddenFor('publishedDate')}
              onReleaseOverride={releaseOverride}
            />
            <Field
              label="Language"
              value={form.language}
              onChange={set('language')}
              placeholder="en"
              overridden={overriddenFor('language')}
              onReleaseOverride={releaseOverride}
            />
          </div>

          <Field
            label="Tags"
            value={form.tags}
            onChange={set('tags')}
            placeholder="science fiction, space opera"
            hint="Comma separated"
            overridden={overriddenFor('tags')}
            onReleaseOverride={releaseOverride}
          />

          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-parchment-faint">
              Description
              {overriddenFor('description') && (
                <OverrideChip field={overriddenFor('description')!} onRelease={releaseOverride} />
              )}
            </span>
            <textarea
              value={form.description}
              onChange={(e) => set('description')(e.target.value)}
              rows={5}
              className="mt-1 w-full resize-y rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[13px] leading-relaxed text-parchment placeholder:text-parchment-faint/50 focus:border-gold-500/60 focus:outline-none focus:ring-1 focus:ring-gold-500/30"
            />
          </label>

          <div className="grid grid-cols-4 gap-3 border-t border-ink-800 pt-4">
            <Field
              label="ISBN-13"
              value={form.isbn13}
              onChange={set('isbn13')}
              overridden={overriddenFor('isbn13')}
              onReleaseOverride={releaseOverride}
            />
            <Field label="ISBN-10" value={form.isbn10} onChange={set('isbn10')} />
            <Field label="Goodreads" value={form.goodreadsId} onChange={set('goodreadsId')} />
            <Field label="OpenLibrary" value={form.openlibraryId} onChange={set('openlibraryId')} />
          </div>

          <p className="text-[11px] leading-relaxed text-parchment-faint">
            Edits are written straight to the book’s metadata.json and the catalog, and a metadata
            fetch will leave them alone — release a field with the padlock to let Musaeum manage it
            again. Renaming a book leaves its files under their original names.
          </p>
        </div>

        <div className="shrink-0 border-t border-ink-800 px-5 py-3">
          {!online && (
            <p className="mb-2 text-[12px] text-danger-400">
              The library is offline — reconnect before saving.
            </p>
          )}
          {error && <p className="mb-2 text-[12px] text-danger-400">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-[11px] text-parchment-faint">⌘↵ to save</span>
            <button
              disabled={busy}
              onClick={close}
              className="rounded-md border border-ink-600 px-3 py-1.5 text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              disabled={busy || !online || titleMissing}
              onClick={() => void save()}
              className="flex items-center gap-2 rounded-md bg-gold-500 px-3 py-1.5 text-[13px] font-semibold text-ink-950 hover:bg-gold-400 disabled:opacity-40"
            >
              {busy && <SpinnerIcon className="h-4 w-4" />}
              Save changes
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * The marker on a field the user holds, and the way out of it.
 *
 * Clicking hands the field back to Musaeum *without* touching its value, which
 * is why it is a padlock labelled "Overridden" rather than an ✕ or a "clear":
 * the gesture releases a decision, it does not undo an edit.
 */
function OverrideChip({
  field,
  onRelease
}: {
  field: HydratedField
  onRelease(field: HydratedField): Promise<void>
}) {
  const [busy, setBusy] = useState(false)

  return (
    <button
      type="button"
      disabled={busy}
      title="Musaeum will not change this — click to hand it back"
      aria-label={`Release the override on ${HYDRATED_FIELD_LABELS[field]}`}
      onClick={(e) => {
        // Inside a <label>, a click would otherwise also focus the input it
        // belongs to — releasing a field is not "put the cursor in it"
        e.preventDefault()
        setBusy(true)
        void onRelease(field).finally(() => setBusy(false))
      }}
      className="ml-1.5 inline-flex items-center gap-1 rounded-full border border-gold-500/40 px-1.5 py-px text-[10px] normal-case tracking-normal text-gold-300 hover:border-gold-500 hover:bg-gold-500/10 disabled:opacity-40"
    >
      <LockIcon className="h-2.5 w-2.5" />
      Overridden
    </button>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  required,
  disabled,
  overridden,
  onReleaseOverride
}: {
  label: string
  value: string
  onChange(value: string): void
  placeholder?: string
  hint?: string
  required?: boolean
  disabled?: boolean
  /** The field the user holds, on the one input that shows it. */
  overridden?: HydratedField | null
  onReleaseOverride?(field: HydratedField): Promise<void>
}) {
  return (
    <label className="block min-w-0">
      <span className="text-[11px] font-semibold uppercase tracking-widest text-parchment-faint">
        {label}
        {hint && <span className="ml-1.5 normal-case tracking-normal opacity-70">{hint}</span>}
        {overridden && onReleaseOverride && (
          <OverrideChip field={overridden} onRelease={onReleaseOverride} />
        )}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={required && !value.trim() ? true : undefined}
        className={`mt-1 w-full rounded-md border bg-ink-850 px-2.5 py-1.5 text-[13px] text-parchment placeholder:text-parchment-faint/50 focus:outline-none focus:ring-1 focus:ring-gold-500/30 disabled:opacity-40 ${
          required && !value.trim()
            ? 'border-danger-500/60 focus:border-danger-500'
            : 'border-ink-700 focus:border-gold-500/60'
        }`}
      />
    </label>
  )
}
