import { useEffect } from 'react'
import { useUIStore } from '@/stores/ui.store'

const BOOK_EXTENSIONS = ['.epub', '.mobi', '.azw3', '.pdf']

/**
 * Whether a dropped file is one the import pipeline accepts. Exported so the
 * list has a decider: PDF became a first-class format in Phase 1.5 and this
 * gate was the one place that kept the old three, which made a dropped PDF a
 * silent no-op (`if (!files.length) return` below, with nothing said).
 */
export function isBookFile(name: string): boolean {
  const lower = name.toLowerCase()
  return BOOK_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * Window-level drag-and-drop import. Files dropped anywhere on the app are
 * resolved to paths in the preload and handed to the import pipeline.
 */
export function useDragDrop(): void {
  const setDraggingFiles = useUIStore((s) => s.setDraggingFiles)

  useEffect(() => {
    let depth = 0

    const onDragEnter = (e: DragEvent) => {
      e.preventDefault()
      if (e.dataTransfer?.types.includes('Files') && ++depth === 1) {
        setDraggingFiles(true)
      }
    }
    const onDragOver = (e: DragEvent) => e.preventDefault()
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault()
      if (depth > 0 && --depth === 0) setDraggingFiles(false)
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDraggingFiles(false)
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => isBookFile(f.name))
      if (!files.length) return
      const paths = files.map((f) => window.Musaeum.files.getPathForFile(f))
      // Progress arrives via the importProgress event stream
      void window.Musaeum.import.addFiles(paths).catch((err) => console.error(err))
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [setDraggingFiles])
}
