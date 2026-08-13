import { useMemo, useState } from 'react'
import type { ReadStatus } from '@shared/book.types'
import { readableFormat, seriesDisplay } from '@shared/book.types'
import { useDeviceStore } from '@/stores/device.store'
import { useLibraryStore } from '@/stores/library.store'
import { useNASStore } from '@/stores/nas.store'
import { useReaderStore } from '@/stores/reader.store'
import { useUIStore } from '@/stores/ui.store'
import { CoverFallback, coverUrl } from './BookCard'
import {
  CheckIcon,
  CloseIcon,
  FolderIcon,
  PencilIcon,
  ReaderIcon,
  RefreshIcon,
  SendIcon,
  StarIcon,
  TrashIcon
} from '@/components/shared/icons'

const READ_STATUS_OPTIONS: { value: ReadStatus; label: string }[] = [
  { value: 'unread', label: 'Unread' },
  { value: 'reading', label: 'Reading' },
  { value: 'read', label: 'Read' }
]

export function BookDetail() {
  const selectedBookId = useUIStore((s) => s.selectedBookId)
  const selectBook = useUIStore((s) => s.selectBook)
  const books = useLibraryStore((s) => s.books)
  const load = useLibraryStore((s) => s.load)
  const devices = useDeviceStore((s) => s.devices)
  const onDevice = useDeviceStore((s) => s.onDevice)
  const sendToDevice = useDeviceStore((s) => s.sendToDevice)
  const online = useNASStore((s) => s.status?.state === 'connected')
  const requestDelete = useUIStore((s) => s.requestDelete)
  const requestEdit = useUIStore((s) => s.requestEdit)
  const requestDeviceRemoval = useUIStore((s) => s.requestDeviceRemoval)
  const [busy, setBusy] = useState<string | null>(null)

  const book = useMemo(
    () => books.find((b) => b.id === selectedBookId) ?? null,
    [books, selectedBookId]
  )
  if (!book) return null
  const full = coverUrl(book, 'full')

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    try {
      await fn()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <aside className="flex w-[360px] shrink-0 animate-slide-in-right flex-col border-l border-ink-800 bg-ink-900 shadow-panel">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-ink-800 px-4">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-parchment-faint">
          Details
        </span>
        <button
          onClick={() => selectBook(null)}
          className="rounded p-1 text-parchment-faint hover:bg-ink-800 hover:text-parchment"
          aria-label="Close details"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto aspect-[2/3] w-44 overflow-hidden rounded-md shadow-cover ring-1 ring-white/5">
          {full ? (
            <img src={full} alt="" className="h-full w-full object-cover" draggable={false} />
          ) : (
            <CoverFallback book={book} large />
          )}
        </div>

        <h2 className="mt-4 text-center font-display text-xl leading-snug text-parchment">
          {book.title}
        </h2>
        {book.author && (
          <p className="mt-1 text-center text-sm text-parchment-dim">{book.author}</p>
        )}
        {book.seriesName && (
          <p className="mt-1 text-center text-[13px] italic text-gold-400">
            {seriesDisplay(book.seriesName, book.seriesIndex)}
            {book.seriesTotal ? ` of ${book.seriesTotal}` : ''}
          </p>
        )}

        {/* Rating */}
        <div className="mt-3 flex justify-center gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              onClick={() =>
                void window.Musaeum.library
                  .updateBook(book.id, { rating: book.rating === n ? null : n })
                  .then(load)
              }
              className={`transition-colors ${
                book.rating && n <= book.rating
                  ? 'text-gold-400'
                  : 'text-ink-600 hover:text-gold-500/60'
              }`}
              aria-label={`Rate ${n} star${n > 1 ? 's' : ''}`}
            >
              <StarIcon className="h-5 w-5" filled={!!book.rating && n <= book.rating} />
            </button>
          ))}
        </div>

        {/* Formats + status */}
        <div className="mt-4 flex items-center justify-center gap-2">
          {/* Each badge opens that file in the system default app — the way to
              read a PDF without routing it through Apple Books */}
          {book.formats.map((f) => (
            <button
              key={f}
              disabled={!online}
              onClick={() => void run('open', () => window.Musaeum.files.openBookFile(book.id, f))}
              title={`Open ${f.toUpperCase()}`}
              className="rounded border border-ink-600 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-parchment-faint transition-colors hover:border-gold-500/50 hover:text-gold-300 disabled:opacity-40 disabled:hover:border-ink-600 disabled:hover:text-parchment-faint"
            >
              {f}
            </button>
          ))}
          <select
            value={book.readStatus}
            onChange={(e) =>
              void window.Musaeum.library
                .updateBook(book.id, { readStatus: e.target.value as ReadStatus })
                .then(load)
            }
            className="rounded border border-ink-600 bg-ink-850 px-1.5 py-0.5 text-[11px] text-parchment-dim"
          >
            {READ_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {book.description && (
          <p className="mt-5 whitespace-pre-line text-[13px] leading-relaxed text-parchment-dim">
            {book.description}
          </p>
        )}

        {book.tags.length > 0 && (
          <div className="mt-4 flex flex-wrap justify-center gap-1.5">
            {book.tags.map((t) => (
              <span
                key={t}
                className="rounded-full bg-ink-800 px-2 py-0.5 text-[11px] text-parchment-faint"
              >
                {t}
              </span>
            ))}
          </div>
        )}

        <dl className="mt-5 space-y-1 border-t border-ink-800 pt-4 text-[12px]">
          {book.publisher && <Meta label="Publisher" value={book.publisher} />}
          {book.publishedDate && <Meta label="Published" value={book.publishedDate} />}
          {book.isbn13 && <Meta label="ISBN-13" value={book.isbn13} />}
          {book.language && <Meta label="Language" value={book.language.toUpperCase()} />}
          {book.fileSizeBytes != null && (
            <Meta label="Size" value={`${(book.fileSizeBytes / 1_048_576).toFixed(1)} MB`} />
          )}
          {book.dateAdded && <Meta label="Added" value={book.dateAdded.slice(0, 10)} />}
        </dl>
      </div>

      {/* Actions */}
      <div className="shrink-0 space-y-2 border-t border-ink-800 p-4">
        {devices.map((d) => {
          const present = onDevice[d.id]?.includes(book.id) ?? false
          return (
            <div key={d.id} className="flex gap-2">
              <button
                disabled={!online || busy !== null}
                onClick={() => void run('send', () => sendToDevice(book.id, d.id))}
                title={present ? `Send to ${d.name} again` : undefined}
                className="flex flex-1 items-center justify-center gap-2 rounded-md bg-gold-500 px-3 py-2 text-[13px] font-semibold text-ink-950 hover:bg-gold-400 disabled:opacity-40"
              >
                {present ? <CheckIcon className="h-4 w-4" /> : <SendIcon className="h-4 w-4" />}
                {present ? `On ${d.name}` : `Send to ${d.name}`}
              </button>
              {/* Removal needs no NAS — it only touches the device */}
              {present && (
                <button
                  disabled={busy !== null}
                  onClick={() => requestDeviceRemoval({ bookId: book.id, deviceId: d.id })}
                  title={`Remove from ${d.name}`}
                  aria-label={`Remove from ${d.name}`}
                  className="rounded-md border border-ink-600 px-2.5 text-parchment-dim hover:border-red-500/60 hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              )}
            </div>
          )
        })}
        {/* Gold-outlined rather than solid: the way into a book, but not in
            competition with sending it to a device. A book the engine can't
            render still belongs here — `openBook` hands those to the OS.
            Deliberately *not* gated on `online` like its neighbours: those are
            writes, this is a read. Offline the bytes are unreachable whichever
            entry point is used, and the reader's error state says so and offers
            "Open externally" — better than a dead button with nothing to
            explain it, and it makes all four entry points behave alike. */}
        <button
          disabled={busy !== null || book.formats.length === 0}
          onClick={() => useReaderStore.getState().openBook(book)}
          title={readableFormat(book) ? 'Read in Musaeum' : 'Open in the default app'}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-gold-500/40 px-3 py-2 text-[13px] font-semibold text-gold-300 hover:border-gold-500 hover:bg-gold-500/10 disabled:opacity-40"
        >
          <ReaderIcon className="h-4 w-4" />
          Read
        </button>
        <div className="flex gap-2">
          <button
            disabled={!online || busy !== null || !book.formats.includes('epub')}
            onClick={() =>
              void run('books', () => window.Musaeum.devices.exportToAppleBooks(book.id))
            }
            className="flex-1 rounded-md border border-ink-600 px-3 py-1.5 text-[12px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40"
          >
            Apple Books
          </button>
          <button
            disabled={!online || busy !== null}
            onClick={() => requestEdit(book.id)}
            title="Edit metadata"
            className="rounded-md border border-ink-600 px-2.5 py-1.5 text-parchment-dim hover:bg-ink-800 hover:text-gold-300 disabled:opacity-40"
          >
            <PencilIcon className="h-4 w-4" />
          </button>
          <button
            disabled={!online || busy !== null}
            onClick={() => void run('reveal', () => window.Musaeum.files.revealBook(book.id))}
            title="Show in Finder"
            className="rounded-md border border-ink-600 px-2.5 py-1.5 text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40"
          >
            <FolderIcon className="h-4 w-4" />
          </button>
          <button
            disabled={!online || busy !== null}
            onClick={() => void run('rehydrate', () => window.Musaeum.metadata.rehydrateBook(book.id))}
            title="Re-fetch metadata"
            className="rounded-md border border-ink-600 px-2.5 py-1.5 text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40"
          >
            <RefreshIcon className="h-4 w-4" />
          </button>
          <button
            disabled={!online || busy !== null}
            onClick={() => requestDelete(book.id)}
            title={book.formats.length > 1 ? 'Delete book or formats' : 'Delete book'}
            className="rounded-md border border-ink-600 px-2.5 py-1.5 text-parchment-dim hover:bg-ink-800 hover:text-red-400 disabled:opacity-40"
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-parchment-faint">{label}</dt>
      <dd className="truncate text-parchment-dim">{value}</dd>
    </div>
  )
}
