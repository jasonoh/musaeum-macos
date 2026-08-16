import { useEffect } from 'react'
import { useUIStore } from '@/stores/ui.store'

/**
 * Run native menu commands against the UI stores. Mount once at app root.
 *
 * Every command has an in-app equivalent (the sidebar's gear, the toolbar's
 * view toggle) — the menu only adds the keyboard route to them.
 */
export function useMenuCommands(): void {
  useEffect(
    () =>
      window.Musaeum.on.menuCommand((cmd) => {
        const { openModal, setViewMode } = useUIStore.getState()
        if (cmd === 'open-settings') openModal('settings')
        else if (cmd === 'view-grid') setViewMode('grid')
        else if (cmd === 'view-list') setViewMode('list')
        else if (cmd === 'select-all') {
          // Text fields keep ⌘A: the menu item took the accelerator away from
          // the `selectAll` role, so this hands it back where it belongs.
          const el = document.activeElement
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select()
          else useUIStore.getState().selectAllBooks()
        }
      }),
    []
  )
}
