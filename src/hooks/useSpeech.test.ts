import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * Source walk over the voice reader's hook (slice 2, Task 7).
 *
 * Stated limit, as in `useBookDrag.test.ts`: there is no DOM harness here (`environment:
 * 'node'`), so the hook is never rendered. Its state transitions are the pure reducer's
 * (`src/lib/speech-state.test.ts`); the controller and the player are tested on their own
 * (`speech-controller.test.ts`, `speech-player.test.ts`). What is asserted here is the
 * wiring between them — the shape the mechanism needs — and the live half is the CDP check.
 */
const SOURCE = readFileSync(join(process.cwd(), 'src', 'hooks', 'useSpeech.ts'), 'utf8')

/** The body of the first `const name = useCallback(` … up to the next top-level hook call. */
function callback(name: string): string {
  const start = SOURCE.indexOf(`const ${name} = useCallback(`)
  expect(start, `${name} is a useCallback`).toBeGreaterThanOrEqual(0)
  const rest = SOURCE.slice(start + 1)
  const end = rest.search(/\n {2}(const \w+ = use|useEffect\()/)
  return end < 0 ? rest : rest.slice(0, end)
}

describe('useSpeech drives the pure reducer', () => {
  it('every phase comes from speechReducer', () => {
    expect(SOURCE).toMatch(/import \{[^}]*\bspeechReducer\b[^}]*\} from '@\/lib\/speech-state'/)
    expect(SOURCE).toMatch(/speechReducer\(/)
  })

  it('has no `any`', () => {
    expect(SOURCE).not.toMatch(/:\s*any\b|as any\b|<any>/)
  })
})

describe('play builds the controller and the player, in that order', () => {
  const play = callback('play')

  it('checks the model first, and reports offline from the browser flag', () => {
    expect(play).toMatch(/window\.Musaeum\.tts\.status\(\)/)
    expect(play).toMatch(/navigator\.onLine === false/)
    expect(play.indexOf('tts.status()')).toBeLessThan(play.indexOf('new SpeechController('))
  })

  it('wires isSaved to the plan filter over the store annotations, and the speech color fresh from the palette', () => {
    expect(SOURCE).toMatch(
      /isSaved: \(cfi\) => isSavedValue\(useReaderStore\.getState\(\)\.annotations, cfi\)/
    )
    expect(SOURCE).toMatch(/resolveReaderPalette\([\s\S]{0,200}?\)\.speech/)
    expect(SOURCE).toMatch(/useThemeStore\.getState\(\)/)
  })

  it('synthesizes through a 50-sentence cache over the IPC call', () => {
    expect(SOURCE).toMatch(/new SentenceCache\(50\)\.wrap\(/)
    expect(SOURCE).toMatch(/window\.Musaeum\.tts\.synthesize\(/)
  })

  it('reads voice and speed from the store on every request', () => {
    expect(SOURCE).toMatch(/spec: \(\) => \{[\s\S]{0,120}useReaderStore\.getState\(\)\.prefs/)
  })

  it('begins the controller before starting the player, on a fresh AudioContext', () => {
    expect(play).toMatch(/new AudioContext\(\)/)
    const begin = play.indexOf('controller.begin(')
    const start = play.indexOf('player.start()')
    expect(begin).toBeGreaterThan(0)
    expect(start).toBeGreaterThan(begin)
  })
})

describe('the reader moving restarts speech (AC17)', () => {
  it('forwards a relocate to the controller and a returned unit to restartAt', () => {
    const relocate = callback('onRelocate')
    expect(relocate).toMatch(/controller\.onRelocate\(range\)/)
    expect(relocate).toMatch(/player\.restartAt\(unit\)/)
  })
})

describe('a voice or speed change lands on the next sentence', () => {
  it('calls specChanged from an effect keyed on the two prefs', () => {
    expect(SOURCE).toMatch(/useReaderStore\(\(s\) => s\.prefs\.voice\)/)
    expect(SOURCE).toMatch(/useReaderStore\(\(s\) => s\.prefs\.speed\)/)
    expect(SOURCE).toMatch(/specChanged\(\)[\s\S]{0,80}\}, \[voice, speed\]\)/)
  })
})

describe('no audio from a closed book (Review Focus 6)', () => {
  const teardown = callback('teardown')

  it('teardown stops the player (which closes the AudioContext) and disposes the controller', () => {
    expect(teardown).toMatch(/player\.stop\(\)/)
    expect(teardown).toMatch(/controller\.dispose\(\)/)
    expect(teardown.indexOf('player.stop()')).toBeLessThan(teardown.indexOf('controller.dispose()'))
  })

  it('tears down when the book changes and on unmount', () => {
    expect(SOURCE).toMatch(
      /useEffect\(\(\) => \{[\s\S]{0,200}return \(\) => \{[\s\S]{0,200}teardown\(\)[\s\S]{0,200}\}, \[bookId, teardown/
    )
  })

  it('tears down when the bar closes, however it closed', () => {
    expect(SOURCE).toMatch(/useReaderStore\(\(s\) => s\.listenOpen\)/)
    expect(SOURCE).toMatch(/if \(!listenOpen\)[\s\S]{0,40}teardown\(\)/)
  })

  it('a stale continuation (the book closed while status or begin was pending) does nothing', () => {
    const play = callback('play')
    expect(play.match(/gen !== generation\.current/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })
})

describe('the model download', () => {
  it('subscribes to progress once, and unsubscribes on unmount', () => {
    expect(SOURCE).toMatch(/useEffect\(\s*\(\) =>\s*window\.Musaeum\.on\.ttsModelProgress\(/)
  })

  it('downloads and cancels through the bridge', () => {
    expect(SOURCE).toMatch(/window\.Musaeum\.tts\.downloadModel\(\)/)
    expect(SOURCE).toMatch(/window\.Musaeum\.tts\.cancelDownload\(\)/)
  })

  it('arms Retry only after RETRY_DELAY_MS (Review Focus 8)', () => {
    expect(SOURCE).toMatch(/setTimeout\([\s\S]{0,80}'retry-armed'[\s\S]{0,40}RETRY_DELAY_MS\)/)
  })
})
