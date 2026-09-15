import { useUIStore } from '@/stores/ui.store'

/**
 * Report a rejected action on screen, where the old `alert()` put a modal
 * dialog in the way of it.
 *
 * The message is the error's own text: these are the errors the main process
 * writes for a person to read ("Library is offline", "No book file found"),
 * and re-wording them here would only make them harder to search for.
 */
export function notifyError(err: unknown): void {
  useUIStore
    .getState()
    .notify({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
}
