import { create } from 'zustand'

export type ViewMode = 'grid' | 'list'
export type ActiveModal = 'conflicts' | 'migration' | null

interface UIState {
  viewMode: ViewMode
  selectedBookId: string | null
  modal: ActiveModal
  conflictCount: number
  isDraggingFiles: boolean

  setViewMode(mode: ViewMode): void
  selectBook(id: string | null): void
  openModal(modal: ActiveModal): void
  setConflictCount(count: number): void
  setDraggingFiles(dragging: boolean): void
}

export const useUIStore = create<UIState>((set) => ({
  viewMode: 'grid',
  selectedBookId: null,
  modal: null,
  conflictCount: 0,
  isDraggingFiles: false,

  setViewMode: (viewMode) => set({ viewMode }),
  selectBook: (selectedBookId) => set({ selectedBookId }),
  openModal: (modal) => set({ modal }),
  setConflictCount: (conflictCount) => set({ conflictCount }),
  setDraggingFiles: (isDraggingFiles) => set({ isDraggingFiles })
}))
