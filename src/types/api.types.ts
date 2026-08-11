import type {
  Book,
  BookFilters,
  BookFormat,
  BookSort,
  DuplicateDecision,
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
import type { EditableSettings, ExecutableKind, SettingsView } from './settings.types'

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
    /** Sorted by `sort` when given, otherwise by FTS relevance rank. */
    searchBooks(query: string, sort?: BookSort): Promise<Book[]>
    updateBook(id: string, updates: Partial<Book>): Promise<void>
    deleteBook(id: string): Promise<void>
    /**
     * Delete individual format files. Selecting every format deletes the book
     * outright — `bookDeleted` tells the caller that happened.
     */
    deleteFormats(id: string, formats: BookFormat[]): Promise<{ bookDeleted: boolean }>
    getFacets(): Promise<LibraryFacets>
    /** Re-read catalog.json into the local cache; rebuilds when missing. */
    refreshLibrary(): Promise<{ books: number }>
    /** Recovery: walk books/&#42;/metadata.json, rewrite catalog.json, reload. */
    rebuildCatalog(): Promise<{ books: number }>
  }

  import: {
    addFiles(filePaths: string[]): Promise<ImportResult[]>
    getImportProgress(jobId: string): Promise<ImportProgress | null>
    resolveDuplicate(jobId: string, decision: DuplicateDecision): Promise<void>
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
    getOnDeviceBookIds(deviceId: string): Promise<string[]>
  }

  nas: {
    getStatus(): Promise<NASStatus>
    reconnect(): Promise<boolean>
    setLibraryRoot(path: string): Promise<void>
    chooseLibraryRoot(): Promise<string | null>
  }

  settings: {
    /** Configured values plus what each one actually resolves to. */
    get(): Promise<SettingsView>
    /**
     * Apply the given fields; absent fields are untouched, blank fields are
     * cleared back to auto-detection. Rejects without writing anything when a
     * value doesn't validate. Restarts the sidecar when its inputs changed.
     */
    save(updates: Partial<EditableSettings>): Promise<void>
    /** Native file picker for a tool path; null when cancelled. */
    chooseExecutable(kind: ExecutableKind): Promise<string | null>
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
    /**
     * Open the book's folder in Finder, with `format`'s file selected when the
     * book has one (defaults to the book's first format).
     */
    revealBook(bookId: string, format?: BookFormat): Promise<void>
    /** Open one of the book's files in the system default app for its type. */
    openBookFile(bookId: string, format: BookFormat): Promise<void>
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
    deviceContentsChanged(cb: (deviceId: string) => void): Unsubscribe
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
  catalogRebuildProgress: 'event:catalog-rebuild-progress',
  deviceContentsChanged: 'event:device-contents-changed'
} as const
