import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * The lexicon's visible surface (voice reader D8; slice annex AC25). Source walks, as the
 * repo does where there is no DOM harness (`environment: 'node'`): what is pinned here is
 * the wiring the mechanism needs. What a person actually sees is decided by the manual pass
 * in the running app — the chip, the popover at the selection, Preview speaking, Delete
 * appearing for a word that has an entry.
 *
 * The ordering claims are the ones a screenshot cannot decide: **Preview must be reachable
 * without saving** (it is the safeguard D8 names), and it must speak the respelling through
 * `tts.preview`, never by writing the file first.
 */
function read(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8')
}
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/gm, '$1')
}

const CHIP = stripComments(read('src', 'components', 'reader', 'SelectionChip.tsx'))
const ENGINE = stripComments(read('src', 'components', 'reader', 'ReaderEngine.tsx'))
const POPOVER = stripComments(read('src', 'components', 'reader', 'PronouncePopover.tsx'))

describe('the selection chip offers Pronounce… (AC25)', () => {
  it('has a third button, no-drag, which does not take the selection with it', () => {
    // The chip's own walk (`drag-regions.test.ts`) already requires every button to take the
    // shared class list; this one requires the button itself to exist and to name its intent.
    const at = CHIP.indexOf('onPronounce &&')
    expect(at).toBeGreaterThan(0)
    const tag = CHIP.slice(CHIP.indexOf('<button', at), CHIP.indexOf('</button>', at))
    expect(tag).toContain('className={buttonClass}')
    expect(tag).toContain('onMouseDown={(event) => event.preventDefault()}')
    expect(tag).toContain('onClick={onPronounce}')
    expect(tag).toMatch(/title="[^"]+"/)
    expect(CHIP.slice(at, at + 400)).toContain('Pronounce…')
  })

  it('takes the handler as an optional prop, so a reader without one shows no button', () => {
    expect(CHIP).toContain('onPronounce?(): void')
  })
})

describe('the engine opens the popover at the selection (annex R8)', () => {
  it('offers the button only when the selection is a word, by main’s own validator', () => {
    // One validator, both sides: main refuses what the chip would not offer.
    //
    // The **whole** conditional is pinned, not its test — `? onChipPronounce : undefined`.
    // Measured: with only the left half asserted, a mutation that offers the button
    // unconditionally (`: onChipPronounce`) survives the suite, which is exactly the case
    // this walk exists to decide (campaign row 13, repaired here).
    expect(ENGINE).toContain(
      'onPronounce={cleanWord(chip.capture.quote) ? onChipPronounce : undefined}'
    )
    expect(ENGINE).not.toContain('onPronounce={onChipPronounce}')
    expect(ENGINE).toContain("from '@shared/lexicon.types'")
  })

  it('copies the word and the rect out of the chip before the selection is lost', () => {
    const at = ENGINE.indexOf('const onChipPronounce')
    expect(at).toBeGreaterThan(0)
    const handler = ENGINE.slice(at, at + 500)
    expect(handler).toContain('cleanWord(chip.capture.quote)')
    expect(handler).toContain('setPronounce({ word, rect: chip.rect })')
    expect(handler).toContain('setChip(null)')
  })

  it('renders the popover with the word and the rect, and closes it by clearing the state', () => {
    const at = ENGINE.indexOf('<PronouncePopover')
    expect(at).toBeGreaterThan(0)
    const tag = ENGINE.slice(at, ENGINE.indexOf('/>', at))
    expect(tag).toContain('word={pronounce.word}')
    expect(tag).toContain('rect={pronounce.rect}')
    expect(tag).toContain('onClose={() => setPronounce(null)}')
  })

  it('does not change ReaderView: the chip is the engine’s own control', () => {
    const view = stripComments(read('src', 'components', 'reader', 'ReaderView.tsx'))
    expect(view).not.toContain('Pronounce')
  })
})

describe('the popover (AC25)', () => {
  it('shows the word, a sounds-like field, Preview, Save and — only with an entry — Delete', () => {
    expect(POPOVER).toContain('Sounds like')
    expect(POPOVER).toContain('placeholder="HAY-gul"')
    expect(POPOVER).toContain('Preview')
    expect(POPOVER).toContain('Save')
    // Delete is conditional on the word already having a respelling, which is what makes
    // a second visit an edit rather than a second entry.
    expect(POPOVER).toMatch(/\{existing && \(/)
    expect(POPOVER).toContain('Delete')
  })

  it('loads the existing entry on open and prefills the field with it', () => {
    expect(POPOVER).toContain('window.Musaeum.lexicon')
    expect(POPOVER).toMatch(/\.find\(\(entry\) => entry\.word === word\)/)
    expect(POPOVER).toContain('setSoundsLike(found.soundsLike)')
  })

  it('previews through tts.preview, at the current voice and speed', () => {
    expect(POPOVER).toContain('window.Musaeum.tts.preview({ word, soundsLike, voice, speed })')
    expect(POPOVER).toContain('s.prefs.voice')
    expect(POPOVER).toContain('s.prefs.speed')
  })

  it('saves through lexicon.save and deletes through lexicon.remove', () => {
    expect(POPOVER).toContain('window.Musaeum.lexicon.save({ word, soundsLike })')
    expect(POPOVER).toContain('window.Musaeum.lexicon.remove(word)')
  })

  it('can be heard before it is saved: Preview is its own control, not a step inside Save', () => {
    const save = POPOVER.indexOf('const save = useCallback')
    const preview = POPOVER.indexOf('const preview = useCallback')
    expect(preview).toBeGreaterThan(0)
    expect(save).toBeGreaterThan(preview)
    // Save's body must not synthesize, and Preview's must not write: the two actions are
    // deliberately separate, so a respelling can be auditioned and abandoned.
    const saveBody = POPOVER.slice(save, POPOVER.indexOf('const remove = useCallback'))
    expect(saveBody).not.toContain('tts.preview')
    const previewBody = POPOVER.slice(preview, save)
    expect(previewBody).not.toContain('lexicon.save')
  })

  it('speaks a preview in its own short-lived AudioContext, so it never fights the player', () => {
    expect(POPOVER).toContain('new AudioContext()')
    expect(POPOVER).toContain('pcmToFloat32')
    expect(POPOVER).toContain('void context.close()')
  })

  it('floats like the chip: fixed, no-drag, at the selection’s own rect, click-to-dismiss', () => {
    expect(POPOVER).toMatch(/className="app-no-drag fixed/)
    expect(POPOVER).toContain('rect.top + rect.height + GAP')
    expect(POPOVER).toMatch(/<div className="fixed inset-0 z-10" onClick=\{onClose\}/)
  })

  it('reports a refusal on the app’s toast surface rather than swallowing it', () => {
    expect(POPOVER).toContain("import { notifyError } from '@/lib/notify'")
    expect(POPOVER.match(/notifyError\(err\)/g)?.length).toBe(3)
  })
})
