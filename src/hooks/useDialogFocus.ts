import { useCallback, useRef } from 'react'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * Focus for a modal: move it in when the dialog appears, keep Tab inside it,
 * and hand it back to whatever held it when the dialog goes.
 *
 * Returns a callback ref for the `role="dialog"` element rather than taking a
 * ref object, because the dialogs render conditionally (the editor returns
 * null until it has a book) — a mount effect would run before the element
 * exists. Initial focus goes to `[data-autofocus]` when present (a destructive
 * dialog puts it on Cancel), else the first focusable, else the dialog itself.
 *
 * Escape stays each dialog's own window listener; only Tab is handled here.
 */
export function useDialogFocus(): (el: HTMLElement | null) => void {
  const detach = useRef<(() => void) | null>(null)

  return useCallback((el: HTMLElement | null) => {
    detach.current?.()
    detach.current = null
    if (!el) return

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE))
    ;(el.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? el).focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const items = focusables()
      if (!items.length) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || !el.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !el.contains(active))) {
        e.preventDefault()
        first.focus()
      }
    }
    // On the document, so a Tab pressed while focus has escaped (a click on the
    // scrim) is still pulled back inside
    document.addEventListener('keydown', onKey)
    detach.current = () => {
      document.removeEventListener('keydown', onKey)
      if (opener?.isConnected) opener.focus()
    }
  }, [])
}
