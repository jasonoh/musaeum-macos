import type {
  Book,
  BookFilters,
  ImportProgress,
  ImportResult,
  LibraryFacets
} from './book.types'
import type { Device, TransferJob, TransferProgress } from './device.types'
import type {
  ConflictChoices,
  MetadataConflict,
  MigrationJob,
  MigrationOptions,
  MigrationProgress,
  MigrationScan,
  NASStatus
} from './metadata.types'

/**
 * All IPC results cross the bridge as IPCResult — handlers never throw
 * across the process boundary.
 */
export type IPCResult<T> = { success: true; data: T } | { success: false; error: string }

export type Unsubscribe = () => void

/** The API surface exposed on window.Musaeum via contextBridge. */
export interface MusaeumAPI {
  library: {
    getBooks(filters?: BookFilters): Promise<Book[]>
    getBook(id: string): Promise<Book>
    searchBooks(query: string): Promise<Book[]>
    updateBook(id: string, updates: Partial<Book>): Promise<void>
    deleteBook(id: string): Promise<void>
    getFacets(): Promise<LibraryFacets>
    /** Re-read catalog.json into the local cache; rebuilds when missing. */
    refreshLibrary(): Promise<{ books: number }>
    /** Recovery: walk books/&#42;/metadata.json, rewrite catalog.json, reload. */
    rebuildCatalog(): Promise<{ books: number }>
  }

  import: {
    addFiles(filePaths: string[]): Promise<ImportResult[]>
    getImportProgress(jobId: string): Promise<ImportProgress | null>
  }

  metadata: {
    getConflictQueue(): Promise<MetadataConflict[]>
    resolveConflict(conflictId: number, choices: ConflictChoices): Promise<void>
    rehydrateBook(bookId: string): Promise<void>
  }

  devices: {
    getConnectedDevices(): Promise<Device[]>
    sendToDevice(bookId: string, deviceId: string): Promise<TransferJob>
    getTransferProgress(jobId: string): Promise<TransferProgress | null>
    exportToAppleBooks(bookId: string): Promise<void>
  }

  nas: {
    getStatus(): Promise<NASStatus>
    reconnect(): Promise<boolean>
    setLibraryRoot(path: string): Promise<void>
    chooseLibraryRoot(): Promise<string | null>
  }

  migration: {
    scanCalibreLibrary(path: string): Promise<MigrationScan>
    startMigration(options: MigrationOptions): Promise<MigrationJob>
    /** Re-runnable: attach Calibre PDFs to existing books + import PDF-only books. */
    startPdfTopUp(calibrePath: string): Promise<MigrationJob>
    getMigrationProgress(jobId: string): Promise<MigrationProgress | null>
    confirmCutover(): Promise<void>
    chooseCalibrePath(): Promise<string | null>
  }

  files: {
    /** Resolve dropped File objects to absolute paths (must run in preload). */
    getPathForFile(file: File): string
  }

  on: {
    nasStatusChanged(cb: (status: NASStatus) => void): Unsubscribe
    deviceConnected(cb: (device: Device) => void): Unsubscribe
    deviceDisconnected(cb: (deviceId: string) => void): Unsubscribe
    importProgress(cb: (progress: ImportProgress) => void): Unsubscribe
    conflictQueueUpdated(cb: (count: number) => void): Unsubscribe
    transferProgress(cb: (progress: TransferProgress) => void): Unsubscribe
    libraryChanged(cb: () => void): Unsubscribe
    catalogRebuildProgress(cb: (p: { completed: number; total: number }) => void): Unsubscribe
  }
}

/** Event channel names (main → renderer). */
export const EVENT_CHANNELS = {
  nasStatusChanged: 'event:nas-status-changed',
  deviceConnected: 'event:device-connected',
  deviceDisconnected: 'event:device-disconnected',
  importProgress: 'event:import-progress',
  conflictQueueUpdated: 'event:conflict-queue-updated',
  transferProgress: 'event:transfer-progress',
  libraryChanged: 'event:library-changed',
  catalogRebuildProgress: 'event:catalog-rebuild-progress'
} as const
