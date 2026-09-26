import { useEffect } from 'react'
import { useLibraryStore } from '@/stores/library.store'
import { useNASStore } from '@/stores/nas.store'
import { useReaderStore } from '@/stores/reader.store'
import { useUIStore } from '@/stores/ui.store'
import { importBooksFromDialog } from '@/lib/add-books'
import { canStartCatalogSync } from '@/lib/catalog-sync'

/**
 * Run native menu commands against the UI stores. Mount once at app root.
 *
 * Every command has an in-app equivalent (the sidebar's gear and reload icon,
 * the toolbar's view toggle, the reader header's search button) — the menu
 * only adds the keyboard route to them.
 */
export function useMenuCommands(): void {
  useEffect(
    () =>
      window.Musaeum.on.menuCommand((cmd) => {
        const { openModal, setViewMode } = useUIStore.getState()
        if (cmd === 'open-settings') openModal('settings')
        else if (cmd === 'add-books') {
          // File ▸ Add Books… (⌘O) runs the Add Books menu's *first* item, not a
          // picker of its own: one function behind both doors, so the shortcut
          // and the toolbar control cannot drift apart. Nothing is awaited — the
          // import overlay reports the job, and it outlives this call.
          void importBooksFromDialog()
        } else if (cmd === 'view-grid') setViewMode('grid')
        else if (cmd === 'view-list') setViewMode('list')
        else if (cmd === 'reload-library') {
          // The key can be pressed mid-job or offline, where Settings' button
          // would be disabled — so the same predicate gates it here
          const { catalogSync, refreshLibrary } = useLibraryStore.getState()
          if (canStartCatalogSync(useNASStore.getState().status?.state, catalogSync)) {
            void refreshLibrary()
          }
        } else if (cmd === 'select-all') {
          // Text fields keep ⌘A: the menu item took the accelerator away from
          // the `selectAll` role, so this hands it back where it belongs.
          const el = document.activeElement
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select()
          else useUIStore.getState().selectAllBooks()
        } else if (cmd === 'reader-find') {
          // A no-op over the library (AC1.1): with no book open there is nothing
          // to find in, and opening a panel with no book behind it would be a
          // worse answer than the key doing nothing. `bookId` is the reader's own
          // "a book is open" — not the library's selection.
          const reader = useReaderStore.getState()
          if (reader.bookId) reader.toggleSearch()
        }
      }),
    []
  )
}
