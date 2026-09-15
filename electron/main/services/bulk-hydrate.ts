import { promises as fs } from 'fs'
import { extname, join } from 'path'
import type { BulkHydrateProgress } from '@shared/metadata.types'
import * as db from './db'
import { broadcast } from './events'
import * as importer from './importer'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'
import * as sidecar from './sidecar'

/**
 * Re-hydrate many books as one job.
 *
 * Not a loop in the renderer: `importer.hydrate` upserts the catalog and
 * broadcasts `libraryChanged` per book, so fifty books would mean fifty
 * whole-file catalog rewrites over SMB and fifty full library reloads. Worse,
 * the sidecar dispatches on a thread pool, so a renderer loop would fan out
 * fifty *concurrent* hydrations at rate-limited metadata APIs.
 *
 * So: sequential, batched (the catalog is written once at the end), and
 * cancellable, because a few hundred books is minutes of work.
 */

const HYDRATABLE = ['.epub', '.mobi', '.azw3']

/**
 * The one place that decides what a book can be hydrated from — shared with
 * the single-book `metadata:rehydrateBook` handler so the two cannot drift.
 * PDF-only books have nothing here, and are skipped rather than failed.
 */
export async function findHydratableFile(bookDir: string): Promise<string | null> {
  const files = await fs.readdir(bookDir)
  const match = files.find((f) => HYDRATABLE.includes(extname(f).toLowerCase()))
  return match ? join(bookDir, match) : null
}

let running = false
let cancelled = false
let current: Promise<void> = Promise.resolve()

export function isBulkHydrateRunning(): boolean {
  return running
}

/** Stops the loop; the book in flight still finishes and is counted. */
export function cancelBulkHydrate(): void {
  if (running) cancelled = true
}

/**
 * Validates synchronously and then runs in the background — the caller is an
 * IPC handler, and a job that takes minutes must not hold an `invoke` open.
 * Progress and completion arrive as `bulkHydrateProgress` events.
 */
export function startBulkHydrate(ids: string[]): void {
  if (running) throw new Error('A metadata refresh is already running')
  nas.assertOnline()
  // Same reason as the single-book path: once the job is running its only
  // channel is progress events, and every book would report as a bare failure
  sidecar.assertAvailable()
  running = true
  cancelled = false
  current = run(ids)
}

async function run(ids: string[]): Promise<void> {
  const progress: BulkHydrateProgress = {
    completed: 0,
    total: ids.length,
    failed: 0,
    skipped: 0,
    updated: 0,
    running: true
  }
  broadcast('bulkHydrateProgress', { ...progress })
  let hydrated = 0

  try {
    for (const id of ids) {
      if (cancelled) {
        progress.stopped = 'cancelled'
        break
      }
      // Every remaining write would fail anyway; stopping and saying so beats
      // reporting fifty separate failures
      if (!nas.isOnline()) {
        progress.stopped = 'offline'
        break
      }

      const book = db.getBook(id)
      if (!book?.nasPath) {
        progress.skipped++
      } else {
        const bookDir = join(nas.getLibraryRoot()!, book.nasPath)
        try {
          const file = await findHydratableFile(bookDir)
          if (!file) {
            progress.skipped++
          } else {
            const outcome = await importer.hydrate(id, file, bookDir, undefined, { batched: true })
            // `hydrate` returns its failure rather than throwing, so this is
            // the only place the job can learn a book didn't make it — counting
            // it as done is what made `failed` a number that never moved.
            if (outcome.ok) {
              hydrated++
              if (outcome.changed.length > 0) progress.updated++
            } else {
              progress.failed++
              progress.lastError = outcome.error
            }
          }
        } catch (err) {
          // `hydrate` swallows its own pipeline failures (a book keeps its
          // embedded metadata), so this catches the surrounding I/O only
          console.error(`[bulk-hydrate] ${id} failed:`, err)
          progress.failed++
          progress.lastError = err instanceof Error ? err.message : String(err)
        }
      }
      progress.completed++
      broadcast('bulkHydrateProgress', { ...progress })
    }
  } finally {
    running = false
    cancelled = false
    progress.running = false
    if (hydrated > 0) {
      librarySync.writeFullCatalog()
      broadcast('libraryChanged')
    }
    broadcast('bulkHydrateProgress', { ...progress })
  }
}

/** Test-only helpers. */
export function flushForTests(): Promise<void> {
  return current
}
export function resetForTests(): void {
  running = false
  cancelled = false
  current = Promise.resolve()
}
