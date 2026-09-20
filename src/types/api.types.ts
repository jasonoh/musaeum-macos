import type { AiChunkEvent, AiDoneEvent, AiErrorEvent, AiStatus, AskRequest } from './ai.types'
import type {
  Book,
  BookFilters,
  BookFormat,
  BookSort,
  CatalogSyncOutcome,
  DuplicateDecision,
  ImportProgress,
  ImportResult,
  LibraryFacets,
  ProgressReport
} from './book.types'
import type { Device, TransferJob, TransferProgress } from './device.types'
import type {
  BulkHydrateProgress,
  ConflictChoices,
  HydrateOutcome,
  HydratedField,
  MetadataConflict,
  MigrationJob,
  MigrationOptions,
  MigrationProgress,
  MigrationScan,
  NASStatus
} from './metadata.types'
import type {
  EditableSettings,
  ExecutableKind,
  PythonEnvProgress,
  SettingsView
} from './settings.types'
import type { ThemeImportResult, ThemeView } from './theme.types'

/**
 * All IPC results cross the bridge as IPCResult — handlers never throw
 * across the process boundary.
 */
export type IPCResult<T> = { success: true; data: T } | { success: false; error: string }

export type Unsubscribe = () => void

/**
 * Actions the native application menu can trigger. The menu owns the
 * keyboard shortcut (macOS expects Cmd+, for settings), the renderer owns
 * what the action does — so every item here maps to something the UI can
 * also do on its own.
 */
export type MenuCommand =
  | 'open-settings'
  /**
   * File ▸ Add Books… (⌘O). The menu owns the chord; the renderer runs the same
   * picker the toolbar's Add Books menu opens as its first item.
   */
  | 'add-books'
  | 'view-grid'
  | 'view-list'
  | 'select-all'
  /**
   * Find inside the open book. A no-op with no book open — the library has its
   * own search field, and a panel with no book behind it is worse than nothing.
   */
  | 'reader-find'

/** Outcome of a batched delete: partial success is normal, not an error. */
export interface BulkDeleteResult {
  deleted: number
  failed: { id: string; title: string; error: string }[]
}

/** The API surface exposed on window.Musaeum via contextBridge. */
export interface MusaeumAPI {
  library: {
    getBooks(filters?: BookFilters): Promise<Book[]>
    getBook(id: string): Promise<Book>
    /** Sorted by `sort` when given, otherwise by FTS relevance rank. */
    searchBooks(query: string, sort?: BookSort): Promise<Book[]>
    updateBook(id: string, updates: Partial<Book>): Promise<void>
    /** Fields the user has set, which a metadata fetch must not touch. */
    getFieldOverrides(id: string): Promise<HydratedField[]>
    /** Hand one field back to Musaeum. The value is untouched. */
    releaseFieldOverride(id: string, field: HydratedField): Promise<HydratedField[]>
    deleteBook(id: string): Promise<void>
    /**
     * Delete many books in one batched operation. Partial success is normal:
     * `failed` names the books that survived and why.
     */
    deleteBooks(ids: string[]): Promise<BulkDeleteResult>
    /**
     * Delete individual format files. Selecting every format deletes the book
     * outright — `bookDeleted` tells the caller that happened.
     */
    deleteFormats(id: string, formats: BookFormat[]): Promise<{ bookDeleted: boolean }>
    getFacets(): Promise<LibraryFacets>
    /**
     * Re-read catalog.json into the local cache. Falls back to a full rebuild
     * when the catalog can't be read — the same call, minutes instead of
     * seconds, which is what `cancelled` and the Settings copy both disclose.
     */
    refreshLibrary(): Promise<CatalogSyncOutcome>
    /** Recovery: walk books/&#42;/metadata.json, rewrite catalog.json, reload. */
    rebuildCatalog(): Promise<CatalogSyncOutcome>
    /** Stop a running rebuild; nothing is written. A no-op when none is running. */
    cancelRefresh(): Promise<void>
  }

  import: {
    addFiles(filePaths: string[]): Promise<ImportResult[]>
    /**
     * Native multi-select picker for book files. Empty when the dialog is
     * cancelled — an empty list is already the no-op the caller wants, so
     * "cancelled" needs no second representation.
     */
    fromDialog(): Promise<string[]>
    getImportProgress(jobId: string): Promise<ImportProgress | null>
    resolveDuplicate(jobId: string, decision: DuplicateDecision): Promise<void>
  }

  metadata: {
    getConflictQueue(): Promise<MetadataConflict[]>
    resolveConflict(conflictId: number, choices: ConflictChoices): Promise<void>
    /**
     * Re-fetch one book's metadata and report what it did, rather than
     * returning as soon as the work is queued. Rejects only for the pre-flight
     * failures (offline, no metadata engine, nothing to hydrate from); a
     * hydration that fails in flight comes back as `{ ok: false }`.
     */
    rehydrateBook(bookId: string): Promise<HydrateOutcome>
    /** Re-hydrate many books as one sequential job; progress via events. */
    rehydrateBooks(bookIds: string[]): Promise<void>
    /** Stop a running bulk re-hydrate after the book in flight. */
    cancelRehydrate(): Promise<void>
  }

  devices: {
    getConnectedDevices(): Promise<Device[]>
    sendToDevice(bookId: string, deviceId: string): Promise<TransferJob>
    getTransferProgress(jobId: string): Promise<TransferProgress | null>
    exportToAppleBooks(bookId: string): Promise<void>
    getOnDeviceBookIds(deviceId: string): Promise<string[]>
    /** Delete the book's files (plus `.sdr` sidecars) from a connected device. */
    removeFromDevice(bookId: string, deviceId: string): Promise<{ removed: number }>
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
    /**
     * The last unresolved Python-bootstrap state, or null when there is none.
     *
     * The `pythonEnvProgress` event fires before the renderer subscribes, so
     * this is how a late mount learns the metadata engine never started.
     */
    getPythonEnv(): Promise<PythonEnvProgress | null>
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

  reader: {
    saveProgress(report: ProgressReport): Promise<void>
  }

  ai: {
    /**
     * Whether the ask panel can work at all, and what it would send where.
     * `configured` is false until a model is set — the endpoint has a
     * compiled-in localhost default, the model deliberately has none.
     */
    getStatus(): Promise<AiStatus>
    /**
     * Start a streamed request and return immediately: the text arrives as
     * `on.aiChunk` events and ends with exactly one `on.aiDone` or
     * `on.aiError`. The caller mints `requestId` so it can subscribe *before*
     * asking — a refused connection fails faster than this reply arrives.
     */
    ask(request: AskRequest): Promise<{ requestId: string }>
    /**
     * Stop a request. False when it had already finished, which is how a
     * settled request reports that it released its slot.
     */
    cancel(requestId: string): Promise<boolean>
  }

  theme: {
    /** The active theme, the built-in default's id, and whether the row is stale. */
    get(): Promise<ThemeView>
    /**
     * Switch the active theme. Rejects with the reason when the id cannot be
     * resolved — a theme the user picked that cannot be read is a value with a
     * reason at the service boundary (`CLAUDE.md` #12), surfaced as this
     * rejection — and never for a write: a write that cannot happen leaves the
     * stored pair alone.
     */
    set(id: string): Promise<ThemeView>
    /**
     * Import provider files by path. Partial success is normal: a malformed
     * member is a *rejection row*, never a rejection of the call, so four good
     * themes in a batch of five are still imported (AC4.2). Applying is not
     * implied — importing adds rows, clicking one applies it (AC4.5).
     */
    importPaths(paths: string[]): Promise<ThemeImportResult>
    /** Native multi-select picker. A cancelled dialog imports nothing. */
    importFromDialog(): Promise<ThemeImportResult>
    /**
     * Re-scan the drop-box directory and import whatever is new. Read-only:
     * nothing is copied, normalized or moved, so the folder's contents are the
     * user's and hash-identical before and after (AC4.3).
     */
    scanFolder(): Promise<ThemeImportResult>
    /**
     * Reveal the drop-box directory in Finder, creating it when it does not
     * exist yet. The app creates the folder; it never writes files into it.
     */
    openFolder(): Promise<void>
  }

  on: {
    nasStatusChanged(cb: (status: NASStatus) => void): Unsubscribe
    deviceConnected(cb: (device: Device) => void): Unsubscribe
    deviceDisconnected(cb: (deviceId: string) => void): Unsubscribe
    deviceChanged(cb: (device: Device) => void): Unsubscribe
    importProgress(cb: (progress: ImportProgress) => void): Unsubscribe
    conflictQueueUpdated(cb: (count: number) => void): Unsubscribe
    transferProgress(cb: (progress: TransferProgress) => void): Unsubscribe
    libraryChanged(cb: () => void): Unsubscribe
    catalogRebuildProgress(cb: (p: { completed: number; total: number }) => void): Unsubscribe
    bulkHydrateProgress(cb: (p: BulkHydrateProgress) => void): Unsubscribe
    deviceContentsChanged(cb: (deviceId: string) => void): Unsubscribe
    menuCommand(cb: (command: MenuCommand) => void): Unsubscribe
    pythonEnvProgress(cb: (progress: PythonEnvProgress) => void): Unsubscribe
    themeChanged(cb: (view: ThemeView) => void): Unsubscribe
    aiChunk(cb: (event: AiChunkEvent) => void): Unsubscribe
    aiDone(cb: (event: AiDoneEvent) => void): Unsubscribe
    aiError(cb: (event: AiErrorEvent) => void): Unsubscribe
  }
}

/** Event channel names (main → renderer). */
export const EVENT_CHANNELS = {
  nasStatusChanged: 'event:nas-status-changed',
  deviceConnected: 'event:device-connected',
  deviceDisconnected: 'event:device-disconnected',
  deviceChanged: 'event:device-changed',
  importProgress: 'event:import-progress',
  conflictQueueUpdated: 'event:conflict-queue-updated',
  transferProgress: 'event:transfer-progress',
  libraryChanged: 'event:library-changed',
  catalogRebuildProgress: 'event:catalog-rebuild-progress',
  bulkHydrateProgress: 'event:bulk-hydrate-progress',
  deviceContentsChanged: 'event:device-contents-changed',
  menuCommand: 'event:menu-command',
  pythonEnvProgress: 'event:python-env-progress',
  themeChanged: 'event:theme-changed',
  aiChunk: 'event:ai-chunk',
  aiDone: 'event:ai-done',
  aiError: 'event:ai-error'
} as const
