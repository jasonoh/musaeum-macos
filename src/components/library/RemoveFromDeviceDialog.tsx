import { useEffect, useState } from 'react'
import { useDeviceStore } from '@/stores/device.store'
import { useLibraryStore } from '@/stores/library.store'
import { useUIStore } from '@/stores/ui.store'
import { SpinnerIcon, TrashIcon } from '@/components/shared/icons'

/**
 * Confirmation for deleting a book's files off a connected device. The book
 * itself is untouched — the only thing that doesn't come back on a re-send is
 * the reading position, which lives in the `.sdr` folder that goes with it.
 */
export function RemoveFromDeviceDialog() {
  const target = useUIStore((s) => s.removingFromDevice)
  const requestDeviceRemoval = useUIStore((s) => s.requestDeviceRemoval)
  const books = useLibraryStore((s) => s.books)
  const devices = useDeviceStore((s) => s.devices)
  const removeFromDevice = useDeviceStore((s) => s.removeFromDevice)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestDeviceRemoval(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestDeviceRemoval])

  const book = books.find((b) => b.id === target?.bookId)
  const device = devices.find((d) => d.id === target?.deviceId)
  // An unplugged device closes the dialog rather than failing on confirm
  if (!target || !book || !device) return null

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await removeFromDevice(book.id, device.id)
      requestDeviceRemoval(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-scrim/80 p-8 backdrop-blur-sm"
      onClick={() => !busy && requestDeviceRemoval(null)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Remove ${book.title} from ${device.name}`}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-ink-700 bg-ink-900 p-5 shadow-cover-lift"
      >
        <h2 className="font-display text-lg leading-snug text-parchment">
          Remove “{book.title}” from {device.name}?
        </h2>
        {book.author && <p className="mt-0.5 text-[13px] text-parchment-faint">{book.author}</p>}

        <p className="mt-4 text-[12px] leading-relaxed text-parchment-dim">
          This deletes the file from the device, along with its reading position and annotations.
          The book stays in your library — you can send it again at any time.
        </p>

        {error && <p className="mt-3 text-[12px] text-danger-400">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            disabled={busy}
            onClick={() => requestDeviceRemoval(null)}
            className="rounded-md border border-ink-600 px-3 py-1.5 text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            disabled={busy}
            onClick={() => void confirm()}
            className="flex items-center gap-2 rounded-md bg-danger-500 px-3 py-1.5 text-[13px] font-semibold text-on-danger hover:bg-danger-500/90 disabled:opacity-40"
          >
            {busy ? <SpinnerIcon className="h-4 w-4" /> : <TrashIcon className="h-4 w-4" />}
            Remove from device
          </button>
        </div>
      </div>
    </div>
  )
}
