import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { PythonEnvProgress } from '@shared/settings.types'
import { useLibraryStore } from '@/stores/library.store'
import {
  EMPTY_SELECTION,
  applyClick,
  clear,
  extendTo,
  prune,
  selectAll,
  selectedId,
  toggleOne,
  type ClickModifiers,
  type Selection
} from '@/lib/selection'

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
  selection: Selection
  modal: ActiveModal
  conflictCount: number
  isDraggingFiles: boolean
  contextMenu: ContextMenuTarget | null
  /** Book whose delete dialog is open. */
  deletingBookId: string | null
  /** Whether the bulk delete confirmation is open. */
  deletingSelection: boolean
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
  select(id: string, mods: ClickModifiers): void
  /** Select exactly this book, or clear. The single-selection shorthand. */
  selectBook(id: string | null): void
  toggleBookSelection(id: string): void
  extendSelectionTo(id: string): void
  selectAllBooks(): void
  clearSelection(): void
  /** Drop selected books that are no longer in the loaded library. */
  pruneSelection(existing: string[]): void
  openModal(modal: ActiveModal): void
  setConflictCount(count: number): void
  setDraggingFiles(dragging: boolean): void
  openContextMenu(target: ContextMenuTarget): void
  /** Right-click: books outside the selection become the selection first. */
  openContextMenuFor(target: ContextMenuTarget): void
  closeContextMenu(): void
  requestDelete(bookId: string | null): void
  requestSelectionDelete(open: boolean): void
  requestEdit(bookId: string | null): void
  requestDeviceRemoval(target: DeviceRemovalTarget | null): void
  setPythonEnv(progress: PythonEnvProgress | null): void
}

const PLAIN_CLICK: ClickModifiers = { toggle: false, range: false }

/**
 * Display order for range selection, read at call time rather than passed in
 * by every view — the same cross-store `getState` read `BookCard` already uses
 * to reach the reader. The dependency is one-way: `library.store` knows
 * nothing about this one (pruning is wired from `useLibrary`), so there is no
 * import cycle.
 */
function bookOrder(): string[] {
  return useLibraryStore.getState().books.map((b) => b.id)
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      viewMode: 'grid',
      selection: EMPTY_SELECTION,
      modal: null,
      conflictCount: 0,
      isDraggingFiles: false,
      contextMenu: null,
      deletingBookId: null,
      deletingSelection: false,
      editingBookId: null,
      removingFromDevice: null,
      pythonEnv: null,

      setViewMode: (viewMode) => set({ viewMode }),
      select: (id, mods) =>
        set((s) => ({ selection: applyClick(s.selection, id, mods, bookOrder()) })),
      selectBook: (id) =>
        set((s) => ({
          selection: id === null ? clear() : applyClick(s.selection, id, PLAIN_CLICK, bookOrder())
        })),
      toggleBookSelection: (id) => set((s) => ({ selection: toggleOne(s.selection, id) })),
      extendSelectionTo: (id) =>
        set((s) => ({ selection: extendTo(s.selection, id, bookOrder()) })),
      selectAllBooks: () => set((s) => ({ selection: selectAll(s.selection, bookOrder()) })),
      clearSelection: () => set({ selection: clear() }),
      pruneSelection: (existing) => set((s) => ({ selection: prune(s.selection, existing) })),
      openModal: (modal) => set({ modal }),
      setConflictCount: (conflictCount) => set({ conflictCount }),
      setDraggingFiles: (isDraggingFiles) => set({ isDraggingFiles }),
      openContextMenu: (contextMenu) => set({ contextMenu }),
      openContextMenuFor: (target) =>
        set((s) => ({
          contextMenu: target,
          selection: s.selection.ids.has(target.bookId)
            ? s.selection
            : applyClick(s.selection, target.bookId, PLAIN_CLICK, bookOrder())
        })),
      closeContextMenu: () => set({ contextMenu: null }),
      // Opening any dialog always dismisses the menu that launched it
      requestDelete: (deletingBookId) => set({ deletingBookId, contextMenu: null }),
      requestSelectionDelete: (deletingSelection) => set({ deletingSelection, contextMenu: null }),
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

/**
 * The single-selection view, for everything that only makes sense for one
 * book (the detail panel, the metadata editor, the per-book delete dialog).
 * Null when zero or many are selected.
 */
export const selectedBookId = (s: UIState): string | null => selectedId(s.selection)

export const selectionCount = (s: UIState): number => s.selection.ids.size
