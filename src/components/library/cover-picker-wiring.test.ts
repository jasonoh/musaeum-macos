import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * The picker's wiring, walked in the source — the criteria these slices name as
 * source walks, in the one place a component's wiring can be decided at all
 * (the renderer has no DOM harness: `vitest` runs `environment: 'node'`).
 *
 * Each case states its limit where it states its rule. A walk proves the
 * sentence and the call site; it does not prove a person can see the sentence
 * or that the call succeeds — that half is the running-app probe's, recorded in
 * the slice's annex.
 */
const read = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8')

const PICKER = 'src/components/library/CoverPicker.tsx'
const PRELOAD = 'electron/preload/index.ts'

describe('AC14a — the picker calls the existing surface and adds no channel', () => {
  it('reaches the main process only through methods the preload already exposes', () => {
    // Its limit: this proves the *call sites* and their names. It cannot prove
    // the calls resolve at runtime — an unbound name in the preload would pass
    // here and fail in the app — so the probe opens the dialog and picks.
    const picker = read(PICKER)
    const preload = read(PRELOAD)

    // `\s*` before each dot on purpose: prettier wraps `window.Musaeum.metadata`
    // and `.coverCandidates(bookId)` onto two lines, and a pattern that assumed
    // one line found two of the four calls (measured) — a walk that fails open.
    const calls = [...picker.matchAll(/window\.Musaeum\.(\w+)\s*\.\s*(\w+)/g)].map(
      (m) => `${m[1]}.${m[2]}`
    )
    const distinct = [...new Set(calls)].sort()

    // Exactly the six the picker needs: the gather, the write, the lock's read,
    // the lock's release, the wider search (slice 3a-ii) and the upload's dialog
    // (slice 3b-ii). A seventh name means a new surface rode in with the picker,
    // which is what this criterion forbids; both additions were decided in the
    // same design (`2026-09-25-cover-sources-design.md`, D2 and D6) rather than
    // slipping in with a UI slice.
    expect(distinct).toEqual([
      'library.getFieldOverrides',
      'library.releaseFieldOverride',
      'metadata.chooseCoverFromFile',
      'metadata.coverCandidates',
      'metadata.searchCovers',
      'metadata.setCover'
    ])
    for (const call of distinct) {
      const method = call.split('.')[1]
      expect(preload).toContain(`${method}:`)
    }
  })

  it('names no IPC channel of its own', () => {
    const picker = read(PICKER)
    // The renderer never sees a channel; one appearing here means the picker
    // reached past the preload
    expect(picker).not.toMatch(/ipcRenderer/)
    expect(picker).not.toMatch(/\.invoke\(/)
    expect(picker).not.toMatch(/['"]library:[a-zA-Z]+['"]/)
  })
})

describe('AC8b — the wider search is asked about this book, and only on a press', () => {
  it('calls searchCovers with the book id and nothing else', () => {
    // Its limit: this decides the call's *argument*, which is the half a walk
    // can decide. That the search reaches the sidecar and comes back is the
    // service test's and the probe's (AC7); that the tiles arrive labelled is
    // `cover-candidate-state.test.ts`'s.
    const picker = read(PICKER)

    // `\s*` between the dots for the same measured reason as the walk above:
    // prettier wraps `window.Musaeum.metadata` onto its own line when the call
    // is part of a chain, and a pattern that assumed one line found too few.
    const call = picker.match(
      /window\.Musaeum\s*\.\s*metadata\s*\.\s*searchCovers\s*\(\s*([^)]*)\)/
    )
    expect(call).not.toBeNull()

    // The argument is the book's id and only that. The service resolves the
    // file, the book dir and `known` from the row itself, so a second argument
    // here would be a value the renderer decided — and the renderer decides
    // none of those three (the rule AC5 holds the service to, from this side).
    expect(call?.[1].trim()).toBe('book.id')
  })

  it('asks it once, from the press, and derives the group through the pure rule', () => {
    const picker = read(PICKER)

    // One call site and no other: a fetch must not ask this question (D1), and
    // neither may the dialog on open — the press is the whole trigger.
    expect(picker.match(/searchCovers\s*\(/g)).toHaveLength(1)

    // The rule that keeps "still asking" and "came back with nothing" apart is
    // the module's, where a unit case can decide it; the JSX renders its answer
    // rather than writing a sentence of its own.
    expect(picker).toContain('searchedCoverTiles(')

    // And the group says what it is. `\s+`, not a space: prettier reflows JSX
    // text, so the sentence arrives split across two lines in the source.
    expect(picker).toContain('Look for more covers')
    expect(picker).toContain('From a wider search')
    expect(picker).toMatch(/A fetch would not\s+write any of them/)
  })
})

describe('AC11 — an uploaded image names the book, and never a path', () => {
  it('calls chooseCoverFromFile with the book id and nothing else', () => {
    // Its limit: this decides the call's *argument*, which is the half a walk can
    // decide at all. That the dialog opens, that the write lands on disk and that
    // the lock line then renders is the running-app probe's (AC11). The argument
    // is the whole of D6-a from this side: the file dialog belongs to the main
    // process, so a path here would be a value the renderer decided — and one
    // that could name a path could ask the main process to write any file into a
    // book's folder.
    const picker = read(PICKER)

    // `\s*` between the dots for the measured reason the walks above carry:
    // prettier wraps `window.Musaeum.metadata` onto its own line when the call is
    // part of a chain, and a pattern that assumed one line found too few.
    const call = picker.match(
      /window\.Musaeum\s*\.\s*metadata\s*\.\s*chooseCoverFromFile\s*\(\s*([^)]*)\)/
    )
    expect(call).not.toBeNull()
    expect(call?.[1].trim()).toBe('book.id')

    // One press, one call, and nothing that could open a dialog from this side
    expect(picker.match(/chooseCoverFromFile\s*\(/g)).toHaveLength(1)
    expect(picker).not.toMatch(/filePaths|showOpenDialog/)
  })

  it('keeps every mark off the answer, and both readings in the pure rule', () => {
    // The rule the upload shares with a pick, walked on the component: `applied`
    // is byte identity against what is on disk *now*, and the payload the tiles
    // came from was scored against the bytes that were there *before* the write —
    // so the only thing that may set a tile's mark is the candidate this session
    // wrote (`setPicked`, inside `choose`), and an upload sets no mark at all.
    // Its limit: that the dialog re-runs the gather afterwards, instead of
    // leaving marks scored against the replaced file, is the probe's — a walk can
    // only show that no second mark-setter exists to do it wrongly.
    const picker = read(PICKER)

    expect(picker.match(/setPicked\s*\(/g)).toHaveLength(1)
    // What a cancellation or a landed write *means* is the pure rule's, so the
    // branch that keeps them apart is not written in the JSX.
    expect(picker).toContain('coverUploadReading(')
    expect(picker).toContain('uploadCopy(')
    // …and a cancelled answer stops the press there: the re-read below it (the
    // run bump, then `load()`) must be unreachable from the cancelled arm,
    // because a dialog somebody closed moved nothing to re-read. Control flow is
    // the most a source walk can see of this, and this is its shape.
    expect(picker).toMatch(/reading\.kind === 'cancelled'\)\s*return/)
    // The gather's notice is gated on the rule's answer: an upload that landed
    // must be able to stand it down, or the dialog prints the explanation this
    // whole slice exists to make untrue.
    expect(picker).toMatch(/\{gatherNotice && notice &&/)
    // …and that gate is the rule's answer rather than a literal next to it: the
    // whole suppression argument is that the dialog *knows* an upload landed, so
    // a `gatherNotice` invented beside the destructuring would restore the notice
    // this slice exists to make untrue.
    expect(picker).toMatch(/gatherNotice[^=\n]*=[^=\n]*uploadCopy\(/)
  })

  it('renders each state, and gates every read on the write in flight', () => {
    // The sentences are the lib's, where a unit case can decide them; that this
    // control *renders* them is the walk's, because no unit case can see a
    // `.tsx`. Braced, because the import above carries the same names — a
    // mutation that deleted the JSX and left the import behind is exactly what an
    // unbraced check would miss. One name per visible state of the control.
    const picker = read(PICKER)

    for (const name of ['{UPLOAD_TRIGGER_LABEL}', '{UPLOAD_TRIGGER_LINE}']) {
      expect(picker).toContain(name)
    }
    expect(picker).toMatch(/\{uploadLine &&/)
    // The refusal prints the call's own sentence — the rule is `uploadRefusal`'s,
    // and that it is printed at all is this walk's: a swallowed rejection would
    // leave a person staring at a dialog that closed and said nothing.
    expect(picker).toMatch(/setUploadError\(uploadRefusal\(err\)\)/)

    // One dialog at a time, and it is the guard inside the handler that enforces
    // it: the trigger's `disabled` is the cosmetic half, because a greyed button
    // still loses a race against a render.
    expect(picker).toMatch(/if \(!book \|\| uploading\) return/)
    // Both tile grids hand the upload's busy state down, and the count is the
    // point: the two groups render identical `TileButton`s, so a grid left out is
    // exactly the drift that would leave it live during a write. Both writes land
    // on the same two filenames, and a tile pressed now would race rather than
    // queue. The two triggers are gated on it as well — the count of four — a
    // trigger being the control that starts a *read*, and a read started now
    // assembles a payload from the file this write is replacing.
    expect(picker.match(/disabled=\{uploading\}/g)).toHaveLength(2)
    expect(picker.match(/disabled=\{[^}]*uploading[^}]*\}/g)).toHaveLength(4)
  })
})

describe('AC17a — the editor says where a cover lock is released', () => {
  it('keeps the sentence every other field depends on, and adds the cover clause', () => {
    // Its limit: it proves the paragraph's text, not its legibility — the probe
    // opens the editor on a book with a cover override and reads the paragraph
    // off the screen.
    const editor = read('src/components/library/BookEditor.tsx')

    // The sentence that was already true for every other field survives
    expect(editor).toMatch(
      /The padlock beside a field hands it back to Musaeum — its value stays\./
    )
    // …and the one field without a padlock now says where its release is
    expect(editor).toMatch(/is released from/)
    expect(editor).toMatch(/Choose cover/)
    // The instruction must not survive in a form that sends the reader looking
    // for a padlock beside Cover: the summary is the *only* place the lock is
    // named per field, and it must not claim a control that does not exist
    expect(editor).not.toMatch(/padlock beside Cover/)
  })
})

describe('the picker’s entry point is a control, not decoration', () => {
  it('paints the panel’s cover control in a tier that clears the small-text floor', () => {
    // Why a ratio and not a class name: the defect this pins was invisible in the
    // source. The panel painted `Choose cover` in the palette's *faintest* token —
    // measured on the owner's own theme (Tokyo Night Dark) at **2.35:1**, and at
    // **3.99:1** on this repo's defaults, against the 4.5:1 floor for small text.
    // His report was "there is no way for me to initiate a cover change directly":
    // the control was there, at 11px, and could not be read. The theme engine's own
    // audit lets *faint* sit at 2.2:1 and *dim* at 3.5:1 — floors for decoration —
    // so a tier cannot be chosen for a labelled control by taste. This case reads
    // the token pair off the component, resolves both through `index.css`, and does
    // the arithmetic.
    const detail = read('src/components/library/BookDetail.tsx')
    const css = read('src/index.css')

    const panel = /<aside[^>]*className="([^"]*)"/.exec(detail)
    expect(panel, 'the detail panel’s own surface was not found').toBeTruthy()
    const control =
      /<button\s+onClick=\{\(\) => requestCoverPicker\(book\.id\)\}[\s\S]*?className="([^"]*)"/.exec(
        detail
      )
    expect(control, 'the panel’s cover control was not found').toBeTruthy()

    // drop state variants — `hover:bg-ink-800` is not the resting tier
    const resting = (cls: string) =>
      cls.replace(/\b(?:hover|focus|active|disabled|group-hover):\S+/g, '')
    const tokenOf = (cls: string, kind: 'text' | 'bg') => {
      const found = new RegExp(`(?:^|\\s)${kind}-([a-z0-9-]+)(?:\\s|$)`).exec(resting(cls))
      expect(found, `no resting ${kind}-* token in "${cls.trim()}"`).toBeTruthy()
      return found![1]
    }
    const rgb = (name: string): number[] => {
      const hit = new RegExp(`--${name}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)`).exec(css)
      expect(hit, `--${name} is not a default token in index.css`).toBeTruthy()
      return [Number(hit![1]), Number(hit![2]), Number(hit![3])]
    }
    const channel = (c: number) => {
      const v = c / 255
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    }
    const luminance = ([r, g, b]: number[]) =>
      0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    const ratio = (a: number[], b: number[]) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (hi + 0.05) / (lo + 0.05)
    }

    const label = rgb(tokenOf(control![1], 'text'))
    const surface = rgb(tokenOf(panel![1], 'bg'))
    const measured = ratio(label, surface)

    // 4.5:1 is WCAG AA for small text, and this is 11px semibold — so it is the
    // floor, not a preference. Both the shipped tier (3.99:1) and the owner's theme
    // (2.35:1) fail it.
    expect(measured).toBeGreaterThanOrEqual(4.5)
  })
})
