import { useEffect, useMemo, useState } from 'react'
import type { ReadStatus } from '@shared/book.types'
import { readerTarget, seriesDisplay } from '@shared/book.types'
import { sendErrorFor, sendStateFor, useDeviceStore } from '@/stores/device.store'
import { useLibraryStore } from '@/stores/library.store'
import { useNASStore } from '@/stores/nas.store'
import { useReaderStore } from '@/stores/reader.store'
import { useShelvesStore } from '@/stores/shelves.store'
import { selectedBookId, useUIStore } from '@/stores/ui.store'
import { BookCover } from './BookCard'
import {
  CheckIcon,
  CloseIcon,
  FolderIcon,
  PencilIcon,
  ReaderIcon,
  RefreshIcon,
  SendIcon,
  SpinnerIcon,
  StarIcon,
  TrashIcon,
  WarningIcon
} from '@/components/shared/icons'
import { refreshBookMetadata } from '@/lib/metadata-refresh'
import { removeFromShelf } from '@/lib/shelf-membership'
import { descriptionText } from '@/lib/description'
import { notifyError } from '@/lib/notify'

const READ_STATUS_OPTIONS: { value: ReadStatus; label: string }[] = [
  { value: 'unread', label: 'Unread' },
  { value: 'reading', label: 'Reading' },
  { value: 'read', label: 'Read' }
]

export function BookDetail() {
  // The derived single selection: the panel is for one book, and the
  // SelectionPanel takes over when several are selected
  const bookId = useUIStore(selectedBookId)
  const selectBook = useUIStore((s) => s.selectBook)
  const books = useLibraryStore((s) => s.books)
  const load = useLibraryStore((s) => s.load)
  const devices = useDeviceStore((s) => s.devices)
  const onDevice = useDeviceStore((s) => s.onDevice)
  const transfers = useDeviceStore((s) => s.transfers)
  const sendToDevice = useDeviceStore((s) => s.sendToDevice)
  const online = useNASStore((s) => s.status?.state === 'connected')
  const requestDelete = useUIStore((s) => s.requestDelete)
  const requestEdit = useUIStore((s) => s.requestEdit)
  const requestCoverPicker = useUIStore((s) => s.requestCoverPicker)
  const requestDeviceRemoval = useUIStore((s) => s.requestDeviceRemoval)
  // Subscribed per book (a boolean selector), so the panel re-renders when
  // *this* book's refresh starts or ends and not on any other's
  const refreshing = useUIStore((s) => Boolean(bookId && s.refreshingBooks[bookId]))
  const setActiveShelf = useLibraryStore((s) => s.setActiveShelf)
  const revision = useShelvesStore((s) => s.revision)
  const byBook = useShelvesStore((s) => s.byBook)
  const loadForBook = useShelvesStore((s) => s.loadForBook)
  const [busy, setBusy] = useState<string | null>(null)

  const book = useMemo(() => books.find((b) => b.id === bookId) ?? null, [books, bookId])

  // Membership is per book and cached in the shelves store; `revision` moves
  // whenever main says it moved, which is what makes a REST toggle on the phone
  // show up here without a reload (AC23)
  useEffect(() => {
    if (bookId) void loadForBook(bookId)
  }, [bookId, revision, loadForBook])

  if (!book) return null

  const bookShelves = byBook[book.id] ?? []

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    try {
      await fn()
    } catch (err) {
      notifyError(err)
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
        <div className="mx-auto aspect-[2/3] w-44 overflow-hidden rounded-md shadow-cover ring-1 ring-parchment/5">
          <BookCover book={book} size="full" large />
        </div>
        {/* The picker's entry point, sitting directly under the jacket rather
            than over it: the cover is this panel's hero, and a badge pinned to
            its bottom edge would hide part of the artwork on every book, for
            good, to save one line of layout.

            Painted in `parchment` and given the panel's small-control border,
            because it was `parchment-faint` until the owner reported that there
            was "no way to initiate a cover change directly" — measured at
            **2.35:1** on his own theme (Tokyo Night Dark) and **3.99:1** on the
            defaults, against AA's 4.5:1 for text this size. The tier was the
            mistake, not the colour: this palette's audit lets *faint* sit at
            2.2:1 and *dim* at 3.5:1, floors meant for decoration, and a labelled
            control is not decoration. It keeps no background of its own so the
            contrast is measured against the surface it actually rests on, which
            is what `cover-picker-wiring.test.ts` computes. */}
        <button
          onClick={() => requestCoverPicker(book.id)}
          className="mx-auto mt-2 block rounded border border-ink-600 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-parchment transition-colors hover:border-gold-500/50 hover:bg-ink-800 hover:text-gold-300"
        >
          Choose cover
        </button>

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
            {/* Rows written before descriptions were normalised at ingestion
                still hold HTML (see lib/description.ts) */}
            {descriptionText(book.description)}
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

        {/* Shelves (D9, AC20). Chips rather than a list, because a book is on
            several; the same chip tokens as the tags above, and a button rather
            than a span because each one goes somewhere. */}
        <div className="mt-4 flex flex-wrap justify-center gap-1.5">
          {bookShelves.length === 0 ? (
            <span className="text-[12px] text-parchment-faint">Not on any shelf</span>
          ) : (
            bookShelves.map((shelf) => (
              <span
                key={shelf.id}
                className="flex items-center gap-1 rounded-full bg-ink-800 px-2 py-0.5 text-[11px] text-parchment-faint"
              >
                <button
                  onClick={() => setActiveShelf(shelf.id)}
                  className="max-w-[10rem] truncate transition-colors hover:text-gold-300"
                >
                  {shelf.name}
                </button>
                <button
                  aria-label={`Remove from ${shelf.name}`}
                  title="Remove from shelf"
                  onClick={() => void removeFromShelf(shelf, [book.id])}
                  className="transition-colors hover:text-danger-400"
                >
                  <CloseIcon className="h-3 w-3" />
                </button>
              </span>
            ))
          )}
        </div>

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
          const send = sendStateFor(transfers, book.id, d.id)
          const sending = send === 'sending'
          const failed = send === 'failed'
          // A send that just finished counts as on the device: the device scan
          // follows within a moment, and in between the button must not offer to
          // send the same book a second time
          const on = present || send === 'sent'
          return (
            <div key={d.id} className="flex gap-2">
              <button
                disabled={!online || busy !== null || sending}
                onClick={() => void run('send', () => sendToDevice(book.id, d.id))}
                title={
                  failed
                    ? sendErrorFor(transfers, book.id, d.id)
                    : on
                      ? `Send to ${d.name} again`
                      : undefined
                }
                className={
                  failed
                    ? 'flex flex-1 items-center justify-center gap-2 rounded-md border border-danger-500/60 bg-danger-500/10 px-3 py-2 text-[13px] font-semibold text-danger-400 hover:bg-danger-500/20 disabled:opacity-40'
                    : 'flex flex-1 items-center justify-center gap-2 rounded-md bg-gold-500 px-3 py-2 text-[13px] font-semibold text-ink-950 hover:bg-gold-400 disabled:opacity-40'
                }
              >
                {sending ? (
                  <SpinnerIcon className="h-4 w-4" />
                ) : failed ? (
                  <WarningIcon className="h-4 w-4" />
                ) : on ? (
                  <CheckIcon className="h-4 w-4" />
                ) : (
                  <SendIcon className="h-4 w-4" />
                )}
                {sending
                  ? `Sending to ${d.name}…`
                  : failed
                    ? `Couldn't send — retry`
                    : on
                      ? `On ${d.name}`
                      : `Send to ${d.name}`}
              </button>
              {/* Removal needs no NAS — it only touches the device */}
              {on && (
                <button
                  disabled={busy !== null}
                  onClick={() => requestDeviceRemoval({ bookId: book.id, deviceId: d.id })}
                  title={`Remove from ${d.name}`}
                  aria-label={`Remove from ${d.name}`}
                  className="rounded-md border border-ink-600 px-2.5 text-parchment-dim hover:border-danger-500/60 hover:bg-danger-500/10 hover:text-danger-400 disabled:opacity-40"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              )}
            </div>
          )
        })}
        {/* Gold-outlined rather than solid: the way into a book, but not in
            competition with sending it to a device. Every book with a format
            belongs here: the reader opens the readable ones as it always did,
            and a **PDF-only** book now opens the reader too — which produces a
            reflowed EPUB on demand (slice 3) and hands the book to the OS only
            if that pass refuses it. Only a book with no files at all falls
            through to `openBookFile`, and the button is disabled for those.
            Deliberately *not* gated on `online` like its neighbours: those are
            writes, this is a read. Offline the bytes are unreachable whichever
            entry point is used, and the reader's error state says so and offers
            "Open externally" — better than a dead button with nothing to
            explain it, and it makes all four entry points behave alike. */}
        <button
          disabled={busy !== null || book.formats.length === 0}
          onClick={() => useReaderStore.getState().openBook(book)}
          title={readerTarget(book) ? 'Read in Musaeum' : 'Open in the default app'}
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
            disabled={!online || busy !== null || refreshing}
            onClick={() => void refreshBookMetadata(book.id)}
            title={refreshing ? 'Refreshing metadata…' : 'Re-fetch metadata'}
            aria-label={refreshing ? 'Refreshing metadata' : 'Re-fetch metadata'}
            className="rounded-md border border-ink-600 px-2.5 py-1.5 text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40"
          >
            {/* The fetch takes seconds and the answer arrives as a toast, so
                the button has to say "still working" on its own */}
            {refreshing ? (
              <SpinnerIcon className="h-4 w-4 text-gold-400" />
            ) : (
              <RefreshIcon className="h-4 w-4" />
            )}
          </button>
          <button
            disabled={!online || busy !== null}
            onClick={() => requestDelete(book.id)}
            title={book.formats.length > 1 ? 'Delete book or formats' : 'Delete book'}
            className="rounded-md border border-ink-600 px-2.5 py-1.5 text-parchment-dim hover:bg-ink-800 hover:text-danger-400 disabled:opacity-40"
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
