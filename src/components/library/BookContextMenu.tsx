import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLibraryStore } from '@/stores/library.store'
import { useUIStore } from '@/stores/ui.store'
import { BookIcon, TrashIcon } from '@/components/shared/icons'

const MARGIN = 8

/** Right-click menu for a book in the grid or list. Mounted once at app root. */
export function BookContextMenu() {
  const target = useUIStore((s) => s.contextMenu)
  const closeContextMenu = useUIStore((s) => s.closeContextMenu)
  const selectBook = useUIStore((s) => s.selectBook)
  const requestDelete = useUIStore((s) => s.requestDelete)
  const books = useLibraryStore((s) => s.books)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: target?.x ?? 0, y: target?.y ?? 0 })

  // Flip the menu back inside the window when it would overflow an edge
  useLayoutEffect(() => {
    if (!target || !ref.current) return
    const { width, height } = ref.current.getBoundingClientRect()
    setPos({
      x: Math.min(target.x, window.innerWidth - width - MARGIN),
      y: Math.min(target.y, window.innerHeight - height - MARGIN)
    })
  }, [target])

  useEffect(() => {
    if (!target) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeContextMenu()
    const onScroll = () => closeContextMenu()
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onScroll)
    // Capture phase: a scroll inside the grid doesn't bubble to window
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [target, closeContextMenu])

  if (!target) return null
  const book = books.find((b) => b.id === target.bookId)
  if (!book) return null

  return (
    <div className="fixed inset-0 z-50" onClick={closeContextMenu} onContextMenu={closeContextMenu}>
      <div
        ref={ref}
        role="menu"
        onClick={(e) => e.stopPropagation()}
        style={{ left: pos.x, top: pos.y }}
        className="absolute w-52 animate-fade-in overflow-hidden rounded-lg border border-ink-700 bg-ink-850 py-1 shadow-cover-lift"
      >
        <p className="truncate px-3 py-1 font-display text-[12px] text-parchment-faint">
          {book.title}
        </p>
        <div className="my-1 h-px bg-ink-700" />
        <MenuItem
          icon={<BookIcon className="h-3.5 w-3.5" />}
          label="View details"
          onClick={() => {
            selectBook(book.id)
            closeContextMenu()
          }}
        />
        <MenuItem
          icon={<TrashIcon className="h-3.5 w-3.5" />}
          label={book.formats.length > 1 ? 'Delete…' : 'Delete book…'}
          danger
          onClick={() => requestDelete(book.id)}
        />
      </div>
    </div>
  )
}

function MenuItem({
  icon,
  label,
  danger,
  onClick
}: {
  icon: React.ReactNode
  label: string
  danger?: boolean
  onClick(): void
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] ${
        danger
          ? 'text-parchment-dim hover:bg-red-500/15 hover:text-red-400'
          : 'text-parchment-dim hover:bg-ink-800 hover:text-parchment'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}
