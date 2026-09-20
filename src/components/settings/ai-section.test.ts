import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * Source walks over the Ask (AI) section of the settings dialog.
 *
 * The renderer has no DOM harness in this repo (the vitest environment is Node,
 * with no React testing library), so the two claims that are about *wiring*
 * rather than about logic are decided by reading the file. Both are claims a
 * behavioural test would be better at and neither can be decided any other way
 * here — so each case states what it does not prove.
 *
 * Everything the section *computes* is decided by real tests elsewhere:
 * `src/lib/ai-providers.test.ts` for the table and the deriver, and
 * `electron/main/services/ai.test.ts` for the verdict ladder.
 */

const SOURCE = readFileSync(
  join(process.cwd(), 'src', 'components', 'settings', 'SettingsModal.tsx'),
  'utf8'
)

function count(needle: string): number {
  return SOURCE.split(needle).length - 1
}

/** The source of the one `await window.Musaeum.ai.test({ … })` argument. */
function probeArgument(): string {
  const start = SOURCE.indexOf('window.Musaeum.ai.test(')
  expect(start, 'the Test button must call ai.test').toBeGreaterThan(-1)
  return SOURCE.slice(start, SOURCE.indexOf('})', start))
}

describe('the Ask (AI) section', () => {
  it('tests the values in the form, never the stored ones', () => {
    // D3.4. The button answers *before* committing, so the model and the key it
    // probes have to be the ones on screen. Probing the stored config would
    // make the button useless for the case it exists for — a key just pasted
    // into a field that has not been saved.
    //
    // The endpoint is the one exception, and it is deliberate: a blank field
    // resolves to what the app would actually use, which is what makes the
    // first Test on a fresh install mean anything. `view.resolved.aiBaseUrl.value`
    // is therefore allowed *there* and nowhere else, and the key's own resolved
    // value is a `detail` string by contract — never the key.
    const argument = probeArgument()
    expect(argument).toContain('baseUrl: form.aiBaseUrl.trim() || view.resolved.aiBaseUrl.value')
    expect(argument).toContain('model: form.aiModel.trim()')
    expect(argument).toContain('apiKey: form.aiApiKey.trim()')
    expect(argument).not.toContain('view.values')
    expect(argument).not.toContain('view.resolved.aiApiKey')
  })

  it('reads the stored key in exactly one place, and it is the form initializer', () => {
    // Not a limit on the count for its own sake: a second read of
    // `view.values.aiApiKey` outside `toForm` would be a code path that sends
    // the *stored* key while the user is looking at a different one in the field.
    expect(count('ai.test(')).toBe(1)
    expect(count('view.values.aiApiKey')).toBe(1)
    const inForm = SOURCE.indexOf('aiApiKey: view.values.aiApiKey ??')
    expect(inForm).toBeGreaterThan(-1)
    // …and that single read is inside toForm, which is what seeds the field
    expect(SOURCE.slice(0, SOURCE.indexOf('function changedFields'))).toContain(
      'aiApiKey: view.values.aiApiKey ??'
    )
  })

  it('derives the provider from the endpoint and never stores one', () => {
    // D3.2 (AC26/AC28). One fact, one home: if the file ever carried a
    // `useState` for the provider, the select and the endpoint could disagree
    // about where the reader's questions go, and neither would look wrong.
    expect(SOURCE).toContain('matchProvider(')
    expect(SOURCE).toContain('value={selected.id}')
    expect(SOURCE).toContain("set('aiBaseUrl')(row.baseUrl)")
    expect(SOURCE).not.toMatch(/ai_provider|aiProvider/)
  })

  it('clears a verdict when the values it was about are edited', () => {
    // D3.7 (AC36). A "the key works" line left standing beside a URL the user is
    // halfway through changing is the one lie this section could tell.
    const setAi = SOURCE.slice(
      SOURCE.indexOf('const setAi ='),
      SOURCE.indexOf('const chooseProvider')
    )
    expect(setAi).toContain('set(key)(value)')
    expect(setAi).toContain('setProbe(null)')
    for (const field of ['aiBaseUrl', 'aiModel', 'aiApiKey']) {
      expect(SOURCE).toContain(`onChange={setAi('${field}')}`)
    }
  })

  it('keeps nothing about the verdict on disk', () => {
    // D3.7. A restored verdict would describe a request that is not in flight,
    // against a key that may since have been revoked — the persisted-state rule
    // this dialog follows for everything it does not save.
    expect(SOURCE).not.toContain('localStorage')
    expect(SOURCE).not.toContain('sessionStorage')
  })

  it('gives the section a Save without introducing a second behaviour', () => {
    // D3.6 (AC35). One `save`, three callers: ⌘↵, the footer's Save changes and
    // the section's Save. A second save function is what would make two buttons
    // in one dialog mean different things about the same form.
    expect(count('const save = ')).toBe(1)
    expect(count('onClick={() => void save()}')).toBe(2)
    expect(count('void save()')).toBe(3)
    expect(SOURCE).not.toMatch(/const saveAi|saveAskSection/)
  })
})
