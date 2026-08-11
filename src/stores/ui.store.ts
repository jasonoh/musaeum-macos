import { create } from 'zustand'

export type ViewMode = 'grid' | 'list'
export type ActiveModal = 'conflicts' | 'migration' | 'settings' | null

export interface ContextMenuTarget {
  bookId: string
  x: number
  y: number
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

  setViewMode(mode: ViewMode): void
  selectBook(id: string | null): void
  openModal(modal: ActiveModal): void
  setConflictCount(count: number): void
  setDraggingFiles(dragging: boolean): void
  openContextMenu(target: ContextMenuTarget): void
  closeContextMenu(): void
  requestDelete(bookId: string | null): void
  requestEdit(bookId: string | null): void
}

export const useUIStore = create<UIState>((set) => ({
  viewMode: 'grid',
  selectedBookId: null,
  modal: null,
  conflictCount: 0,
  isDraggingFiles: false,
  contextMenu: null,
  deletingBookId: null,
  editingBookId: null,

  setViewMode: (viewMode) => set({ viewMode }),
  selectBook: (selectedBookId) => set({ selectedBookId }),
  openModal: (modal) => set({ modal }),
  setConflictCount: (conflictCount) => set({ conflictCount }),
  setDraggingFiles: (isDraggingFiles) => set({ isDraggingFiles }),
  openContextMenu: (contextMenu) => set({ contextMenu }),
  closeContextMenu: () => set({ contextMenu: null }),
  // Opening either dialog always dismisses the menu that launched it
  requestDelete: (deletingBookId) => set({ deletingBookId, contextMenu: null }),
  requestEdit: (editingBookId) => set({ editingBookId, contextMenu: null })
}))
