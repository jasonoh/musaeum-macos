import { useDeviceStore } from '@/stores/device.store'
import { CheckIcon, SpinnerIcon, WarningIcon } from '@/components/shared/icons'

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  converting: 'Converting',
  copying: 'Copying',
  done: 'Sent',
  error: 'Failed'
}

export function TransferQueue() {
  const transfers = useDeviceStore((s) => s.transfers)
  const jobs = Object.values(transfers)
  if (!jobs.length) return null

  return (
    <div className="space-y-1.5 px-3 pb-2">
      {jobs.map((job) => (
        <div key={job.jobId} className="rounded-md bg-ink-850 px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-[11px]">
            {job.status === 'done' ? (
              <CheckIcon className="h-3 w-3 shrink-0 text-gold-400" />
            ) : job.status === 'error' ? (
              <WarningIcon className="h-3 w-3 shrink-0 text-red-400" />
            ) : (
              <SpinnerIcon className="h-3 w-3 shrink-0 text-gold-400" />
            )}
            <span className="truncate text-parchment-dim">{job.bookTitle}</span>
            <span className="ml-auto shrink-0 text-parchment-faint">
              {STATUS_LABEL[job.status]}
            </span>
          </div>
          {job.status === 'copying' && (
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink-700">
              <div
                className="h-full rounded-full bg-gold-400 transition-[width] duration-200"
                style={{ width: `${Math.round(job.progress * 100)}%` }}
              />
            </div>
          )}
          {job.error && <p className="mt-0.5 text-[10px] text-red-400">{job.error}</p>}
        </div>
      ))}
    </div>
  )
}
