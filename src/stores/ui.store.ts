import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { PythonEnvProgress } from '@shared/settings.types'

export type ViewMode = 'grid' | 'list'
export type ActiveModal = 'conflicts' | 'migration' | 'settings' | null

export interface ContextMenuTarget {
  bookId: string
  x: number
  y: number
}

export interface DeviceRemovalTarget {
  bookId: string
  deviceId: string
}

interface UIState {
  viewMode: ViewMode
  selectedBookId: string | null
  modal: ActiveModal
  conflictCount: number
  isDraggingFiles: boolean
  contextMenu: ContextMenuTarget | null
  /** Book whose delete dialog is open. */
  deletingBookId: string | null
  /** Book whose metadata editor is open. */
  editingBookId: string | null
  /** Book + device whose "remove from device" confirmation is open. */
  removingFromDevice: DeviceRemovalTarget | null
  /**
   * Latest word from the first-launch Python bootstrap, or null once it has
   * finished cleanly. A failure is kept so the status bar can keep saying why
   * metadata features are unavailable.
   */
  pythonEnv: PythonEnvProgress | null

  setViewMode(mode: ViewMode): void
  selectBook(id: string | null): void
  openModal(modal: ActiveModal): void
  setConflictCount(count: number): void
  setDraggingFiles(dragging: boolean): void
  openContextMenu(target: ContextMenuTarget): void
  closeContextMenu(): void
  requestDelete(bookId: string | null): void
  requestEdit(bookId: string | null): void
  requestDeviceRemoval(target: DeviceRemovalTarget | null): void
  setPythonEnv(progress: PythonEnvProgress | null): void
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      viewMode: 'grid',
      selectedBookId: null,
      modal: null,
      conflictCount: 0,
      isDraggingFiles: false,
      contextMenu: null,
      deletingBookId: null,
      editingBookId: null,
      removingFromDevice: null,
      pythonEnv: null,

      setViewMode: (viewMode) => set({ viewMode }),
      selectBook: (selectedBookId) => set({ selectedBookId }),
      openModal: (modal) => set({ modal }),
      setConflictCount: (conflictCount) => set({ conflictCount }),
      setDraggingFiles: (isDraggingFiles) => set({ isDraggingFiles }),
      openContextMenu: (contextMenu) => set({ contextMenu }),
      closeContextMenu: () => set({ contextMenu: null }),
      // Opening any dialog always dismisses the menu that launched it
      requestDelete: (deletingBookId) => set({ deletingBookId, contextMenu: null }),
      requestEdit: (editingBookId) => set({ editingBookId, contextMenu: null }),
      requestDeviceRemoval: (removingFromDevice) => set({ removingFromDevice, contextMenu: null }),
      setPythonEnv: (pythonEnv) => set({ pythonEnv })
    }),
    {
      // Only the view choice outlives the session — selection, modals and
      // dialogs are all about what is on screen right now
      name: 'musaeum.ui',
      partialize: (s) => ({ viewMode: s.viewMode }),
      merge: (persisted, current) => {
        const { viewMode } = (persisted ?? {}) as { viewMode?: unknown }
        return viewMode === 'grid' || viewMode === 'list' ? { ...current, viewMode } : current
      }
    }
  )
)
