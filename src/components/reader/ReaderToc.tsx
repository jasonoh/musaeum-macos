import { useReaderStore } from '@/stores/reader.store'

/** Indent per TOC level, in rem — deep trees stop indenting rather than run off. */
const INDENT_REM = 0.75
const MAX_DEPTH = 4

export function ReaderToc({ onNavigate }: { onNavigate: (href: string) => void }) {
  const toc = useReaderStore((s) => s.toc)
  const toggleToc = useReaderStore((s) => s.toggleToc)

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-ink-800 bg-ink-950">
      <div className="shrink-0 px-5 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-widest text-parchment-faint">
        Contents
      </div>
      {toc.length === 0 ? (
        <p className="px-5 py-2 text-[13px] italic text-parchment-faint">
          This book has no table of contents.
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto pb-6">
          {toc.map((item, i) => (
            <li key={`${item.href}-${i}`}>
              <button
                onClick={() => {
                  onNavigate(item.href)
                  toggleToc()
                }}
                style={{ paddingLeft: `${1.25 + Math.min(item.depth ?? 0, MAX_DEPTH) * INDENT_REM}rem` }}
                className={`w-full py-1.5 pr-4 text-left text-[13px] leading-5 transition-colors hover:bg-ink-900 hover:text-gold-300 ${
                  (item.depth ?? 0) === 0 ? 'text-parchment-dim' : 'text-parchment-faint'
                }`}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
