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
      }),
    []
  )
}
