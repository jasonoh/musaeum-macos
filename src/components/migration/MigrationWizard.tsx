import { useEffect, useRef, useState } from 'react'
import type { MigrationProgress, MigrationScan } from '@shared/metadata.types'
import { useLibraryStore } from '@/stores/library.store'
import { useUIStore } from '@/stores/ui.store'
import { CheckIcon, CloseIcon, SpinnerIcon, WarningIcon } from '@/components/shared/icons'

type Step = 'source' | 'confirm' | 'running' | 'done'

function gb(bytes: number): string {
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`
}

export function MigrationWizard() {
  const openModal = useUIStore((s) => s.openModal)
  const load = useLibraryStore((s) => s.load)

  const [step, setStep] = useState<Step>('source')
  const [scanning, setScanning] = useState(false)
  const [scan, setScan] = useState<MigrationScan | null>(null)
  const [targetRoot, setTargetRoot] = useState<string | null>(null)
  const [hydrate, setHydrate] = useState(false)
  const [progress, setProgress] = useState<MigrationProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval>>()

  useEffect(() => () => clearInterval(pollRef.current), [])

  const chooseSource = async () => {
    setError(null)
    const path = await window.Musaeum.migration.chooseCalibrePath()
    if (!path) return
    setScanning(true)
    try {
      setScan(await window.Musaeum.migration.scanCalibreLibrary(path))
      setStep('confirm')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setScanning(false)
    }
  }

  const start = async () => {
    if (!scan || !targetRoot) return
    setError(null)
    try {
      const { jobId } = await window.Musaeum.migration.startMigration({
        calibrePath: scan.calibrePath,
        targetLibraryRoot: targetRoot,
        hydrate
      })
      setStep('running')
      pollRef.current = setInterval(async () => {
        const p = await window.Musaeum.migration.getMigrationProgress(jobId)
        if (!p) return
        setProgress(p)
        if (p.phase === 'done' || p.phase === 'error') {
          clearInterval(pollRef.current)
          setStep(p.phase === 'done' ? 'done' : 'running')
          if (p.phase === 'error') setError(p.error ?? 'Migration failed')
        }
      }, 1_000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const cutover = async () => {
    setError(null)
    try {
      await window.Musaeum.migration.confirmCutover()
      await load()
      openModal(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const running = step === 'running' && (!progress || progress.phase !== 'error')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 p-8 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-lg rounded-xl border border-ink-700 bg-ink-900 shadow-cover-lift">
        <div className="flex items-center justify-between border-b border-ink-800 px-5 py-3">
          <h2 className="font-display text-lg text-parchment">Migrate from Calibre</h2>
          <button
            onClick={() => openModal(null)}
            disabled={running}
            className="rounded p-1 text-parchment-faint hover:bg-ink-800 hover:text-parchment disabled:opacity-40"
            aria-label="Close"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5">
          {step === 'source' && (
            <div className="space-y-4">
              <p className="text-sm leading-relaxed text-parchment-dim">
                Point Musaeum at your existing Calibre library. The original library is{' '}
                <span className="text-parchment">never modified</span> — books are copied into a
                new UUID-based structure, and you confirm the switch at the end.
              </p>
              <button
                onClick={() => void chooseSource()}
                disabled={scanning}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-gold-500 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-gold-400 disabled:opacity-50"
              >
                {scanning && <SpinnerIcon className="h-4 w-4" />}
                {scanning ? 'Scanning…' : 'Locate Calibre Library…'}
              </button>
            </div>
          )}

          {step === 'confirm' && scan && (
            <div className="space-y-4">
              <dl className="space-y-1.5 rounded-md bg-ink-850 p-4 text-[13px]">
                <div className="flex justify-between">
                  <dt className="text-parchment-faint">Books found</dt>
                  <dd className="font-semibold tabular-nums text-parchment">
                    {scan.bookCount.toLocaleString()}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-parchment-faint">Formats</dt>
                  <dd className="text-parchment-dim">
                    {Object.entries(scan.formatCounts)
                      .map(([f, n]) => `${n} ${f}`)
                      .join(' · ') || 'none'}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-parchment-faint">Estimated size</dt>
                  <dd className="text-parchment-dim">{gb(scan.estimatedSizeBytes)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-parchment-faint">metadata.db</dt>
                  <dd className={scan.hasMetadataDb ? 'text-gold-300' : 'text-red-400'}>
                    {scan.hasMetadataDb ? 'Found' : 'Missing'}
                  </dd>
                </div>
              </dl>

              <div>
                <button
                  onClick={() =>
                    void window.Musaeum.nas.chooseLibraryRoot().then((p) => p && setTargetRoot(p))
                  }
                  className="w-full rounded-md border border-ink-600 px-4 py-2 text-sm text-parchment-dim hover:bg-ink-800 hover:text-parchment"
                >
                  {targetRoot ? `New library: ${targetRoot}` : 'Choose New Library Folder…'}
                </button>
              </div>

              <label className="flex items-start gap-2.5 text-[13px] text-parchment-dim">
                <input
                  type="checkbox"
                  checked={hydrate}
                  onChange={(e) => setHydrate(e.target.checked)}
                  className="mt-0.5 accent-gold-500"
                />
                <span>
                  Fetch online metadata during migration
                  <span className="block text-[11px] text-parchment-faint">
                    Slower (rate-limited) — for large libraries this can run for hours. You can
                    also re-hydrate books individually later.
                  </span>
                </span>
              </label>

              <button
                onClick={() => void start()}
                disabled={!targetRoot || !scan.hasMetadataDb}
                className="w-full rounded-md bg-gold-500 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-gold-400 disabled:opacity-40"
              >
                Start Migration ({scan.bookCount.toLocaleString()} books)
              </button>
            </div>
          )}

          {step === 'running' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                {!error && <SpinnerIcon className="h-5 w-5 text-gold-400" />}
                <p className="text-sm text-parchment-dim">
                  {progress?.phase === 'hydrating' ? 'Hydrating metadata' : 'Copying books'} —{' '}
                  <span className="tabular-nums">
                    {progress?.completed ?? 0} of {progress?.total ?? '…'}
                  </span>
                </p>
              </div>
              {progress?.currentTitle && (
                <p className="truncate font-display text-[13px] italic text-parchment-faint">
                  {progress.currentTitle}
                </p>
              )}
              <div className="h-1.5 overflow-hidden rounded-full bg-ink-700">
                <div
                  className="h-full rounded-full bg-gold-400 transition-[width] duration-500"
                  style={{
                    width: progress?.total
                      ? `${Math.round((progress.completed / progress.total) * 100)}%`
                      : '2%'
                  }}
                />
              </div>
            </div>
          )}

          {step === 'done' && progress && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-gold-300">
                <CheckIcon className="h-5 w-5" />
                <p className="font-display text-lg">Migration complete</p>
              </div>
              <dl className="space-y-1.5 rounded-md bg-ink-850 p-4 text-[13px]">
                <Stat label="Migrated" value={progress.migrated} />
                <Stat label="Needs review" value={progress.needsReview} highlight />
                <Stat label="No metadata found" value={progress.noMetadata} />
                <Stat label="Duplicates skipped" value={progress.duplicates} />
              </dl>
              <p className="text-[12px] leading-relaxed text-parchment-faint">
                Your Calibre library was not touched. Switching makes the new folder Musaeum's
                library root — keep the Calibre folder as an archive until you're confident.
              </p>
              <button
                onClick={() => void cutover()}
                className="w-full rounded-md bg-gold-500 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-gold-400"
              >
                Switch to New Library
              </button>
            </div>
          )}

          {error && (
            <p className="mt-3 flex items-start gap-1.5 text-[13px] text-red-400">
              <WarningIcon className="mt-px h-4 w-4 shrink-0" />
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className="text-parchment-faint">{label}</dt>
      <dd className={`tabular-nums ${highlight && value > 0 ? 'text-gold-300' : 'text-parchment'}`}>
        {value.toLocaleString()}
      </dd>
    </div>
  )
}
