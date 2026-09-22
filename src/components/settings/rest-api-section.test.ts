import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * Source walks over the phone API's Settings row (slice 2, AC27–30).
 *
 * The renderer has no DOM harness in this repo (the vitest environment is Node,
 * with no React testing library), so the claims here that are about *wiring*
 * rather than about logic are decided by reading the two files. Each case says
 * what it does not prove, and the one thing that does decide what a running app
 * paints is the slice's probe: an isolated profile, `Settings` opened over CDP,
 * the row read off the rendered DOM.
 *
 * What the row *computes* is decided by real cases elsewhere:
 * `electron/main/services/settings.test.ts` for the four keys, the listener
 * decision and the composed view, and `services/api/bind.test.ts` for the
 * address rules the URL is built from.
 */

const read = (file: string): string =>
  readFileSync(join(process.cwd(), 'src', 'components', 'settings', file), 'utf8')

const SECTION = read('RestApiSection.tsx')
const MODAL = read('SettingsModal.tsx')

function count(source: string, needle: string): number {
  return source.split(needle).length - 1
}

/** The source of the modal's `setEnabled`, which is the row's own write. */
function setEnabledBody(): string {
  const start = MODAL.indexOf('const setEnabled =')
  expect(start, 'the row must have its own write').toBeGreaterThan(-1)
  return MODAL.slice(start, MODAL.indexOf('const set = (key: keyof FormState)'))
}

describe('the phone API row', () => {
  it('shows the five things AC27 names, and reads every one of them', () => {
    // The switch, the port, the bind, the token with its reveal, the URL to type
    // into the phone, and the live status. The status line is its own case
    // below; this one is about the four values being *read* rather than
    // remembered, which is what a stale closure would give up.
    expect(SECTION).toContain('view.values.restApiEnabled')
    expect(SECTION).toContain('view.values.restApiToken')
    expect(SECTION).toContain('const { status, url } = view.restApi')
    expect(SECTION).toContain('{url}')
    expect(SECTION).toContain('{view.restApi.port}')
    expect(SECTION).toContain('placeholder={view.restApi.address')
    expect(SECTION).toContain('type={revealed ? ')
  })

  it('never builds the URL — it renders the one the main process resolved', () => {
    // The address comes from this machine's interfaces, which the renderer has
    // no way to hold. A second implementation here would get the port fallback
    // or an IPv6 literal wrong, and the phone would type a URL nothing answers.
    expect(SECTION).toContain('{url}')
    expect(SECTION).not.toMatch(/'http:\/\/'|`http:\/\/|"http:\/\//)
    expect(SECTION).not.toContain('8788')
  })

  it('says nothing about the socket that the socket did not say (AC27)', () => {
    // The reason's words belong to `api/rest.ts`, which is where the failure
    // happened — so the renderer must not carry a single one of its sentences.
    // The *wording* of the four lines is decided in `src/lib/rest-api-status.test.ts`;
    // the row only calls it, and passes the stored flag so a listener that
    // stopped cannot be described as "the switch is off" beside a switch on On.
    expect(SECTION).toContain("import { statusLine } from '../../lib/rest-api-status'")
    expect(SECTION).toContain('{statusLine(status, enabled)}')
    expect(SECTION).not.toMatch(/EADDRINUSE|already in use|not an address on this machine/)
    expect(SECTION).not.toContain('could not start the server')
  })

  it('cannot fire a second write while one is in flight (the race the guard closes)', () => {
    // The switch applies on click while Save applies the rest, and
    // `saveSettingsAndApply` serializes nothing: a click during an in-flight
    // Save runs two overlapping writes, and the loser's `stopEpoch` can leave a
    // live socket reported as `disabled` with the flag true. Both flags guard.
    expect(SECTION).toContain('disabled={applying || busy}')
    expect(MODAL).toContain('busy={busy}')
  })

  it('reveals and copies the token read where it is shown, not captured', () => {
    // The credential 1a's review left for this slice: a value read at mount is
    // the value *before* the enable that generated it, so the row would reveal
    // an empty string until the dialog was reopened (D17's class, one field
    // over). Copy has to be a real clipboard write — the phone needs the token,
    // and a `console.log`, a `data-` attribute or a value read back out of the
    // DOM would all pass a weaker reading of "copyable".
    expect(SECTION).toContain('const token = view.values.restApiToken')
    expect(count(SECTION, 'view.values.restApiToken')).toBe(1)
    expect(SECTION).toContain('await navigator.clipboard.writeText(token)')
    expect(SECTION).not.toMatch(/restApiToken[^\n]*\buseState\(/)
    expect(SECTION).not.toMatch(/useRef\([^\n]*restApiToken/)
    expect(SECTION).not.toMatch(/data-token|dataset\.|console\.\w+\(/)
    // …and the reveal is a real one: the same input, masked by the browser
    expect(SECTION).toContain("type={revealed ? 'text' : 'password'}")
    expect(SECTION).toContain('setRevealed((v) => !v)')
  })

  it('applies the switch on click, and never sends the token with it', () => {
    // *Why on click*: the criterion asks for the live listen status, and the
    // command that moves the socket is the save — so a switch that waited for
    // Save would show a state the server is not in. *Why no token*: it is
    // generated on enable, and a blank field would clear the credential the
    // phone is already configured with.
    const body = setEnabledBody()
    expect(body).toContain("restApiEnabled: enabled ? 'true' : 'false'")
    expect(body).toContain('await window.Musaeum.settings.save(updates)')
    expect(body).not.toContain('restApiToken')
    expect(MODAL).toContain('onSetEnabled={(next) => void setEnabled(next)}')
    expect(SECTION).toContain('aria-checked={enabled}')
    expect(SECTION).toContain('role="switch"')
    // This does not prove the socket moved — the probe does that, by curling the
    // port and by reading the row's status after the click.
  })

  it('sends the row’s port and bind only when they moved from what is stored', () => {
    // The switch applies what the row shows, so a port typed above it is the
    // port it starts on; a value that has not moved is not sent, so the write
    // stays exactly the row's own keys (AC28).
    const body = setEnabledBody()
    expect(body).toContain("form.restApiPort.trim() !== (view.values.restApiPort ?? '').trim()")
    expect(body).toContain("form.restApiBind.trim() !== (view.values.restApiBind ?? '').trim()")
    expect(body).toContain('updates.restApiPort = form.restApiPort.trim() || null')
    expect(body).toContain('updates.restApiBind = form.restApiBind.trim() || null')
  })

  it('lets the port and the bind ride the dialog’s one Save, blank meaning auto', () => {
    // Two fields, one Save, and the rule every other field in this dialog has:
    // blank is *cleared*, which for the port is the compiled-in default and for
    // the bind is this machine's tailnet address. The flag and the token are
    // deliberately not form fields — the switch applies on click, and the token
    // is never typed.
    expect(MODAL).toContain('restApiPort: string')
    expect(MODAL).toContain('restApiBind: string')
    expect(MODAL).not.toContain('restApiToken: string')
    expect(MODAL).toContain("restApiPort: view.values.restApiPort ?? ''")
    expect(MODAL).toContain("restApiBind: view.values.restApiBind ?? ''")
    expect(MODAL).toContain("onPort={set('restApiPort')}")
    expect(MODAL).toContain("onBind={set('restApiBind')}")
  })

  it('writes app_config through the one channel this dialog already had', () => {
    // The invariant file's rule: no second writer. Both the dialog's Save and
    // the row's switch go through `settings:save` — the switch is not a second
    // path to `app_config`, it is the same path with its own timing. And the
    // renderer names no raw key: the typed fields are what the type checker can
    // enumerate (`services/settings.ts`'s `CONFIG_KEYS`), which is the whole
    // reason `EditableSettings` carries the four.
    expect(count(MODAL, 'window.Musaeum.settings.save(')).toBe(2)
    expect(count(MODAL, 'window.Musaeum.settings.get(')).toBe(1)
    expect(SECTION).not.toContain('window.Musaeum')
    expect(MODAL).not.toContain('rest_api_')
    expect(SECTION).not.toContain('rest_api_')
    // The row is not a store: nothing about the API survives a close
    expect(SECTION).not.toMatch(/localStorage|sessionStorage|zustand/)
  })

  it('keeps the row out of the other sections’ save behaviour', () => {
    // The dialog saves a whole `EditableSettings` object; the row must not be
    // able to round-trip a neighbouring field as `undefined` and clear it. The
    // switch's reply updates the *view* only — the form is what holds every
    // section's unsaved edits, and one click must not discard them.
    const body = setEnabledBody()
    expect(body).toContain('setView(await window.Musaeum.settings.save(updates))')
    expect(body).not.toContain('setForm(')
    expect(count(MODAL, 'const save = ')).toBe(1)
  })
})
