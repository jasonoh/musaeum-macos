import { notifyError } from '@/lib/notify'

/**
 * Add Books → Import files…, and File ▸ Add Books… (⌘O).
 *
 * One function for both doors. The design's rule for the native menu is that an
 * item and its in-app control share one code path so they cannot drift apart
 * (`docs/invariants/menu-and-branding.md`); ⌘O opens the toolbar menu's *first*
 * item directly rather than a second picker of its own, so this is that path.
 *
 * The picker runs in main (`import:fromDialog`) because the renderer may not
 * open a native dialog and never gets a `file://` path of its own making — the
 * paths travel back over IPC and re-enter the pipeline exactly as a drop does.
 * Nothing here reports progress: the import overlay already owns that, fed by
 * the `importProgress` event stream, and it outlives this call.
 */
export async function importBooksFromDialog(): Promise<void> {
  try {
    const paths = await window.Musaeum.import.fromDialog()
    // A cancelled dialog is not a failure and has nothing to say — an empty
    // list is the shape the handler answers with, so this is one check, not two
    if (!paths.length) return
    await window.Musaeum.import.addFiles(paths)
  } catch (err) {
    notifyError(err)
  }
}
