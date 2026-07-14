import { useNASStore } from '@/stores/nas.store'
import { useLibraryStore } from '@/stores/library.store'
import { RefreshIcon, SpinnerIcon, WarningIcon } from './icons'

/**
 * Non-blocking banner shown while the library is unreachable. Browsing and
 * search stay available from the SQLite cache; writes are disabled.
 */
export function NASStatusBanner() {
  const status = useNASStore((s) => s.status)
  const reconnecting = useNASStore((s) => s.reconnecting)
  const reconnect = useNASStore((s) => s.reconnect)
  const load = useLibraryStore((s) => s.load)

  if (!status || status.state === 'connected') return null

  if (status.state === 'unconfigured') {
    return (
      <div className="flex items-center gap-3 border-b border-gold-600/30 bg-gold-600/10 px-4 py-2 text-sm animate-fade-in">
        <WarningIcon className="h-4 w-4 shrink-0 text-gold-400" />
        <span className="text-parchment-dim">
          No library folder configured — choose where Musaeum should keep your books.
        </span>
        <button
          onClick={() =>
            void window.Musaeum.nas.chooseLibraryRoot().then((path) => {
              if (path) void load()
            })
          }
          className="ml-auto shrink-0 rounded-md bg-gold-500 px-3 py-1 font-medium text-ink-950 hover:bg-gold-400"
        >
          Choose Library Folder
        </button>
      </div>
    )
  }

  const retryIn = status.nextRetryMs != null ? Math.ceil(status.nextRetryMs / 1000) : null

  return (
    <div className="flex items-center gap-3 border-b border-gold-600/30 bg-gold-600/10 px-4 py-2 text-sm animate-fade-in">
      <WarningIcon className="h-4 w-4 shrink-0 text-gold-400" />
      <span className="text-parchment-dim">
        {status.state === 'reconnecting' ? (
          'Reconnecting to the library…'
        ) : (
          <>
            Library offline — browsing from cache, editing disabled.
            {retryIn != null && ` Retrying in ${retryIn}s.`}
          </>
        )}
      </span>
      <button
        onClick={() => void reconnect()}
        disabled={reconnecting}
        className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md border border-gold-500/50 px-3 py-1 font-medium text-gold-300 hover:bg-gold-500/10 disabled:opacity-50"
      >
        {reconnecting ? <SpinnerIcon className="h-3.5 w-3.5" /> : <RefreshIcon className="h-3.5 w-3.5" />}
        Retry Now
      </button>
    </div>
  )
}
