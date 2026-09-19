import { useState } from 'react'
import type { MetadataConflict, MetadataSource } from '@shared/metadata.types'
import { SpinnerIcon } from '@/components/shared/icons'

const SOURCE_LABELS: Record<string, string> = {
  embedded: 'Embedded (EPUB)',
  calibre: 'Calibre',
  google_books: 'Google Books',
  openlibrary: 'OpenLibrary',
  goodreads: 'Goodreads'
}

const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  author: 'Author',
  series: 'Series',
  cover: 'Cover',
  description: 'Description',
  publisher: 'Publisher',
  published_date: 'Publication Date'
}

function CandidateValue({ field, value }: { field: string; value: string }) {
  if (field === 'cover') {
    return (
      <img
        src={value}
        alt=""
        className="mx-auto max-h-48 rounded shadow-cover"
        draggable={false}
      />
    )
  }
  if (field === 'series') {
    let s: { name: string; index: number; total?: number } | null
    try {
      s = JSON.parse(value)
    } catch {
      s = null // fall through to raw text
    }
    if (s) {
      return (
        <span className="font-display text-[15px] text-parchment">
          {s.name} #{s.index}
          {s.total ? ` of ${s.total}` : ''}
        </span>
      )
    }
  }
  return <span className="font-display text-[15px] leading-snug text-parchment">{value}</span>
}

interface Props {
  conflict: MetadataConflict
  onResolved: () => void
}

/** Side-by-side comparison; clicking a candidate applies it. */
export function ConflictResolver({ conflict, onResolved }: Props) {
  const [busy, setBusy] = useState<MetadataSource | null>(null)
  const [error, setError] = useState<string | null>(null)

  const choose = async (source: MetadataSource) => {
    setBusy(source)
    setError(null)
    try {
      await window.Musaeum.metadata.resolveConflict(conflict.id, { [conflict.field]: source })
      onResolved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-lg border border-ink-700 bg-ink-850 p-4">
      <p className="text-[13px] text-parchment-dim">
        <span className="font-semibold text-gold-300">
          {FIELD_LABELS[conflict.field] ?? conflict.field}
        </span>{' '}
        for <span className="font-display italic">{conflict.bookTitle}</span>
      </p>

      <div
        className={`mt-3 grid gap-3 ${
          conflict.candidates.length > 2 ? 'grid-cols-3' : 'grid-cols-2'
        }`}
      >
        {conflict.candidates.map((c) => (
          <button
            key={c.source}
            disabled={busy !== null}
            onClick={() => void choose(c.source)}
            className="group flex flex-col gap-2 rounded-md border border-ink-600 bg-ink-800 p-3 text-left transition-colors hover:border-gold-500/60 hover:bg-ink-700 disabled:opacity-60"
          >
            <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-parchment-faint group-hover:text-gold-400">
              {busy === c.source && <SpinnerIcon className="h-3 w-3" />}
              {SOURCE_LABELS[c.source] ?? c.source}
            </span>
            <CandidateValue field={conflict.field} value={c.value} />
          </button>
        ))}
      </div>

      {error && <p className="mt-2 text-[12px] text-danger-400">{error}</p>}
    </div>
  )
}
