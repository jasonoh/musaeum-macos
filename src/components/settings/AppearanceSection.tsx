import { useRef, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import type {
  ThemeOption,
  ThemeProvider,
  ThemeSwatches,
  ThemeTokens,
  ThemeVariant
} from '@shared/theme.types'
import { useThemeStore } from '@/stores/theme.store'
import {
  CheckIcon,
  ChevronIcon,
  FolderIcon,
  RefreshIcon,
  SpinnerIcon,
  WarningIcon
} from '@/components/shared/icons'

/**
 * The theme picker — the only place the UI lists themes, and the only control in
 * this dialog that applies on click.
 *
 * *Why the exception to the modal's batching.* Every other field here is a value
 * the app reads later, so a Save step costs nothing. A colour choice is its own
 * feedback loop: pressing a row derives, validates, writes and broadcasts in one
 * interaction (`theme.set`), and burying that behind ⌘↵ would hide the thing the
 * user is looking at (AC4.5). The row's reason therefore rides back on the click
 * instead of on the save.
 *
 * *Why the list folds.* The section is the first child of a dialog with one
 * scroll region, so it decides whether Library / Maintenance / Metadata are
 * reachable at all: measured on 2026-09-20 at fourteen rows it was **950 px**
 * tall and the Library heading sat 292 px below the body's visible bottom — the
 * whole first screenful was the picker. The list therefore sits behind a
 * `Select theme` disclosure whose row carries the *active* theme, so the
 * collapsed section still answers what the app looks like right now.
 *
 * *What the fold may never hide.* Two things, both reasoned: the way in (the
 * import control and the drop-box row) — burying those under a hundred rows is
 * how a picker hides its own import — and the drag feedback, which is a sentence
 * at the top rather than a highlight on the list, because the highlighted panel
 * can be a screen below the pointer while the file is over the window. The
 * disclosure is over the list and nothing else.
 *
 * *Why this owns its drop handler.* `useDragDrop` listens on the window and
 * filters to book extensions, so a dropped `.yaml` is a no-op there and stays one
 * (AC4.4) — the theme drop is received here, by a handler that knows what a
 * provider file is. Paths cross the boundary; the renderer still never reads a
 * file (`CLAUDE.md` #9 / `invariants/reader.md`).
 */

/**
 * The provider files this section accepts. `.css` is an Obsidian theme's
 * `theme.css` — the only file name that form uses, and a theme is named by the
 * folder holding it, so the *path* decides the row's id rather than the file's
 * own stem (`theme/importer.ts`, D7). A `.css` dropped from somewhere that is
 * not a theme folder still passes this filter and comes back as a reported
 * rejection: a file the user dropped on purpose is not a folder listing, and
 * A35's rule about silence is about the listing.
 *
 * These are two of the four sites A45 requires to agree; the assertion in
 * `theme.store.test.ts` reads `DROP_HINT` against this list, so a fifth form
 * cannot be accepted without being offered.
 */
const THEME_EXTENSIONS = ['.yaml', '.yml', '.itermcolors', '.css']

/**
 * One line, so the hint cannot push the rows further down than they need. The
 * tail this used to carry ("or put files in the folder below") is what the
 * drop-box row directly beneath already says.
 */
const DROP_HINT =
  'Drop a .yaml, .yml, .itermcolors or an Obsidian theme.css anywhere on this section'

/** The same sentence while a file is over the section — it replaces, never adds. */
const DROP_HINT_ACTIVE = 'Release to import'

/**
 * `native` is the built-in default, so it is named for what it is to the user
 * rather than for the arm of the union it happens to be.
 */
const PROVIDER_LABEL: Record<ThemeProvider, string> = {
  native: 'Built-in',
  base16: 'base16',
  itermcolors: 'iTerm2',
  obsidian: 'Obsidian'
}

/**
 * Above this many rows the picker offers a filter. Below it the box is chrome
 * that cannot pay for itself on a list the user can see whole; above it a
 * corpus plus a folder of imports is longer than anyone wants to scan.
 */
const FILTER_FROM = 8

const LIST_ID = 'appearance-theme-list'

const ROW_CONTROL =
  'shrink-0 rounded-md border border-ink-600 p-1.5 text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40'

export function AppearanceSection() {
  const view = useThemeStore((s) => s.view)
  const themeError = useThemeStore((s) => s.themeError)
  const lastImport = useThemeStore((s) => s.lastImport)
  const importError = useThemeStore((s) => s.importError)
  const busy = useThemeStore((s) => s.busy)
  const setTheme = useThemeStore((s) => s.setTheme)
  const importPaths = useThemeStore((s) => s.importPaths)
  const importFromDialog = useThemeStore((s) => s.importFromDialog)
  const syncFolder = useThemeStore((s) => s.syncFolder)
  const revealFolder = useThemeStore((s) => s.revealFolder)

  const [dragging, setDragging] = useState(false)
  const [openNotes, setOpenNotes] = useState<string | null>(null)
  // Local and unpersisted on purpose: a list the user finds already open (or
  // already closed) is state whose cause they cannot see, which is why this
  // dialog persists no part of itself.
  const [listOpen, setListOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Depth, not a boolean: dragleave fires for every child the pointer crosses, so
  // a plain flag flickers the highlight off while the file is still over us.
  const dragDepth = useRef(0)

  const onDragEnter = (e: DragEvent<HTMLElement>) => {
    e.preventDefault()
    if (e.dataTransfer.types.includes('Files') && ++dragDepth.current === 1) setDragging(true)
  }

  // Required for the drop to fire at all, on the whole section: the highlighted
  // panel is a small target to have to hit exactly.
  const onDragOver = (e: DragEvent<HTMLElement>) => e.preventDefault()

  const onDragLeave = (e: DragEvent<HTMLElement>) => {
    e.preventDefault()
    if (dragDepth.current > 0 && --dragDepth.current === 0) setDragging(false)
  }

  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const files = [...e.dataTransfer.files].filter((file) =>
      THEME_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext))
    )
    // A book dropped on this section stays a book: it is not ours to import, and
    // the window-level handler is already the one that owns it
    if (!files.length) return
    void importPaths(files.map((file) => window.Musaeum.files.getPathForFile(file)))
  }

  /**
   * Closing clears the query: a hidden filter would silently shorten the list
   * the next time it opens, and the section must not hold state the user cannot
   * see. Deliberately not an effect and not a key handler — this file carries no
   * keyboard machinery (AC4.5).
   */
  const toggleList = () => {
    if (listOpen) setQuery('')
    setListOpen(!listOpen)
  }

  const options = view?.options ?? []
  const filtering = options.length > FILTER_FROM
  const needle = query.trim().toLowerCase()
  const shown = needle ? options.filter((option) => matches(option, needle)) : options

  const imported = lastImport ? lastImport.imported.length : 0
  const rejected = lastImport ? lastImport.rejected.length : 0

  return (
    <section
      className="space-y-3"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* The modal's `Section` is private to that file and importing it back up
          would close an import cycle; the heading matches it class for class. */}
      <h3 className="text-[11px] font-semibold uppercase tracking-widest text-gold-400/80">
        Appearance
      </h3>

      {!view ? (
        <>
          <p className="text-[11px] leading-relaxed text-parchment-faint">
            The theme list could not be read — the app is showing the palette its own stylesheet
            declares. Importing or dropping a theme below re-reads the list.
          </p>
          <ImportControl busy={busy} dragging={dragging} onImport={() => void importFromDialog()} />
        </>
      ) : (
        <>
          {/* The way in comes first, the list second — and the list now folds,
              which is the only thing the disclosure may cover. With a corpus plus
              everything the user has imported the rows run well past a screen, and
              the folder is the doorway this feature was built around (§2.4) —
              burying it under a hundred rows is how a picker hides its own import. */}
          <ImportControl busy={busy} dragging={dragging} onImport={() => void importFromDialog()} />

          {importError && <Report>{importError}</Report>}

          {imported + rejected > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] text-parchment-faint">
                {imported} imported
                {rejected > 0 && `, ${rejected} rejected`}
              </p>
              {lastImport?.rejected.map((r) => (
                <Report key={r.path}>
                  <span className="font-mono">{basename(r.path)}</span> — {r.reason}
                </Report>
              ))}
            </div>
          )}

          <div className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-[12px] text-parchment">{view.folder}</p>
                <p className="mt-0.5 text-[11px] text-parchment-faint">
                  Files put here by hand appear after a refresh
                </p>
              </div>
              <button
                disabled={busy}
                onClick={() => void revealFolder()}
                aria-label="Reveal the theme folder in Finder"
                title="Reveal in Finder"
                className={ROW_CONTROL}
              >
                <FolderIcon className="h-4 w-4" />
              </button>
              <button
                disabled={busy}
                onClick={() => void syncFolder()}
                aria-label="Rescan the theme folder"
                title="Rescan the folder"
                className={ROW_CONTROL}
              >
                <RefreshIcon className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="overflow-hidden rounded-md border border-ink-700 bg-ink-850">
            {/* The summary is the control: what the app looks like right now, and
                the way into the list. Its swatches come from the *applied* tokens
                rather than from a matching row, so it cannot disagree with the
                screen or come back empty. */}
            <button
              onClick={toggleList}
              aria-expanded={listOpen}
              aria-controls={LIST_ID}
              className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-ink-800"
            >
              <SwatchStrip colours={appliedSwatches(view.active.tokens)} />
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate text-[13px] text-parchment">{view.active.name}</span>
                <VariantBadge variant={view.active.variant} />
                <span className="shrink-0 text-[11px] text-parchment-faint">
                  {PROVIDER_LABEL[view.active.provider]}
                </span>
              </span>
              <span className="shrink-0 text-[11px] text-parchment-faint">
                {options.length} {options.length === 1 ? 'theme' : 'themes'}
              </span>
              <span className="shrink-0 text-[12px] text-parchment-dim">Select theme</span>
              <ChevronIcon
                className={`h-3.5 w-3.5 shrink-0 text-parchment-faint ${
                  listOpen ? '-rotate-90' : 'rotate-90'
                }`}
              />
            </button>

            {listOpen && (
              <div id={LIST_ID} className="border-t border-ink-800">
                {filtering && (
                  <div className="border-b border-ink-800 px-3 py-2">
                    {/* No key handling on purpose: Escape-to-clear would be the
                        first piece of keyboard machinery in this file, and the
                        section's own rule is that it grows none (AC4.5). */}
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Filter themes…"
                      spellCheck={false}
                      autoComplete="off"
                      className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-[12px] text-parchment placeholder:text-parchment-faint/50 focus:border-gold-500/60 focus:outline-none"
                    />
                  </div>
                )}

                {shown.length > 0 ? (
                  <ul>
                    {shown.map((option) => (
                      <ThemeRow
                        key={option.id}
                        option={option}
                        reason={themeError?.id === option.id ? themeError.reason : null}
                        open={openNotes === option.id}
                        onToggleNotes={() =>
                          setOpenNotes((current) => (current === option.id ? null : option.id))
                        }
                        onApply={() => void setTheme(option.id)}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="px-3 py-3 text-[11px] text-parchment-faint">
                    No theme matches “{query.trim()}”.
                  </p>
                )}

                <p className="border-t border-ink-800 px-3 py-2 text-[11px] leading-relaxed text-parchment-faint">
                  Click a theme to apply it — nothing here waits for Save.
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}

/**
 * The native picker, with the busy state on it. Rendered by both branches on
 * purpose: when the list could not be read at all, an import is the one control
 * that gets it back — every import answer carries a whole `ThemeView` (D10).
 *
 * `dragging` swaps the hint rather than highlighting a panel: the drop is
 * accepted anywhere on the section, and the panel the highlight used to sit on
 * can be a screen below the pointer while the file is over the window. A
 * sentence at the top is the one piece of feedback that is always in view — and
 * it is the reason the fold may cover the list and nothing above it.
 */
function ImportControl({
  busy,
  dragging,
  onImport
}: {
  busy: boolean
  dragging: boolean
  onImport(): void
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        disabled={busy}
        onClick={onImport}
        className="flex shrink-0 items-center gap-2 rounded-md border border-ink-600 px-2.5 py-1 text-[12px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40"
      >
        {busy && <SpinnerIcon className="h-4 w-4" />}
        Import…
      </button>
      <span className={`text-[11px] ${dragging ? 'text-gold-300' : 'text-parchment-faint'}`}>
        {dragging ? DROP_HINT_ACTIVE : DROP_HINT}
      </span>
    </div>
  )
}

/**
 * One row: the five derived values, what the theme is, and what it is called.
 *
 * One line, not two. Everything the row carried still rides on it — name,
 * variant, provider, `stale` — and the only thing the compression moved is the
 * provider label, which no longer takes a line of its own (D3). The name
 * truncates first, so a long title never pushes the provider off.
 *
 * The whole left-hand side is the button that applies it, with the notes
 * disclosure beside it rather than inside it — a button inside a button is
 * neither valid nor reachable by keyboard.
 */
function ThemeRow({
  option,
  reason,
  open,
  onToggleNotes,
  onApply
}: {
  option: ThemeOption
  reason: string | null
  open: boolean
  onToggleNotes(): void
  onApply(): void
}) {
  return (
    <li className="border-b border-ink-800 last:border-b-0">
      <div className="flex items-center">
        <button
          onClick={onApply}
          aria-pressed={option.active}
          className={`flex min-w-0 flex-1 items-center gap-2.5 px-3 py-1.5 text-left ${
            option.active ? 'bg-ink-800/60' : 'hover:bg-ink-800'
          }`}
        >
          <SwatchStrip colours={option.swatches} />
          <span
            className={`min-w-0 flex-1 truncate text-[13px] ${
              option.active ? 'text-parchment' : 'text-parchment-dim'
            }`}
          >
            {option.name}
          </span>
          <VariantBadge variant={option.variant} />
          {option.stale && (
            <span
              className="flex shrink-0 items-center gap-1 text-[10px] text-parchment-dim"
              title="Saved by an older version of the app — the values still apply, and applying it again re-derives them if its source file is still there"
            >
              <WarningIcon className="h-3 w-3" />
              stale
            </span>
          )}
          <span className="shrink-0 text-[11px] text-parchment-faint">
            {PROVIDER_LABEL[option.provider]}
          </span>
          {option.active && <CheckIcon className="h-4 w-4 shrink-0 text-gold-400" />}
        </button>
        {option.notes.length > 0 && (
          <button
            onClick={onToggleNotes}
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} what ${option.name} had to approximate`}
            className="mr-3 rounded p-1 text-parchment-faint hover:bg-ink-800 hover:text-parchment"
          >
            <ChevronIcon className="h-3.5 w-3.5" open={open} />
          </button>
        )}
      </div>
      {reason && (
        <div className="px-3 pb-2">
          <Report>{reason}</Report>
        </div>
      )}
      {open && (
        <ul className="space-y-1 px-3 pb-2.5">
          {option.notes.map((note, at) => (
            <li key={at} className="text-[11px] leading-relaxed text-parchment-faint">
              {note}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * The five derived values, side by side. Their order is fixed by
 * `ThemeSwatches`, so two rows are comparable with each other.
 *
 * The one literal colour the renderer is allowed: the swatch *is* the data, and
 * a token would paint every theme the same.
 */
function SwatchStrip({ colours }: { colours: readonly string[] }) {
  return (
    <span
      aria-hidden
      className="flex h-4 w-[52px] shrink-0 overflow-hidden rounded-sm border border-ink-700"
    >
      {colours.map((hex, at) => (
        <span key={at} className="h-full flex-1" style={{ backgroundColor: hex }} />
      ))}
    </span>
  )
}

/**
 * The strip's five values, read off the *applied* tokens rather than off a
 * matching list row (D2): the stored set is what is on screen, and unlike a row
 * lookup it cannot come back empty. The five are `ink-950`, `ink-800`,
 * `parchment`, `gold-400`, `gold-500` — `ThemeSwatches`' order, restated here
 * because the tokens carry roles and the strip carries positions.
 */
function appliedSwatches(tokens: ThemeTokens): ThemeSwatches {
  return [
    tokens.ink['950'],
    tokens.ink['800'],
    tokens.parchment.parchment,
    tokens.gold['400'],
    tokens.gold['500']
  ]
}

/** Does a row answer the filter box? Name, provider label or variant. */
function matches(option: ThemeOption, needle: string): boolean {
  return (
    option.name.toLowerCase().includes(needle) ||
    PROVIDER_LABEL[option.provider].toLowerCase().includes(needle) ||
    option.variant.includes(needle)
  )
}

/**
 * `dark` / `light`, as the data spells it. Deliberately not colour-coded: the
 * variant is a fact about the theme, and the swatch strip beside it already says
 * what that fact looks like.
 */
function VariantBadge({ variant }: { variant: ThemeVariant }) {
  return (
    <span className="shrink-0 rounded border border-ink-600 px-1.5 text-[10px] text-parchment-dim">
      {variant}
    </span>
  )
}

/**
 * A failure line — a refused click, a rejected file, a call that could not run.
 *
 * Carries no hue: the token set the app has today has no failure colour (slice 7a
 * adds the status family), and the icon plus the sentence is what makes it read as
 * a failure rather than another faint label (`CLAUDE.md` #12 — the report is the
 * feature).
 */
function Report({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-parchment-dim">
      <WarningIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  )
}

/** The last segment of a path — enough to name the file in a report line. */
function basename(path: string): string {
  const at = path.lastIndexOf('/')
  return at === -1 ? path : path.slice(at + 1)
}
