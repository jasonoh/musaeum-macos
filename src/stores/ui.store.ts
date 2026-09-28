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

export type ToastKind = 'success' | 'info' | 'error'

/**
 * A transient report of something that finished out of the user's sight — a
 * metadata refresh, a failed action. Deliberately not a dialog: the point is
 * to say what happened, not to interrupt.
 */
export interface Toast {
  id: number
  kind: ToastKind
  message: string
  /** Second line: the specifics — what changed, or why it failed. */
  detail?: string
  action?: { label: string; run(): void }
}

/** How long each kind stays on screen. Errors are worth reading. */
const TOAST_LIFE_MS: Record<ToastKind, number> = {
  success: 6000,
  info: 7000,
  error: 12000
}

/** Beyond this the oldest goes: three is a report, more is a wall. */
const MAX_TOASTS = 3

let nextToastId = 1
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>()

function scheduleDismiss(id: number, kind: ToastKind): void {
  // Resolved at fire time, so a toast that is re-notified under the same id
  // (none today) or dismissed early can't be resurrected by a stale callback
  toastTimers.set(
    id,
    setTimeout(() => useUIStore.getState().dismissToast(id), TOAST_LIFE_MS[kind])
  )
}

function clearTimer(id: number): void {
  const timer = toastTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    toastTimers.delete(id)
  }
}

export interface NotifyInput {
  kind: ToastKind
  message: string
  detail?: string
  action?: { label: string; run(): void }
}

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
  /** Book whose cover picker is open. */
  coverPickerBookId: string | null
  /** Book + device whose "remove from device" confirmation is open. */
  removingFromDevice: DeviceRemovalTarget | null
  /**
   * Books the *Add to Shelf…* picker is open for — the scope of the click or of
   * the selection. A list rather than a single id because the picker is the same
   * dialog for one book and for twelve: what changes is which shelves are
   * ticked, and only a single book is ever ticked (D9).
   */
  shelfPicker: { bookIds: string[] } | null
  /**
   * What the shelf's own remove dialog is open for: the shelf, and the books the
   * trash entry point was pressed for (D9). Set by the two trash actions below
   * *only* while a shelf is open; its second button hands over to
   * `deletingBookId`/`deletingSelection`, which stay the only place anything is
   * deleted.
   */
  shelfRemove: { shelfId: string; bookIds: string[] } | null
  /**
   * Latest word from the first-launch Python bootstrap, or null once it has
   * finished cleanly. A failure is kept so the status bar can keep saying why
   * metadata features are unavailable.
   */
  pythonEnv: PythonEnvProgress | null
  /** Transient reports, newest last. */
  toasts: Toast[]
  /**
   * Books whose metadata is being re-fetched right now, keyed by id. In the
   * store rather than in the button, because the fetch outlives the panel it
   * was started from — the card behind it still says the book is working.
   */
  refreshingBooks: Record<string, true>

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
  closeContextMenu(): void
  requestDelete(bookId: string | null): void
  requestSelectionDelete(open: boolean): void
  requestEdit(bookId: string | null): void
  requestCoverPicker(bookId: string | null): void
  requestDeviceRemoval(target: DeviceRemovalTarget | null): void
  /** Books the *Add to Shelf…* picker is open for, or null. */
  requestShelfPicker(target: { bookIds: string[] } | null): void
  /** The shelf's own remove dialog, or null to close it. */
  requestShelfRemove(target: { shelfId: string; bookIds: string[] } | null): void
  /** The remove dialog's second answer: the library delete, as it always was. */
  requestLibraryDelete(): void
  setPythonEnv(progress: PythonEnvProgress | null): void
  /** Show a transient report; returns its id for callers that dismiss early. */
  notify(input: NotifyInput): number
  dismissToast(id: number): void
  setBookRefreshing(bookId: string, refreshing: boolean): void
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

/**
 * What outlives the session: the view choice, and nothing else.
 *
 * Exported rather than left inline so the rule has a decider. The store
 * persists through zustand's middleware, and the test environment is `node`
 * with no `localStorage`, so a case that reached for `.persist` would be
 * asserting about a storage backend instead of about what is kept — while this
 * function *is* the whole of "what is kept", and a fourth dialog's open flag
 * added to the state without landing here is the mistake worth catching (every
 * one of these is about what is on screen right now, and a dialog that reopens
 * itself on the next launch has no business doing so).
 */
export const persistedUIState = (s: UIState): Pick<UIState, 'viewMode'> => ({
  viewMode: s.viewMode
})

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      viewMode: 'grid',
      selection: EMPTY_SELECTION,
      modal: null,
      conflictCount: 0,
      isDraggingFiles: false,
      contextMenu: null,
      deletingBookId: null,
      deletingSelection: false,
      editingBookId: null,
      coverPickerBookId: null,
      removingFromDevice: null,
      shelfPicker: null,
      shelfRemove: null,
      pythonEnv: null,
      toasts: [],
      refreshingBooks: {},

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
      // A right-click opens the menu and changes nothing else — it is not a
      // click. It used to make the clicked book the selection first (Finder's
      // rule), which opened the details panel beside the menu: the panel
      // renders from the derived single selection. The menu reads its own
      // scope from the click instead (`contextMenuScope`).
      openContextMenu: (contextMenu) => set({ contextMenu }),
      closeContextMenu: () => set({ contextMenu: null }),
      // Opening any dialog always dismisses the menu that launched it.
      //
      // The trash entry points, shelf-aware (D9, AC21): with no shelf open these
      // are the two lines they have always been; with one open they ask the
      // question the user actually meant first — *off the shelf*, or *out of the
      // library* — and the remove dialog's second answer hands over to the two
      // flags below, so `deletingBookId`/`deletingSelection` remain the only
      // road to a deletion. The cross-store read is the same one-way
      // `bookOrder()` already makes from here.
      requestDelete: (bookId) => {
        const shelfId = useLibraryStore.getState().activeShelfId
        if (bookId !== null && shelfId) {
          set({ shelfRemove: { shelfId, bookIds: [bookId] }, contextMenu: null })
          return
        }
        set({ deletingBookId: bookId, contextMenu: null })
      },
      requestSelectionDelete: (open) => {
        const shelfId = useLibraryStore.getState().activeShelfId
        const bookIds = [...get().selection.ids]
        if (open && shelfId && bookIds.length > 0) {
          set({ shelfRemove: { shelfId, bookIds }, contextMenu: null })
          return
        }
        set({ deletingSelection: open, contextMenu: null })
      },
      requestEdit: (editingBookId) => set({ editingBookId, contextMenu: null }),
      // Both entry points (the detail panel's cover, the context menu) open the
      // one dialog, so the menu has to go the way every other dialog's does
      requestCoverPicker: (coverPickerBookId) => set({ coverPickerBookId, contextMenu: null }),
      requestDeviceRemoval: (removingFromDevice) => set({ removingFromDevice, contextMenu: null }),
      // Same rule as every other dialog: the menu that opened it goes
      requestShelfPicker: (shelfPicker) => set({ shelfPicker, contextMenu: null }),
      requestShelfRemove: (shelfRemove) => set({ shelfRemove }),
      requestLibraryDelete: () => {
        const { shelfRemove } = get()
        if (!shelfRemove) return
        const single = shelfRemove.bookIds.length === 1
        set({
          shelfRemove: null,
          deletingBookId: single ? shelfRemove.bookIds[0] : null,
          deletingSelection: !single
        })
      },
      setPythonEnv: (pythonEnv) => set({ pythonEnv }),

      notify: (input) => {
        const id = nextToastId++
        const toast: Toast = {
          id,
          kind: input.kind,
          message: input.message,
          detail: input.detail,
          action: input.action
        }
        const previous = get().toasts
        // A re-click, or a job reporting the same summary twice, refreshes the
        // toast that is already up rather than stacking a twin next to it
        const toasts = [
          ...previous.filter((t) => t.message !== toast.message || t.detail !== toast.detail),
          toast
        ]
        // Oldest first out of the way — three reports is information, more is
        // a wall. Their timers go with them, so a dropped toast can't fire a
        // dismissal for an id that has been reused by nothing at all.
        const overflow = toasts.length - MAX_TOASTS
        if (overflow > 0) toasts.splice(0, overflow)

        const kept = new Set(toasts.map((t) => t.id))
        for (const t of previous) if (!kept.has(t.id)) clearTimer(t.id)

        set({ toasts })
        scheduleDismiss(id, toast.kind)
        return id
      },

      dismissToast: (id) => {
        clearTimer(id)
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
      },

      setBookRefreshing: (bookId, refreshing) => {
        if (Boolean(get().refreshingBooks[bookId]) === refreshing) return
        set((s) => {
          const refreshingBooks = { ...s.refreshingBooks }
          if (refreshing) refreshingBooks[bookId] = true
          else delete refreshingBooks[bookId]
          return { refreshingBooks }
        })
      }
    }),
    {
      // Only the view choice outlives the session — selection, modals and
      // dialogs are all about what is on screen right now (`persistedUIState`)
      name: 'musaeum.ui',
      partialize: persistedUIState,
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
