import type { ImportProgress, ImportStep } from '@shared/book.types'
import { useLibraryStore } from '@/stores/library.store'
import { useUIStore } from '@/stores/ui.store'
import { CheckIcon, SpinnerIcon, WarningIcon } from '@/components/shared/icons'

const STEP_SEQUENCE: { step: ImportStep; label: string }[] = [
  { step: 'received', label: 'File received' },
  { step: 'extracting', label: 'Reading metadata' },
  { step: 'copying', label: 'Adding to library' },
  { step: 'hydrating', label: 'Fetching online metadata' },
  { step: 'cover', label: 'Selecting cover' }
]

const STEP_ORDER: ImportStep[] = [
  'received',
  'extracting',
  'duplicate_check',
  'copying',
  'hydrating',
  'cover',
  'done'
]

function JobCard({ job }: { job: ImportProgress }) {
  const failed = job.step === 'error'
  const currentIdx = STEP_ORDER.indexOf(job.step)

  return (
    <div className="w-80 animate-slide-up rounded-lg border border-ink-700 bg-ink-850/95 p-3 shadow-cover backdrop-blur">
      <p className="truncate font-display text-[13px] text-parchment">{job.fileName}</p>

      {failed ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-[12px] text-red-400">
          <WarningIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          {job.error ?? 'Import failed'}
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {STEP_SEQUENCE.map(({ step, label }) => {
            const idx = STEP_ORDER.indexOf(step)
            const isDone = job.step === 'done' || idx < currentIdx
            const isCurrent = !isDone && idx === currentIdx
            if (!isDone && !isCurrent) return null
            return (
              <li key={step} className="flex items-center gap-2 text-[12px]">
                {isDone ? (
                  <CheckIcon className="h-3.5 w-3.5 text-gold-400" />
                ) : (
                  <SpinnerIcon className="h-3.5 w-3.5 text-gold-400" />
                )}
                <span className={isDone ? 'text-parchment-faint' : 'text-parchment-dim'}>
                  {label}
                </span>
              </li>
            )
          })}
        </ul>
      )}

      {job.duplicateWarning && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-gold-400">
          <WarningIcon className="mt-px h-3 w-3 shrink-0" />
          {job.duplicateWarning}
        </p>
      )}
    </div>
  )
}

export function ImportOverlay() {
  const importJobs = useLibraryStore((s) => s.importJobs)
  const isDragging = useUIStore((s) => s.isDraggingFiles)
  const jobs = Object.values(importJobs)

  return (
    <>
      {isDragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-ink-950/70 backdrop-blur-sm animate-fade-in">
          <div className="rounded-2xl border-2 border-dashed border-gold-400/70 px-14 py-10 text-center">
            <p className="font-display text-2xl text-gold-300">Add to your library</p>
            <p className="mt-2 text-sm text-parchment-dim">Drop EPUB, MOBI, or AZW3 files</p>
          </div>
        </div>
      )}

      {jobs.length > 0 && (
        <div className="fixed bottom-10 right-4 z-30 flex flex-col gap-2">
          {jobs.slice(-4).map((job) => (
            <JobCard key={job.jobId} job={job} />
          ))}
          {jobs.length > 4 && (
            <p className="text-right text-[11px] text-parchment-faint">
              +{jobs.length - 4} more importing…
            </p>
          )}
        </div>
      )}
    </>
  )
}
