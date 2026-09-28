import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDeviceStore } from '@/stores/device.store'
import { useLibraryStore } from '@/stores/library.store'
import { useNASStore } from '@/stores/nas.store'
import { useReaderStore } from '@/stores/reader.store'
import { shelfById, useShelvesStore } from '@/stores/shelves.store'
import { selectionCount, useUIStore } from '@/stores/ui.store'
import { contextMenuScope } from '@/lib/selection'
import { removeFromShelf } from '@/lib/shelf-membership'
import { refreshBookMetadata } from '@/lib/metadata-refresh'
import { notifyError } from '@/lib/notify'
import {
  BookIcon,
  CloseIcon,
  DeviceIcon,
  FolderIcon,
  ImageIcon,
  OpenExternalIcon,
  PencilIcon,
  ReaderIcon,
  RefreshIcon,
  TrashIcon
} from '@/components/shared/icons'
import { orderedFormats } from '@shared/book.types'

const MARGIN = 8

/** The menu is gone by the time these settle, so a failure has nowhere to
 *  render — surface it the same way the detail panel's actions do. */
async function reportFailure(work: Promise<unknown>): Promise<void> {
  try {
    await work
  } catch (err) {
    notifyError(err)
  }
}

/** Right-click menu for a book in the grid or list. Mounted once at app root. */
export function BookContextMenu() {
  const target = useUIStore((s) => s.contextMenu)
  const closeContextMenu = useUIStore((s) => s.closeContextMenu)
  const selectBook = useUIStore((s) => s.selectBook)
  const requestDelete = useUIStore((s) => s.requestDelete)
  const requestEdit = useUIStore((s) => s.requestEdit)
  const requestCoverPicker = useUIStore((s) => s.requestCoverPicker)
  const requestDeviceRemoval = useUIStore((s) => s.requestDeviceRemoval)
  const requestShelfPicker = useUIStore((s) => s.requestShelfPicker)
  const count = useUIStore(selectionCount)
  // The Selection object itself (identity is stable between changes): the menu
  // reads the scope of the click from it rather than assuming the right-click
  // moved the selection — it no longer does
  const selection = useUIStore((s) => s.selection)
  const clearSelection = useUIStore((s) => s.clearSelection)
  const requestSelectionDelete = useUIStore((s) => s.requestSelectionDelete)
  const books = useLibraryStore((s) => s.books)
  // The open shelf, for *Remove from “‹shelf›”*. The name is read from the list
  // rather than kept beside the id (R3), so a rename follows for free — and the
  // item is omitted entirely until it is known, because a menu reading
  // `Remove from “undefined”` is worse than no item at all.
  const activeShelfId = useLibraryStore((s) => s.activeShelfId)
  const shelfName = useShelvesStore((s) => shelfById(s, activeShelfId)?.name ?? null)
  const online = useNASStore((s) => s.status?.state === 'connected')
  const label = useNASStore((s) => s.status?.copy.label ?? undefined)
  // Selected as stable slices rather than a derived array, so the menu doesn't
  // re-render on every unrelated device-store update
  const devices = useDeviceStore((s) => s.devices)
  const onDevice = useDeviceStore((s) => s.onDevice)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: target?.x ?? 0, y: target?.y ?? 0 })

  // Flip the menu back inside the window when it would overflow an edge
  useLayoutEffect(() => {
    if (!target || !ref.current) return
    const { width, height } = ref.current.getBoundingClientRect()
    setPos({
      x: Math.min(target.x, window.innerWidth - width - MARGIN),
      y: Math.min(target.y, window.innerHeight - height - MARGIN)
    })
  }, [target])

  useEffect(() => {
    if (!target) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeContextMenu()
    const onScroll = () => closeContextMenu()
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onScroll)
    // Capture phase: a scroll inside the grid doesn't bubble to window
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [target, closeContextMenu])

  if (!target) return null
  const book = books.find((b) => b.id === target.bookId)
  if (!book) return null

  if (contextMenuScope(book.id, selection) === 'selection') {
    return (
      <div
        className="fixed inset-0 z-50"
        onClick={closeContextMenu}
        onContextMenu={closeContextMenu}
      >
        <div
          ref={ref}
          role="menu"
          onClick={(e) => e.stopPropagation()}
          style={{ left: pos.x, top: pos.y }}
          className="absolute w-52 animate-fade-in overflow-hidden rounded-lg border border-ink-700 bg-ink-850 py-1 shadow-cover-lift"
        >
          <p className="px-3 py-1 font-display text-[12px] text-parchment-faint">
            {count} books selected
          </p>
          <div className="my-1 h-px bg-ink-700" />
          {/* Per-book actions are absent rather than disabled: silently
              applying "Read" to one book of twelve is worse than not offering
              it. */}
          <MenuItem
            icon={<CloseIcon className="h-3.5 w-3.5" />}
            label="Clear selection"
            onClick={() => {
              clearSelection()
              closeContextMenu()
            }}
          />
          <MenuItem
            icon={<BookIcon className="h-3.5 w-3.5" />}
            label="Add to Shelf…"
            disabled={!online}
            title={online ? undefined : label}
            onClick={() => requestShelfPicker({ bookIds: [...selection.ids] })}
          />
          <MenuItem
            icon={<TrashIcon className="h-3.5 w-3.5" />}
            label={`Delete ${count} books…`}
            danger
            onClick={() => requestSelectionDelete(true)}
          />
        </div>
      </div>
    )
  }

  const holding = devices.filter((d) => onDevice[d.id]?.includes(book.id))

  return (
    <div className="fixed inset-0 z-50" onClick={closeContextMenu} onContextMenu={closeContextMenu}>
      <div
        ref={ref}
        role="menu"
        onClick={(e) => e.stopPropagation()}
        style={{ left: pos.x, top: pos.y }}
        className="absolute w-52 animate-fade-in overflow-hidden rounded-lg border border-ink-700 bg-ink-850 py-1 shadow-cover-lift"
      >
        <p className="truncate px-3 py-1 font-display text-[12px] text-parchment-faint">
          {book.title}
        </p>
        <div className="my-1 h-px bg-ink-700" />
        {/* First, and on its own: the thing most right-clicks are after */}
        <MenuItem
          icon={<ReaderIcon className="h-3.5 w-3.5" />}
          label="Read"
          onClick={() => {
            useReaderStore.getState().openBook(book)
            closeContextMenu()
          }}
        />
        <div className="my-1 h-px bg-ink-700" />
        {orderedFormats(book).map((f) => (
          <MenuItem
            key={f}
            icon={<OpenExternalIcon className="h-3.5 w-3.5" />}
            label={`Open ${f.toUpperCase()}`}
            onClick={() => {
              closeContextMenu()
              void reportFailure(window.Musaeum.files.openBookFile(book.id, f))
            }}
          />
        ))}
        <MenuItem
          icon={<FolderIcon className="h-3.5 w-3.5" />}
          label="Show in Finder"
          onClick={() => {
            closeContextMenu()
            void reportFailure(window.Musaeum.files.revealBook(book.id))
          }}
        />
        <div className="my-1 h-px bg-ink-700" />
        <MenuItem
          icon={<BookIcon className="h-3.5 w-3.5" />}
          label="View details"
          onClick={() => {
            selectBook(book.id)
            closeContextMenu()
          }}
        />
        <MenuItem
          icon={<PencilIcon className="h-3.5 w-3.5" />}
          label="Edit metadata…"
          onClick={() => requestEdit(book.id)}
        />
        {/* Beside the editor rather than inside it: the editor has no cover
            field, and the picker is a panel of its own (AC17) */}
        <MenuItem
          icon={<ImageIcon className="h-3.5 w-3.5" />}
          label="Choose cover…"
          onClick={() => requestCoverPicker(book.id)}
        />
        {/* The same action as the detail panel's refresh button, so it reports
            the same way — the menu is gone long before the fetch is */}
        <MenuItem
          icon={<RefreshIcon className="h-3.5 w-3.5" />}
          label="Re-fetch metadata"
          onClick={() => {
            closeContextMenu()
            void refreshBookMetadata(book.id)
          }}
        />
        <div className="my-1 h-px bg-ink-700" />
        <MenuItem
          icon={<BookIcon className="h-3.5 w-3.5" />}
          label="Add to Shelf…"
          disabled={!online}
          title={online ? undefined : label}
          onClick={() => requestShelfPicker({ bookIds: [book.id] })}
        />
        {shelfName && (
          // Immediate, with the Undo standing in for a confirmation (D9). Only
          // while a shelf is open, and only once its name is known (R3).
          //
          // This scope and not the selection's: the bulk answer already exists
          // one step away — the selection menu's *Delete N books…* opens
          // `ShelfRemoveDialog`, whose first button is this same remove. Two
          // doors to one action, which is what D9 asks for.
          <MenuItem
            icon={<CloseIcon className="h-3.5 w-3.5" />}
            label={`Remove from “${shelfName}”`}
            disabled={!online}
            title={online ? undefined : label}
            onClick={() => {
              closeContextMenu()
              const shelf = useShelvesStore.getState().shelves.find((s) => s.id === activeShelfId)
              // No else on purpose: this item is rendered only while a shelf is
              // open *and* its name resolved from this same list, so a shelf that
              // has gone by the time of the click has no membership to remove —
              // there is nothing to report, and inventing a sentence for it would
              // be a renderer restating copy main owns (storage-copy-scan)
              if (shelf) void removeFromShelf(shelf, [book.id])
            }}
          />
        )}
        <div className="my-1 h-px bg-ink-700" />
        {holding.map((d) => (
          <MenuItem
            key={d.id}
            icon={<DeviceIcon className="h-3.5 w-3.5" />}
            label={`Remove from ${d.name}…`}
            onClick={() => requestDeviceRemoval({ bookId: book.id, deviceId: d.id })}
          />
        ))}
        <MenuItem
          icon={<TrashIcon className="h-3.5 w-3.5" />}
          label={book.formats.length > 1 ? 'Delete…' : 'Delete book…'}
          danger
          onClick={() => requestDelete(book.id)}
        />
      </div>
    </div>
  )
}

function MenuItem({
  icon,
  label,
  danger,
  disabled,
  title,
  onClick
}: {
  icon: React.ReactNode
  label: string
  danger?: boolean
  disabled?: boolean
  title?: string
  onClick(): void
}) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] ${
        danger
          ? 'text-parchment-dim hover:bg-danger-500/15 hover:text-danger-400'
          : 'text-parchment-dim hover:bg-ink-800 hover:text-parchment'
      } disabled:pointer-events-none disabled:opacity-40`}
    >
      {icon}
      {label}
    </button>
  )
}
