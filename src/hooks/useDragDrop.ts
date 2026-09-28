import { useEffect } from 'react'
import { isBookFile } from '@shared/book.types'
import { isImportDrag } from '@/lib/book-drag'
import { useUIStore } from '@/stores/ui.store'

/**
 * Window-level drag-and-drop import. Files dropped anywhere on the app are
 * resolved to paths in the preload and handed to the import pipeline.
 *
 * The overlay's gate is `isImportDrag` (`src/lib/book-drag.ts`) — the same
 * predicate the book drag's MIME type is tested against, so the overlay's
 * answer and that drag's MIME cannot drift apart. The *file* gate below stays
 * `isBookFile` from `@shared/book.types`, not a list of its own:
 * this hook and the File picker (`import:fromDialog`) have to accept the same
 * files, and the one time this list lived here alone it kept the old three
 * formats after PDF went first-class — a dropped PDF was silently discarded,
 * because a file the gate rejects never reaches main and so never fails.
 */
export function useDragDrop(): void {
  const setDraggingFiles = useUIStore((s) => s.setDraggingFiles)

  useEffect(() => {
    let depth = 0

    const onDragEnter = (e: DragEvent) => {
      e.preventDefault()
      if (isImportDrag([...(e.dataTransfer?.types ?? [])]) && ++depth === 1) {
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
