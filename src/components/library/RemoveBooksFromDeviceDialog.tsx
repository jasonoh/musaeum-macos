import { useEffect, useState } from 'react'
import { useDeviceStore } from '@/stores/device.store'
import { useUIStore } from '@/stores/ui.store'
import { SpinnerIcon, TrashIcon } from '@/components/shared/icons'
import { useDialogFocus } from '@/hooks/useDialogFocus'

/**
 * Confirmation for deleting several books' files off a connected device, from
 * the device view's selection. The library copies are untouched; what does not
 * come back on a re-send is each book's reading position, which lives in the
 * `.sdr` folder that goes with it.
 *
 * Failures are reported, not swallowed: the dialog stays open on the books that
 * could not be removed (the target is narrowed to them, so confirming again is
 * a retry) and names the count and the first error. Removal needs no NAS, so
 * nothing here is gated on being online.
 */
export function RemoveBooksFromDeviceDialog() {
  const dialogRef = useDialogFocus()
  const target = useUIStore((s) => s.removingBooksFromDevice)
  const requestBulkDeviceRemoval = useUIStore((s) => s.requestBulkDeviceRemoval)
  const devices = useDeviceStore((s) => s.devices)
  const removeBooksFromDevice = useDeviceStore((s) => s.removeBooksFromDevice)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setError(null)
        requestBulkDeviceRemoval(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestBulkDeviceRemoval])

  const device = devices.find((d) => d.id === target?.deviceId)
  // An unplugged device closes the dialog rather than failing on confirm
  if (!target || !device || target.bookIds.length === 0) return null

  const count = target.bookIds.length
  const close = () => {
    setError(null)
    requestBulkDeviceRemoval(null)
  }

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const { removed, failed } = await removeBooksFromDevice(target.bookIds, device.id)
      if (failed.length === 0) {
        // The removed books have left the device scope, and the selection
        // prunes itself to what is still listed
        close()
      } else {
        const gone = new Set(removed)
        requestBulkDeviceRemoval({
          deviceId: device.id,
          bookIds: target.bookIds.filter((id) => !gone.has(id))
        })
        setError(
          `${failed.length} of ${count} could not be removed: ${failed[0]?.error ?? 'unknown error'}` +
            (failed.length > 1 ? ` (and ${failed.length - 1} more)` : '')
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-scrim/80 p-8 backdrop-blur-sm"
      onClick={() => !busy && close()}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Remove ${count} books from ${device.name}`}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-ink-700 bg-ink-900 p-5 shadow-cover-lift"
      >
        <h2 className="font-display text-lg leading-snug text-parchment">
          Remove {count} {count === 1 ? 'book' : 'books'} from {device.name}?
        </h2>

        <p className="mt-4 text-[12px] leading-relaxed text-parchment-dim">
          This deletes the files from the device, along with each book’s reading position and
          annotations. The books stay in your library — their copies there are untouched, and you
          can send them again at any time.
        </p>

        {error && <p className="mt-3 text-[12px] text-danger-400">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            data-autofocus
            disabled={busy}
            onClick={close}
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
            {error ? `Retry ${count}` : `Remove ${count}`}
          </button>
        </div>
      </div>
    </div>
  )
}
