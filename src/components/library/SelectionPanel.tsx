import { useMemo } from 'react'
import { failedSendCount, liveSendCount, useDeviceStore } from '@/stores/device.store'
import { useLibraryStore } from '@/stores/library.store'
import { useNASStore } from '@/stores/nas.store'
import { selectionCount, useUIStore } from '@/stores/ui.store'
import {
  CloseIcon,
  RefreshIcon,
  SendIcon,
  SpinnerIcon,
  TrashIcon,
  WarningIcon
} from '@/components/shared/icons'

const PREVIEW_TITLES = 5

/**
 * Stands in for BookDetail when two or more books are selected. It reuses that
 * panel's shell width exactly: GridView derives its column count and row
 * height from the container width, so a panel that changed size between modes
 * would re-flow the grid on every selection change.
 */
export function SelectionPanel() {
  const count = useUIStore(selectionCount)
  const selectedIds = useUIStore((s) => s.selection.ids)
  const clearSelection = useUIStore((s) => s.clearSelection)
  const requestSelectionDelete = useUIStore((s) => s.requestSelectionDelete)
  const books = useLibraryStore((s) => s.books)
  const online = useNASStore((s) => s.status?.state === 'connected')
  const devices = useDeviceStore((s) => s.devices)
  const onDevice = useDeviceStore((s) => s.onDevice)
  const transfers = useDeviceStore((s) => s.transfers)
  const sendBooksToDevice = useDeviceStore((s) => s.sendBooksToDevice)

  // In display order, so the preview matches what the user is looking at
  const selected = useMemo(() => books.filter((b) => selectedIds.has(b.id)), [books, selectedIds])

  if (count < 2) return null

  // One button per connected device, like the detail panel's send row.
  // Presence comes from the scanned device contents, so a book already on the
  // Kindle is skipped rather than re-copied.
  const sends = devices.map((device) => {
    const alreadyOn = new Set(onDevice[device.id] ?? [])
    return { device, sendable: selected.filter((b) => !alreadyOn.has(b.id)) }
  })

  return (
    <aside className="flex w-[360px] shrink-0 animate-slide-in-right flex-col border-l border-ink-800 bg-ink-900 shadow-panel">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-ink-800 px-4">
        <span className="font-display text-[13px] text-parchment">{count} books selected</span>
        <button
          onClick={clearSelection}
          aria-label="Clear selection"
          className="rounded p-1 text-parchment-faint hover:bg-ink-800 hover:text-parchment"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <ul className="space-y-1.5">
          {selected.slice(0, PREVIEW_TITLES).map((b) => (
            <li key={b.id} className="truncate font-display text-[13px] text-parchment-dim">
              {b.title}
            </li>
          ))}
        </ul>
        {count > PREVIEW_TITLES && (
          <p className="mt-2 text-[12px] text-parchment-faint">+{count - PREVIEW_TITLES} more</p>
        )}
      </div>

      <div className="shrink-0 space-y-2 border-t border-ink-800 p-4">
        {sends.map(({ device, sendable }) => {
          // Counted from the queue, not the click: the loop in `sendBooksToDevice`
          // resolves per book, and the button has to stay frozen while jobs are
          // still copying or a second click sends the whole selection again
          const live = liveSendCount(transfers, device.id)
          const failed = failedSendCount(transfers, device.id) > 0 && sendable.length > 0
          return (
            <button
              key={device.id}
              disabled={!online || sendable.length === 0 || live > 0}
              onClick={() =>
                void sendBooksToDevice(
                  sendable.map((b) => b.id),
                  device.id
                )
              }
              className={
                failed
                  ? 'flex w-full items-center justify-center gap-2 rounded-md border border-red-500/60 bg-red-500/10 px-3 py-2 text-[13px] text-red-400 hover:bg-red-500/20 disabled:opacity-40'
                  : 'flex w-full items-center justify-center gap-2 rounded-md bg-gold-500/20 px-3 py-2 text-[13px] text-gold-300 hover:bg-gold-500/30 disabled:opacity-40'
              }
            >
              {live > 0 ? (
                <SpinnerIcon className="h-4 w-4" />
              ) : failed ? (
                <WarningIcon className="h-4 w-4" />
              ) : (
                <SendIcon className="h-4 w-4" />
              )}
              {live > 0
                ? `Sending ${live} to ${device.name}…`
                : failed
                  ? `Retry ${sendable.length} to ${device.name}`
                  : sendable.length === 0
                    ? `All on ${device.name}`
                    : `Send ${sendable.length} to ${device.name}`}
            </button>
          )
        })}
        <button
          disabled={!online}
          onClick={() => void window.Musaeum.metadata.rehydrateBooks(selected.map((b) => b.id))}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-ink-600 px-3 py-2 text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40"
        >
          <RefreshIcon className="h-4 w-4" />
          Refresh metadata
        </button>
        {/* Set apart from the recoverable actions above it, and the only one
            styled as danger */}
        <button
          disabled={!online}
          onClick={() => requestSelectionDelete(true)}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-md border border-red-500/40 px-3 py-2 text-[13px] text-red-400 hover:bg-red-500/15 disabled:opacity-40"
        >
          <TrashIcon className="h-4 w-4" />
          Delete {count} books…
        </button>
        {!online && (
          <p className="text-[12px] text-red-400">The library is offline — reconnect to act.</p>
        )}
      </div>
    </aside>
  )
}
