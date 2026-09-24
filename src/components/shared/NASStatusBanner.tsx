import { useNASStore } from '@/stores/nas.store'
import { useLibraryStore } from '@/stores/library.store'
import { RefreshIcon, SpinnerIcon, WarningIcon } from './icons'

/** The picker's button — one control, named for the moment it appears in. */
const PICKER_BUTTON =
  'ml-auto shrink-0 rounded-md bg-gold-500 px-3 py-1 font-medium text-ink-950 hover:bg-gold-400'

/**
 * Non-blocking banner shown while the library is unreachable. Browsing and
 * search stay available from the SQLite cache; writes are disabled.
 *
 * **Every word is the main process's.** `status.copy` carries the sentence, the
 * row label and *which recovery this state offers* (D4), so what is decided here
 * is which control to draw and never what to say. Before this slice it branched
 * on `state` itself — which is how a library that is a folder on this Mac was
 * read the sentence a dropped share gets, beside a *Retry Now* that shelled an
 * SMB mount against a server its owner does not have.
 */
export function NASStatusBanner() {
  const status = useNASStore((s) => s.status)
  const reconnecting = useNASStore((s) => s.reconnecting)
  const reconnect = useNASStore((s) => s.reconnect)
  const load = useLibraryStore((s) => s.load)
  const copy = status?.copy

  // Null for `connected`, and null until the first status read lands.
  if (!copy?.message) return null

  /**
   * Take what the picker returned. Both picker buttons come through here,
   * because the difference between them is the *hint*, not the flow: picking a
   * root adopts the catalog that is in it, and a library found elsewhere is a
   * library this window has to load.
   */
  const choose = (locateAt?: string) =>
    void window.Musaeum.nas.chooseLibraryRoot(locateAt).then((path) => {
      if (path) void load()
    })

  return (
    <div className="flex items-center gap-3 border-b border-gold-600/30 bg-gold-600/10 px-4 py-2 text-sm animate-fade-in">
      <WarningIcon className="h-4 w-4 shrink-0 text-gold-400" />
      <span className="text-parchment-dim">{copy.message}</span>

      {copy.recovery === 'choose' && (
        <button onClick={() => choose()} className={PICKER_BUTTON}>
          Choose Library Folder
        </button>
      )}

      {/* A gone folder has nothing to retry (D2), so this **replaces** the
          *Retry Now* the state used to show rather than sitting beside it — a
          button whose only effect is a no-op is worse than an absent one. The
          hint is the root that went missing, which the main process resolves to
          its nearest surviving ancestor. */}
      {copy.recovery === 'locate' && (
        <button onClick={() => choose(status?.libraryRoot ?? undefined)} className={PICKER_BUTTON}>
          Locate Library Folder…
        </button>
      )}

      {copy.recovery === 'retry' && (
        <button
          onClick={() => void reconnect()}
          disabled={reconnecting}
          className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md border border-gold-500/50 px-3 py-1 font-medium text-gold-300 hover:bg-gold-500/10 disabled:opacity-50"
        >
          {reconnecting ? (
            <SpinnerIcon className="h-3.5 w-3.5" />
          ) : (
            <RefreshIcon className="h-3.5 w-3.5" />
          )}
          Retry Now
        </button>
      )}
    </div>
  )
}
