import { Sidebar } from '@/components/layout/Sidebar'
import { Toolbar } from '@/components/layout/Toolbar'
import { StatusBar } from '@/components/layout/StatusBar'
import { GridView } from '@/components/library/GridView'
import { ListView } from '@/components/library/ListView'
import { BookContextMenu } from '@/components/library/BookContextMenu'
import { BookDetail } from '@/components/library/BookDetail'
import { BookEditor } from '@/components/library/BookEditor'
import { CoverPicker } from '@/components/library/CoverPicker'
import { DeleteBookDialog } from '@/components/library/DeleteBookDialog'
import { DeleteSelectionDialog } from '@/components/library/DeleteSelectionDialog'
import { ImportOverlay } from '@/components/library/ImportOverlay'
import { RemoveFromDeviceDialog } from '@/components/library/RemoveFromDeviceDialog'
import { ShelfPicker } from '@/components/library/ShelfPicker'
import { SelectionPanel } from '@/components/library/SelectionPanel'
import { ConflictQueue } from '@/components/metadata/ConflictQueue'
import { MigrationWizard } from '@/components/migration/MigrationWizard'
import { ReaderView } from '@/components/reader/ReaderView'
import { SettingsModal } from '@/components/settings/SettingsModal'
import { NASStatusBanner } from '@/components/shared/NASStatusBanner'
import { Toasts } from '@/components/shared/Toasts'
import { useAi } from '@/hooks/useAi'
import { useDevice } from '@/hooks/useDevice'
import { useDragDrop } from '@/hooks/useDragDrop'
import { useLibrary } from '@/hooks/useLibrary'
import { useMenuCommands } from '@/hooks/useMenuCommands'
import { useNASStatus } from '@/hooks/useNASStatus'
import { usePythonEnv } from '@/hooks/usePythonEnv'
import { useTheme } from '@/hooks/useTheme'
import { useUIStore } from '@/stores/ui.store'

export default function App() {
  useLibrary()
  useNASStatus()
  useDevice()
  useAi()
  useDragDrop()
  useMenuCommands()
  usePythonEnv()
  useTheme()

  const viewMode = useUIStore((s) => s.viewMode)
  const modal = useUIStore((s) => s.modal)
  const deletingBookId = useUIStore((s) => s.deletingBookId)
  const deletingSelection = useUIStore((s) => s.deletingSelection)
  const editingBookId = useUIStore((s) => s.editingBookId)
  const coverPickerBookId = useUIStore((s) => s.coverPickerBookId)

  return (
    <div className="flex h-full">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <Toolbar />
        <NASStatusBanner />
        <main className="min-h-0 flex-1">{viewMode === 'grid' ? <GridView /> : <ListView />}</main>
        <StatusBar />
      </div>

      <BookDetail />
      {/* Both return null unless they own the current selection — one book for
          the detail panel, two or more for the selection panel */}
      <SelectionPanel />
      <ImportOverlay />
      <BookContextMenu />
      {/* Keyed so each book opens the dialog with a fresh format selection */}
      {deletingBookId && <DeleteBookDialog key={deletingBookId} />}
      {deletingSelection && <DeleteSelectionDialog />}
      {/* Keyed so the form re-initializes from whichever book is being edited */}
      {editingBookId && <BookEditor key={editingBookId} />}
      {/* Keyed so each book opens the picker with its own gather in flight, and
          so a switch of book cannot leave the previous book's tiles on screen */}
      {coverPickerBookId && <CoverPicker key={coverPickerBookId} />}
      <RemoveFromDeviceDialog />
      <ShelfPicker />
      <ReaderView />

      {modal === 'conflicts' && <ConflictQueue />}
      {modal === 'migration' && <MigrationWizard />}
      {modal === 'settings' && <SettingsModal />}

      {/* Last, and above the modals: it is the report for work that finished
          while the user was somewhere else */}
      <Toasts />
    </div>
  )
}
