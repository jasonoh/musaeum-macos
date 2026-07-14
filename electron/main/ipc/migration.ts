import { dialog } from 'electron'
import type { MigrationOptions } from '@shared/metadata.types'
import * as migration from '../services/migration'
import { handle } from './handle'

export function registerMigrationHandlers(): void {
  handle('migration:scanCalibreLibrary', (path: string) => migration.scanCalibreLibrary(path))
  handle('migration:startMigration', (options: MigrationOptions) =>
    migration.startMigration(options)
  )
  handle('migration:getMigrationProgress', (jobId: string) =>
    migration.getMigrationProgress(jobId)
  )
  handle('migration:confirmCutover', () => migration.confirmCutover())

  handle('migration:chooseCalibrePath', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Locate Calibre Library',
      message: 'Select your existing Calibre library folder (contains metadata.db)',
      properties: ['openDirectory']
    })
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0]
  })
}
