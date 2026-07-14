import { useEffect, useRef, useState } from 'react'
import { useLibraryStore } from '@/stores/library.store'
import { CloseIcon, SearchIcon } from './icons'

export function SearchBar() {
  const setQuery = useLibraryStore((s) => s.setQuery)
  const [value, setValue] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout>>()

  // Debounce keystrokes — FTS is fast but no need to query per key
  useEffect(() => {
    timer.current = setTimeout(() => setQuery(value), 150)
    return () => clearTimeout(timer.current)
  }, [value, setQuery])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        document.getElementById('musaeum-search')?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app-no-drag group relative w-full max-w-md">
      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-parchment-faint group-focus-within:text-gold-400" />
      <input
        id="musaeum-search"
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search titles, authors, series…"
        className="w-full rounded-lg border border-ink-700 bg-ink-850 py-1.5 pl-9 pr-8 text-sm text-parchment placeholder:text-parchment-faint focus:border-gold-500/60"
      />
      {value && (
        <button
          onClick={() => setValue('')}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-parchment-faint hover:text-parchment"
          aria-label="Clear search"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
