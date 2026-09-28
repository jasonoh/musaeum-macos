import { useEffect } from 'react'
import { clearDragPayload } from '@/lib/book-drag'

/**
 * The other end of a book drag: the payload is cleared when the drag is over.
 *
 * On the **window**, not on the source element (D9). The source cannot be
 * trusted to be there at the end: both views are virtualized, so a row scrolled
 * out mid-drag unmounts and its `dragend` never fires — and a payload that
 * outlives its drag is a payload the *next* drop can pick up (Review Focus 1).
 *
 * Mounted once, from `App.tsx`, beside `useDragDrop` — which is the same shape
 * of concern (a window-level drag listener) for the other kind of drag.
 */
export function useBookDrag(): void {
  useEffect(() => {
    const clear = () => clearDragPayload()
    window.addEventListener('drop', clear)
    window.addEventListener('dragend', clear)
    return () => {
      window.removeEventListener('drop', clear)
      window.removeEventListener('dragend', clear)
    }
  }, [])
}
