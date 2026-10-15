import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * The voice reader's visible surface (slice 2, Task 7b): source walks, as the repo does where
 * there is no DOM harness (`environment: 'node'`). Behaviour is proved by hand in the running
 * app; what is pinned here is the wiring the mechanism needs.
 */
function read(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8')
}
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/gm, '$1')
}

const VIEW = stripComments(read('src', 'components', 'reader', 'ReaderView.tsx'))
const BAR = stripComments(read('src', 'components', 'reader', 'ListenBar.tsx'))
const CHIP = stripComments(read('src', 'components', 'reader', 'SelectionChip.tsx'))
const ICONS = read('src', 'components', 'shared', 'icons.tsx')

describe('ReaderView mounts the speech hook', () => {
  it('mounts useSpeech once with the view ref and the book id', () => {
    expect(VIEW).toMatch(/useSpeech\(\{\s*viewRef,\s*bookId\s*\}\)/)
  })

  it('forwards the engine range to the hook from onRelocate', () => {
    expect(VIEW).toMatch(/speechRelocate\(detail\.range\)/)
    expect(VIEW).toMatch(/range: Range \| null/)
  })

  it('opens the bar before it plays from the chip', () => {
    const at = VIEW.indexOf('onReadFromHere=')
    expect(at).toBeGreaterThan(0)
    const handler = VIEW.slice(at, at + 400)
    const open = handler.search(/toggleListen|openListen|listenOpen/)
    const play = handler.indexOf('speech.play(')
    expect(open).toBeGreaterThanOrEqual(0)
    expect(play).toBeGreaterThan(open)
  })

  it('has a header Listen button: app-no-drag, aria-pressed, a title, ListenIcon', () => {
    const header = VIEW.slice(VIEW.indexOf('<header'), VIEW.indexOf('</header>'))
    const tags = header.split('<button').slice(1)
    const tag = tags.find((t) => t.includes('ListenIcon'))
    expect(tag, 'a header button holds ListenIcon').toBeDefined()
    const open = tag!.slice(0, tag!.indexOf('>'))
    expect(open).toContain('app-no-drag')
    expect(open).toContain('aria-pressed={listenOpen}')
    expect(open).toMatch(/title="[^"]+"/)
    expect(open).toContain('toggleListen')
  })

  it('renders the bar at the bottom of the reader column, outside the side slot', () => {
    const slotStart = VIEW.indexOf('{tocOpen && <ReaderToc')
    const slotEnd = VIEW.indexOf('</main>')
    const bar = VIEW.indexOf('<ListenBar')
    expect(bar).toBeGreaterThan(slotEnd)
    expect(bar < slotStart || bar > slotEnd).toBe(true)
    expect(VIEW).toMatch(/\{listenOpen && <ListenBar/)
  })

  it('toggles on an unmodified L in the existing key switch, behind the typing guard', () => {
    expect(VIEW).toMatch(/if \(e\.metaKey \|\| e\.ctrlKey \|\| e\.altKey\) return/)
    expect(VIEW).toMatch(/isTypingTarget\(e\.target\)\) return/)
    expect(VIEW).toMatch(/case 'l':[\s\S]{0,40}case 'L':[\s\S]{0,120}toggleListen\(\)/)
    const lAt = VIEW.indexOf("case 'l':")
    const switchAt = VIEW.indexOf('switch (e.key)')
    expect(lAt).toBeGreaterThan(switchAt)
  })
})

describe('ListenBar', () => {
  it('imports no icon library, only the repo glyphs', () => {
    const imports = BAR.match(/from '[^']+'/g) ?? []
    for (const spec of imports) {
      expect(spec).not.toMatch(/lucide|heroicons|react-icons|fontawesome|phosphor/i)
    }
    expect(BAR).toContain("@/components/shared/icons'")
  })

  it('has the transport controls, over the shared voice list and speed clamp', () => {
    expect(BAR).toMatch(/TTS_VOICES/)
    expect(BAR).toMatch(/clampTtsSpeed\(/)
    expect(BAR).toMatch(/setPrefs\(\{\s*speed/)
    expect(BAR).toMatch(/setPrefs\(\{\s*voice/)
    expect(BAR).toMatch(/speech\.skip\(-1\)/)
    expect(BAR).toMatch(/speech\.skip\(1\)/)
    expect(BAR).toMatch(/speech\.pause\(\)/)
    expect(BAR).toMatch(/speech\.close\(\)/)
  })

  it('says the honest things: size, notice, retry gated, offline', () => {
    expect(BAR).toContain('Download the voice (120 MB)')
    expect(BAR).toMatch(/speech\.notice/)
    expect(BAR).toMatch(/canRetry\s*&&\s*speech\.retryReady/)
    expect(BAR).toContain('offline-no-model')
    expect(BAR).toMatch(/speech\.cancelDownload\(\)/)
  })

  it('never takes focus from the page-turn keys', () => {
    expect(BAR).toMatch(
      /const noFocus = \(e: \{ preventDefault\(\): void \}\) => e\.preventDefault\(\)/
    )
    expect(BAR).toContain('onMouseDown={noFocus}')
    expect(BAR).toMatch(/\.blur\(\)/)
  })
})

describe('the icons', () => {
  it('adds ListenIcon and the transport glyphs by hand', () => {
    for (const name of ['ListenIcon', 'PlayIcon', 'PauseIcon', 'SkipBackIcon', 'SkipForwardIcon']) {
      expect(ICONS).toContain(`export const ${name}`)
    }
  })
})

describe('the chip’s second button', () => {
  it('is "Read from here", app-no-drag, with onMouseDown preventDefault', () => {
    const buttons = CHIP.split('<button').slice(1)
    expect(buttons.length).toBe(2)
    const second = buttons[1]!
    const open = second.slice(0, second.indexOf('>\n') >= 0 ? second.indexOf('>\n') : 400)
    expect(second).toContain('Read from here')
    expect(open).toContain('className={buttonClass}')
    expect(open).toContain('onMouseDown={(event) => event.preventDefault()}')
    expect(second).toContain('onReadFromHere')
  })
})
