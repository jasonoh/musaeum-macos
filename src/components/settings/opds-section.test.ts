import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * Source walks over the OPDS catalog's Settings row (O1, Task 5). The renderer
 * has no DOM harness here, so wiring claims are decided by reading the two
 * files; what the row computes is decided in `services/settings.test.ts`.
 * The template is `rest-api-section.test.ts`, and the row mirrors Phone access
 * except for the one thing a reader app needs that the phone does not: the
 * username.
 */

const read = (file: string): string =>
  readFileSync(join(process.cwd(), 'src', 'components', 'settings', file), 'utf8')

const SECTION = read('OpdsSection.tsx')
const MODAL = read('SettingsModal.tsx')

function count(source: string, needle: string): number {
  return source.split(needle).length - 1
}

/** The source of the modal's `setOpdsEnabled`, which is the OPDS row's own write. */
function setOpdsEnabledBody(): string {
  const start = MODAL.indexOf('const setOpdsEnabled =')
  expect(start, 'the OPDS row must have its own write').toBeGreaterThan(-1)
  return MODAL.slice(start, MODAL.indexOf('useEffect(', start))
}

describe('the OPDS row', () => {
  it('shows the switch, port, bind, token, URL, username and status, all read from view.opds', () => {
    expect(SECTION).toContain('view.values.opdsEnabled')
    expect(SECTION).toContain('view.values.opdsToken')
    expect(SECTION).toContain('const { status, url } = view.opds')
    expect(SECTION).toContain('{url}')
    expect(SECTION).toContain('{view.opds.port}')
    expect(SECTION).toContain('placeholder={view.opds.address')
    expect(SECTION).toContain('{statusLine(status, enabled)}')
    expect(SECTION).not.toContain('restApi')
  })

  it('names the fixed username the reader app types', () => {
    expect(SECTION).toContain('Username')
    expect(SECTION).toContain('musaeum')
    expect(SECTION).toContain('Basic')
  })

  it('never builds the URL and never words the socket’s failures', () => {
    expect(SECTION).not.toMatch(/'http:\/\/'|`http:\/\/|"http:\/\//)
    expect(SECTION).not.toContain('8789')
    expect(SECTION).not.toMatch(/EADDRINUSE|already in use|not an address on this machine/)
    expect(SECTION).toContain('view.opds.addressReason')
    expect(SECTION).toContain('Tailscale')
  })

  it('cannot fire a second write while one is in flight', () => {
    expect(SECTION).toContain('disabled={applying || busy}')
    expect(SECTION).toContain('role="switch"')
    expect(SECTION).toContain('aria-checked={enabled}')
  })

  it('reveals and copies the token read where it is shown, not captured', () => {
    expect(SECTION).toContain('const token = view.values.opdsToken')
    expect(count(SECTION, 'view.values.opdsToken')).toBe(1)
    expect(SECTION).toContain('await navigator.clipboard.writeText(token)')
    expect(SECTION).not.toMatch(/opdsToken[^\n]*\buseState\(/)
    expect(SECTION).not.toMatch(/useRef\([^\n]*opdsToken/)
    expect(SECTION).not.toMatch(/data-token|dataset\.|console\.\w+\(/)
    expect(SECTION).toContain("type={revealed ? 'text' : 'password'}")
    expect(SECTION).toContain('setRevealed((v) => !v)')
  })

  it('applies the switch on click, sends only a moved port/bind, and never the token', () => {
    const body = setOpdsEnabledBody()
    expect(body).toContain("opdsEnabled: enabled ? 'true' : 'false'")
    expect(body).toContain("form.opdsPort.trim() !== (view.values.opdsPort ?? '').trim()")
    expect(body).toContain("form.opdsBind.trim() !== (view.values.opdsBind ?? '').trim()")
    expect(body).toContain('updates.opdsPort = form.opdsPort.trim() || null')
    expect(body).toContain('updates.opdsBind = form.opdsBind.trim() || null')
    expect(body).toContain('setView(await window.Musaeum.settings.save(updates))')
    expect(body).not.toContain('opdsToken')
    expect(body).not.toContain('setForm(')
    expect(MODAL).toContain('onSetEnabled={(next) => void setOpdsEnabled(next)}')
  })

  it('lets port and bind ride the dialog’s one Save; flag and token are not form fields', () => {
    expect(MODAL).toContain('opdsPort: string')
    expect(MODAL).toContain('opdsBind: string')
    expect(MODAL).not.toContain('opdsToken: string')
    expect(MODAL).not.toContain('opdsEnabled: string')
    expect(MODAL).toContain("opdsPort: view.values.opdsPort ?? ''")
    expect(MODAL).toContain("opdsBind: view.values.opdsBind ?? ''")
    expect(MODAL).toContain("onPort={set('opdsPort')}")
    expect(MODAL).toContain("onBind={set('opdsBind')}")
  })

  it('writes through the one channel, names no raw key, and holds no store', () => {
    expect(count(MODAL, 'window.Musaeum.settings.save(')).toBe(3)
    expect(SECTION).not.toContain('window.Musaeum')
    expect(MODAL).not.toContain('opds_')
    expect(SECTION).not.toContain('opds_')
    expect(SECTION).not.toMatch(/localStorage|sessionStorage|zustand/)
  })

  it('is mounted after Phone access under its own title, and the footnote says it applies on click', () => {
    const phone = MODAL.indexOf('<Section title="Phone access">')
    const opds = MODAL.indexOf('<Section title="Device access (OPDS)">')
    expect(phone).toBeGreaterThan(-1)
    expect(opds).toBeGreaterThan(phone)
    expect(MODAL).toContain('<OpdsSection')
    expect(MODAL).toMatch(/OPDS switch applies/)
  })
})
