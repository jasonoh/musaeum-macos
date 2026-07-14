import { useState } from 'react'
import { useLibraryStore, type FacetKind } from '@/stores/library.store'
import { CheckIcon, ChevronIcon } from './icons'

const READ_STATUS_LABELS: Record<string, string> = {
  unread: 'Unread',
  reading: 'Reading',
  read: 'Read'
}

interface FacetGroupProps {
  label: string
  kind: FacetKind
  items: { value: string; count: number }[]
  format?: (value: string) => string
}

function FacetGroup({ label, kind, items, format }: FacetGroupProps) {
  const [open, setOpen] = useState(kind === 'formats' || kind === 'readStatus')
  const [showAll, setShowAll] = useState(false)
  const filters = useLibraryStore((s) => s.filters)
  const toggleFilter = useLibraryStore((s) => s.toggleFilter)

  if (!items.length) return null
  const active = new Set((filters[kind] as string[] | undefined) ?? [])
  const visible = showAll ? items : items.slice(0, 6)

  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 px-1 py-1 text-[11px] font-semibold uppercase tracking-widest text-parchment-faint hover:text-parchment-dim"
      >
        <ChevronIcon className="h-3 w-3" open={open} />
        {label}
      </button>
      {open && (
        <div className="mt-0.5 space-y-px">
          {visible.map(({ value, count }) => {
            const selected = active.has(value)
            return (
              <button
                key={value}
                onClick={() => toggleFilter(kind, value)}
                className={`group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] transition-colors ${
                  selected
                    ? 'bg-gold-500/15 text-gold-300'
                    : 'text-parchment-dim hover:bg-ink-800 hover:text-parchment'
                }`}
              >
                <span
                  className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${
                    selected ? 'border-gold-400 bg-gold-500 text-ink-950' : 'border-ink-600'
                  }`}
                >
                  {selected && <CheckIcon className="h-2.5 w-2.5" />}
                </span>
                <span className="truncate">{format ? format(value) : value}</span>
                <span className="ml-auto text-[11px] tabular-nums text-parchment-faint">
                  {count}
                </span>
              </button>
            )
          })}
          {items.length > 6 && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="px-2 py-0.5 text-[12px] text-gold-400/80 hover:text-gold-300"
            >
              {showAll ? 'Show less' : `Show all ${items.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function FilterSidebar() {
  const facets = useLibraryStore((s) => s.facets)
  const filters = useLibraryStore((s) => s.filters)
  const clearFilters = useLibraryStore((s) => s.clearFilters)

  if (!facets) return null
  const hasActive = Object.keys(filters).length > 0

  return (
    <div className="px-2">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-parchment-faint">
          Filters
        </span>
        {hasActive && (
          <button
            onClick={clearFilters}
            className="text-[11px] text-gold-400 hover:text-gold-300"
          >
            Clear
          </button>
        )}
      </div>
      <FacetGroup label="Format" kind="formats" items={facets.formats} format={(v) => v.toUpperCase()} />
      <FacetGroup
        label="Status"
        kind="readStatus"
        items={facets.readStatus}
        format={(v) => READ_STATUS_LABELS[v] ?? v}
      />
      <FacetGroup label="Series" kind="series" items={facets.series} />
      <FacetGroup label="Authors" kind="authors" items={facets.authors} />
      <FacetGroup label="Tags" kind="tags" items={facets.tags} />
    </div>
  )
}
