import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { MusaeumAPI, IPCResult, Unsubscribe } from '@shared/api.types'
import { EVENT_CHANNELS } from '@shared/api.types'

/** Unwrap the IPCResult envelope — rejects with the handler's error message. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IPCResult<T>
  if (!result.success) throw new Error(result.error)
  return result.data
}

function listen<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const handler = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: MusaeumAPI = {
  library: {
    getBooks: (filters) => invoke('library:getBooks', filters),
    getBook: (id) => invoke('library:getBook', id),
    searchBooks: (query, sort) => invoke('library:searchBooks', query, sort),
    updateBook: (id, updates) => invoke('library:updateBook', id, updates),
    getFieldOverrides: (id) => invoke('library:getFieldOverrides', id),
    releaseFieldOverride: (id, field) => invoke('library:releaseFieldOverride', id, field),
    deleteBook: (id) => invoke('library:deleteBook', id),
    deleteBooks: (ids) => invoke('library:deleteBooks', ids),
    deleteFormats: (id, formats) => invoke('library:deleteFormats', id, formats),
    getFacets: () => invoke('library:getFacets'),
    refreshLibrary: () => invoke('library:refreshLibrary'),
    rebuildCatalog: () => invoke('library:rebuildCatalog'),
    cancelRefresh: () => invoke('library:cancelRefresh')
  },
  import: {
    addFiles: (filePaths) => invoke('import:addFiles', filePaths),
    fromDialog: () => invoke('import:fromDialog'),
    getImportProgress: (jobId) => invoke('import:getImportProgress', jobId),
    resolveDuplicate: (jobId, decision) => invoke('import:resolveDuplicate', jobId, decision)
  },
  metadata: {
    getConflictQueue: () => invoke('metadata:getConflictQueue'),
    resolveConflict: (conflictId, choices) =>
      invoke('metadata:resolveConflict', conflictId, choices),
    rehydrateBook: (bookId) => invoke('metadata:rehydrateBook', bookId),
    rehydrateBooks: (bookIds) => invoke('metadata:rehydrateBooks', bookIds),
    cancelRehydrate: () => invoke('metadata:cancelRehydrate')
  },
  devices: {
    getConnectedDevices: () => invoke('devices:getConnectedDevices'),
    sendToDevice: (bookId, deviceId) => invoke('devices:sendToDevice', bookId, deviceId),
    getTransferProgress: (jobId) => invoke('devices:getTransferProgress', jobId),
    exportToAppleBooks: (bookId) => invoke('devices:exportToAppleBooks', bookId),
    getOnDeviceBookIds: (deviceId) => invoke('devices:getOnDeviceBookIds', deviceId),
    removeFromDevice: (bookId, deviceId) => invoke('devices:removeFromDevice', bookId, deviceId)
  },
  nas: {
    getStatus: () => invoke('nas:getStatus'),
    reconnect: () => invoke('nas:reconnect'),
    setLibraryRoot: (path) => invoke('nas:setLibraryRoot', path),
    chooseLibraryRoot: () => invoke('nas:chooseLibraryRoot')
  },
  settings: {
    get: () => invoke('settings:get'),
    save: (updates) => invoke('settings:save', updates),
    chooseExecutable: (kind) => invoke('settings:chooseExecutable', kind),
    getPythonEnv: () => invoke('settings:getPythonEnv')
  },
  migration: {
    scanCalibreLibrary: (path) => invoke('migration:scanCalibreLibrary', path),
    startMigration: (options) => invoke('migration:startMigration', options),
    startPdfTopUp: (calibrePath) => invoke('migration:startPdfTopUp', calibrePath),
    getMigrationProgress: (jobId) => invoke('migration:getMigrationProgress', jobId),
    confirmCutover: () => invoke('migration:confirmCutover'),
    chooseCalibrePath: () => invoke('migration:chooseCalibrePath')
  },
  files: {
    // File.path was removed from Electron's renderer; resolving paths from
    // dropped File objects must happen here in the preload
    getPathForFile: (file) => webUtils.getPathForFile(file),
    revealBook: (bookId, format) => invoke('files:revealBook', bookId, format),
    openBookFile: (bookId, format) => invoke('files:openBookFile', bookId, format)
  },
  reader: {
    saveProgress: (report) => invoke('reader:saveProgress', report)
  },
  ai: {
    getStatus: () => invoke('ai:getStatus'),
    ask: (request) => invoke('ai:ask', request),
    cancel: (requestId) => invoke('ai:cancel', requestId),
    test: (request) => invoke('ai:test', request)
  },
  theme: {
    get: () => invoke('theme:get'),
    set: (id) => invoke('theme:set', id),
    importPaths: (paths) => invoke('theme:importPaths', paths),
    importFromDialog: () => invoke('theme:importFromDialog'),
    scanFolder: () => invoke('theme:scanFolder'),
    openFolder: () => invoke('theme:openFolder')
  },
  on: {
    nasStatusChanged: (cb) => listen(EVENT_CHANNELS.nasStatusChanged, cb),
    deviceConnected: (cb) => listen(EVENT_CHANNELS.deviceConnected, cb),
    deviceDisconnected: (cb) => listen(EVENT_CHANNELS.deviceDisconnected, cb),
    deviceChanged: (cb) => listen(EVENT_CHANNELS.deviceChanged, cb),
    importProgress: (cb) => listen(EVENT_CHANNELS.importProgress, cb),
    conflictQueueUpdated: (cb) => listen(EVENT_CHANNELS.conflictQueueUpdated, cb),
    transferProgress: (cb) => listen(EVENT_CHANNELS.transferProgress, cb),
    libraryChanged: (cb) => listen(EVENT_CHANNELS.libraryChanged, () => cb()),
    catalogRebuildProgress: (cb) => listen(EVENT_CHANNELS.catalogRebuildProgress, cb),
    bulkHydrateProgress: (cb) => listen(EVENT_CHANNELS.bulkHydrateProgress, cb),
    deviceContentsChanged: (cb) => listen(EVENT_CHANNELS.deviceContentsChanged, cb),
    menuCommand: (cb) => listen(EVENT_CHANNELS.menuCommand, cb),
    pythonEnvProgress: (cb) => listen(EVENT_CHANNELS.pythonEnvProgress, cb),
    themeChanged: (cb) => listen(EVENT_CHANNELS.themeChanged, cb),
    aiChunk: (cb) => listen(EVENT_CHANNELS.aiChunk, cb),
    aiDone: (cb) => listen(EVENT_CHANNELS.aiDone, cb),
    aiError: (cb) => listen(EVENT_CHANNELS.aiError, cb)
  }
}

contextBridge.exposeInMainWorld('Musaeum', api)
