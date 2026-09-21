import { useEffect, useState } from 'react'
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

function CandidateValue({
  field,
  value,
  preview,
  loading
}: {
  field: string
  value: string
  /** A `data:` image for this candidate, when one could be fetched at all. */
  preview?: string
  /** True while the previews are still on their way. */
  loading?: boolean
}) {
  if (field === 'cover') {
    // A candidate is an image *URL*, and the CSP allows no remote origin in
    // `img-src` — so this used to render an empty box for every choice, and a
    // person picked a jacket they could not see. The preview arrives as a data
    // URL from the sidecar (the image crosses a boundary it may not fetch
    // across); with no preview the tile *says* so rather than going blank.
    if (preview) {
      return (
        <img
          src={preview}
          alt=""
          className="mx-auto max-h-48 rounded shadow-cover"
          draggable={false}
        />
      )
    }
    return (
      <span className="mx-auto flex h-32 w-full items-center justify-center gap-2 rounded border border-ink-700 bg-ink-900 px-3 text-center text-[11px] leading-snug text-parchment-faint">
        {loading ? (
          <>
            <SpinnerIcon className="h-3 w-3" />
            Loading preview…
          </>
        ) : (
          'Preview unavailable — the image could not be fetched'
        )}
      </span>
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
  /**
   * Previews for a cover conflict's candidates, keyed by their URL. Only a cover
   * needs this: the candidate *is* an image URL, and the renderer may not fetch
   * a remote image itself (the CSP names no `https:` origin), so the picture has
   * to come from the sidecar as a data URL.
   *
   * The result is stored *with the key it answers*, so a stale map is simply not
   * read instead of being cleared by an effect that would cascade a render — and
   * `previews === null` means "not here for these candidates", which is what the
   * tiles render as loading.
   */
  const [coverPreviews, setCoverPreviews] = useState<{
    key: string
    map: Record<string, string>
  } | null>(null)
  const coverKey = JSON.stringify(
    conflict.field === 'cover' ? conflict.candidates.map((c) => c.value) : []
  )
  const previews = coverPreviews?.key === coverKey ? coverPreviews.map : null

  useEffect(() => {
    const urls: string[] = JSON.parse(coverKey) as string[]
    if (!urls.length) return
    let live = true
    window.Musaeum.metadata
      .coverPreviews(urls)
      .then((map) => {
        if (live) setCoverPreviews({ key: coverKey, map })
      })
      .catch(() => {
        // Losing the preview costs the picture, never the choice: the tiles say
        // so, and picking one still applies it (the download happens in the
        // main process, where the URL is fetched fine)
        if (live) setCoverPreviews({ key: coverKey, map: {} })
      })
    return () => {
      live = false
    }
    // The candidate URLs *are* the key, so this re-runs when the set changes
    // rather than on every render — hence the string, and hence it alone here.
  }, [coverKey])

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
            <CandidateValue
              field={conflict.field}
              value={c.value}
              preview={previews?.[c.value]}
              loading={previews === null && conflict.field === 'cover'}
            />
          </button>
        ))}
      </div>

      {error && <p className="mt-2 text-[12px] text-danger-400">{error}</p>}
    </div>
  )
}
