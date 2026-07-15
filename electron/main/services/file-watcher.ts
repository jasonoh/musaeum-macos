import { watch, FSWatcher } from 'chokidar'
import { promises as fs } from 'fs'
import { extname, join } from 'path'
import * as importer from './importer'
import * as nas from './nas-manager'

const WATCHED_EXTENSIONS = new Set(['.epub', '.mobi', '.azw3', '.pdf'])

let watcher: FSWatcher | null = null

/**
 * Watch {library_root}/imports/ — files dropped there (e.g. via Finder or
 * another machine on the network) are imported and then removed.
 */
export function startWatcher(): void {
  stopWatcher()
  const root = nas.getLibraryRoot()
  if (!root || !nas.isOnline()) return

  const importsDir = join(root, 'imports')
  watcher = watch(importsDir, {
    ignoreInitial: false,
    depth: 0,
    // Wait for files to finish copying before importing
    awaitWriteFinish: { stabilityThreshold: 2_000, pollInterval: 500 }
  })

  watcher.on('add', (path) => {
    if (!WATCHED_EXTENSIONS.has(extname(path).toLowerCase())) return
    void importAndRemove(path)
  })
}

async function importAndRemove(path: string): Promise<void> {
  try {
    const [result] = await importer.addFiles([path])
    if (result.success) {
      await fs.rm(path, { force: true })
    }
  } catch (err) {
    console.error('[watcher] import failed:', err)
  }
}

export function stopWatcher(): void {
  void watcher?.close()
  watcher = null
}

/** Re-arm the watcher whenever NAS connectivity changes. */
export function bindToNAS(): void {
  nas.onStatusChange((status) => {
    if (status.state === 'connected') startWatcher()
    else stopWatcher()
  })
}
