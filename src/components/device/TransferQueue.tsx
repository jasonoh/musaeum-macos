import { useDeviceStore } from '@/stores/device.store'
import { CheckIcon, CloseIcon, RefreshIcon, SpinnerIcon, WarningIcon } from '@/components/shared/icons'

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  converting: 'Converting',
  copying: 'Copying',
  done: 'Sent',
  error: 'Failed'
}

export function TransferQueue() {
  const transfers = useDeviceStore((s) => s.transfers)
  const removeTransfer = useDeviceStore((s) => s.removeTransfer)
  const sendToDevice = useDeviceStore((s) => s.sendToDevice)
  const jobs = Object.values(transfers)
  if (!jobs.length) return null

  return (
    <div className="space-y-1.5 px-3 pb-2">
      {jobs.map((job) => {
        // Successful transfers clear themselves after a few seconds; a failure
        // stays until dismissed, so it needs a way out of the panel
        const finished = job.status === 'done' || job.status === 'error'
        return (
          <div key={job.jobId} className="rounded-md bg-ink-850 px-2 py-1.5">
            <div className="flex items-center gap-1.5 text-[11px]">
              {job.status === 'done' ? (
                <CheckIcon className="h-3 w-3 shrink-0 text-gold-400" />
              ) : job.status === 'error' ? (
                <WarningIcon className="h-3 w-3 shrink-0 text-danger-400" />
              ) : (
                <SpinnerIcon className="h-3 w-3 shrink-0 text-gold-400" />
              )}
              <span className="truncate text-parchment-dim" title={job.bookTitle}>
                {job.bookTitle}
              </span>
              <span className="ml-auto shrink-0 text-parchment-faint">
                {STATUS_LABEL[job.status]}
              </span>
              {finished && (
                <button
                  onClick={() => removeTransfer(job.jobId)}
                  title="Dismiss"
                  aria-label={`Dismiss ${job.bookTitle}`}
                  className="-mr-0.5 shrink-0 rounded p-0.5 text-parchment-faint hover:bg-ink-800 hover:text-parchment"
                >
                  <CloseIcon className="h-3 w-3" />
                </button>
              )}
            </div>
            {job.status === 'copying' && (
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink-700">
                <div
                  className="h-full rounded-full bg-gold-400 transition-[width] duration-200"
                  style={{ width: `${Math.round(job.progress * 100)}%` }}
                />
              </div>
            )}
            {job.error && (
              <>
                {/* Full text on hover: the panel is too narrow for a long
                    message, and a truncated error is an unactionable one */}
                <p className="mt-0.5 text-[10px] leading-snug text-danger-400" title={job.error}>
                  {job.error}
                </p>
                <button
                  onClick={() => {
                    removeTransfer(job.jobId)
                    void sendToDevice(job.bookId, job.deviceId).catch(() => undefined)
                  }}
                  className="mt-1 flex items-center gap-1 text-[10px] text-parchment-faint hover:text-gold-300"
                >
                  <RefreshIcon className="h-2.5 w-2.5" />
                  Try again
                </button>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
