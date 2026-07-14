import { Sidebar } from '@/components/layout/Sidebar'
import { Toolbar } from '@/components/layout/Toolbar'
import { StatusBar } from '@/components/layout/StatusBar'
import { GridView } from '@/components/library/GridView'
import { ListView } from '@/components/library/ListView'
import { BookDetail } from '@/components/library/BookDetail'
import { ImportOverlay } from '@/components/library/ImportOverlay'
import { ConflictQueue } from '@/components/metadata/ConflictQueue'
import { MigrationWizard } from '@/components/migration/MigrationWizard'
import { NASStatusBanner } from '@/components/shared/NASStatusBanner'
import { useDevice } from '@/hooks/useDevice'
import { useDragDrop } from '@/hooks/useDragDrop'
import { useLibrary } from '@/hooks/useLibrary'
import { useNASStatus } from '@/hooks/useNASStatus'
import { useUIStore } from '@/stores/ui.store'

export default function App() {
  useLibrary()
  useNASStatus()
  useDevice()
  useDragDrop()

  const viewMode = useUIStore((s) => s.viewMode)
  const modal = useUIStore((s) => s.modal)

  return (
    <div className="flex h-full">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <Toolbar />
        <NASStatusBanner />
        <main className="min-h-0 flex-1">
          {viewMode === 'grid' ? <GridView /> : <ListView />}
        </main>
        <StatusBar />
      </div>

      <BookDetail />
      <ImportOverlay />

      {modal === 'conflicts' && <ConflictQueue />}
      {modal === 'migration' && <MigrationWizard />}
    </div>
  )
}
