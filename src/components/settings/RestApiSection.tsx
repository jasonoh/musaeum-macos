import { useState } from 'react'
import type { RestApiListenState, SettingsView } from '@shared/settings.types'
import { CheckIcon, EyeIcon, WarningIcon } from '@/components/shared/icons'
import { statusLine } from '../../lib/rest-api-status'

/**
 * The phone API's row — the Settings surface for the iOS companion's server
 * (slice 2; `docs/superpowers/specs/2026-09-22-ios-companion-design.md`,
 * criteria 27–30, decisions D3 and D13).
 *
 * *What the row is for.* Every value the API runs with is in `app_config` and
 * none of it was reachable from the UI: enabling it, choosing its port, pinning
 * or clearing the bind, and getting the token and the URL onto a phone. The row
 * is those five things plus the one thing only the running app can say — where
 * the socket actually is, and why not, when it is nowhere.
 *
 * *Two controls, two speeds, and the difference is deliberate.* The **switch**
 * applies on click, because what it changes is a socket: pressing it calls
 * `settings:save`, which writes the flag and starts or stops the listener
 * before it answers, and the row then renders the state the socket is *in*. The
 * modal's batching cannot express that — a switch that showed "On" beside a
 * status that still said "Not listening" until someone pressed Save is the
 * failure AC27 names. **Port and bind ride the dialog's one Save**, like every
 * other field in this modal, because they are values the app reads later: a
 * half-typed port is not a thing to bind, and blank still means "auto" — for
 * the port the compiled-in default, for the bind this machine's tailnet
 * address.
 *
 * *The credential is read where it is shown, never captured.* `values
 * .restApiToken` is read on every render and again at the moment Copy is
 * pressed, so a value the app just generated — enabling generates one — is what
 * the row reveals, copies and masks. A `useState` seed or a ref holding the
 * token would show the empty string a fresh install has until the modal is
 * reopened, which is the stale-reader defect class this repo has already paid
 * for once (`ReaderView`'s stale list, D17). Copy goes through
 * `navigator.clipboard.writeText` with the value in hand: not a `console.log`,
 * not a `data-` attribute, and not something read back out of the DOM.
 *
 * *Why the markup is duplicated rather than imported.* The modal's `Field` and
 * `Section` are private to `SettingsModal.tsx`, and importing them back up
 * would close an import cycle — the same reason `AppearanceSection.tsx`
 * restates these classes. They match class for class; a change to one is a
 * change to both, which is the cost of the split.
 */

/** What the status line says, and the tone it says it in. */
const STATE_TONE: Record<RestApiListenState, string> = {
  disabled: 'text-parchment-faint',
  starting: 'text-warn-400',
  listening: 'text-ok-400',
  failed: 'text-danger-400'
}

interface RestApiSectionProps {
  view: SettingsView
  /** A row write is in flight — its own flag, so it never greys the whole dialog. */
  applying: boolean
  /** A dialog write is in flight; the switch must not fire a second one into it. */
  busy: boolean
  /** The switch's write: applied on click, because it starts and stops a socket. */
  onSetEnabled(enabled: boolean): void
  /** The two fields, as the dialog's form holds them (blank = auto). */
  port: string
  bind: string
  onPort(value: string): void
  onBind(value: string): void
}

export function RestApiSection({
  view,
  applying,
  busy,
  onSetEnabled,
  port,
  bind,
  onPort,
  onBind
}: RestApiSectionProps) {
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)

  const { status, url } = view.restApi
  const token = view.values.restApiToken
  // The stored flag, not a local copy of it: the switch shows what `app_config`
  // says, and the toggle's own reply (`settings:save` answers with the fresh
  // view) is what moves it.
  const enabled = view.values.restApiEnabled === 'true'

  /**
   * One click, and a value the phone needs. The token is read *here*, off the
   * current view, rather than from a value this component captured earlier.
   */
  const copy = async () => {
    if (!token) return
    setCopyError(null)
    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      setCopyError(`Could not copy the token — ${err instanceof Error ? err.message : err}`)
    }
  }

  return (
    <>
      <div className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-parchment">Serve the library to your phone</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-parchment-dim">
              A JSON API the iOS companion reads: browse and search the library, pull a book, and
              report where you are in it. It binds the tailnet only, and every request carries the
              token below — so the tailnet is the fence and the token is the key.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Serve the library to your phone"
            disabled={applying || busy}
            onClick={() => onSetEnabled(!enabled)}
            className="mt-px flex shrink-0 items-center gap-2 rounded-full border border-ink-600 py-0.5 pl-1 pr-2.5 text-[12px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40"
          >
            <span
              aria-hidden
              className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
                enabled ? 'border-gold-500/60 bg-gold-500/25' : 'border-ink-600 bg-ink-800'
              }`}
            >
              <span
                className={`absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full transition-all ${
                  enabled ? 'left-[18px] bg-gold-400' : 'left-0.5 bg-parchment-faint'
                }`}
              />
            </span>
            {applying ? 'Working…' : enabled ? 'On' : 'Off'}
          </button>
        </div>

        {/* The live listen status, in the socket's own words. `reason` is never
            re-worded here and never invented: it is what the server recorded,
            and it is the whole point of the row when a bind fails. */}
        <p className={`mt-2 text-[11px] leading-relaxed ${STATE_TONE[status.state]}`}>
          {statusLine(status, enabled)}
        </p>
      </div>

      <div className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-parchment-faint">
          Type this into the phone
        </p>
        {url ? (
          <p className="mt-1 font-mono text-[12px] text-parchment">{url}</p>
        ) : (
          // No address to serve on: the resolver's own sentence, where the URL
          // would have been. A loopback URL standing in for one would be a wrong
          // answer wearing the shape of a right one (`services/api/bind.ts`).
          <p className="mt-1 text-[12px] leading-relaxed text-parchment-dim">
            {view.restApi.addressReason ?? 'No address to serve on.'}
          </p>
        )}
        <p className="mt-1 text-[11px] leading-relaxed text-parchment-faint">
          {view.restApi.addressSource === 'override'
            ? 'The bind below names this address. Clear it to go back to this machine’s tailnet address.'
            : view.restApi.addressSource === 'tailnet'
              ? 'This machine’s tailnet address, resolved when the row reads it. Set the bind below to name one exactly.'
              : 'The address is resolved when the row reads it.'}{' '}
          The port is {view.restApi.port}
          {port.trim() && port.trim() !== String(view.restApi.port)
            ? ' — the field below takes effect when you save.'
            : '.'}
        </p>
      </div>

      <Field
        label="Port"
        value={port}
        onChange={onPort}
        placeholder={String(view.restApi.port)}
        mono
        hint="Blank uses the default port above. Changing it rebuilds the socket when you save."
      />

      <Field
        label="Bind address"
        value={bind}
        onChange={onBind}
        placeholder={view.restApi.address ?? 'No address to bind'}
        mono
        hint={
          view.restApi.addressSource === 'override'
            ? 'Set here. Blank goes back to this machine’s tailnet address — a loopback address is only reachable from this Mac.'
            : 'Blank resolves this machine’s tailnet address when the server starts. Anything but loopback or a tailnet address is refused rather than bound.'
        }
      />

      <div>
        <div className="flex items-end gap-2">
          <label className="block min-w-0 flex-1">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-parchment-faint">
              Token
            </span>
            <input
              readOnly
              value={token ?? ''}
              type={revealed ? 'text' : 'password'}
              placeholder="No token yet — turning the switch on generates one"
              spellCheck={false}
              autoComplete="off"
              className="mt-1 w-full rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1.5 font-mono text-[12px] text-parchment placeholder:text-parchment-faint/50 focus:border-gold-500/60 focus:outline-none focus:ring-1 focus:ring-gold-500/30"
            />
          </label>
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            disabled={!token}
            aria-label={revealed ? 'Hide token' : 'Show token'}
            aria-pressed={revealed}
            className="mb-px shrink-0 rounded-md border border-ink-600 p-1.5 text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40"
          >
            <EyeIcon className="h-4 w-4" off={revealed} />
          </button>
          <button
            type="button"
            onClick={() => void copy()}
            disabled={!token}
            aria-label="Copy token"
            className="mb-px flex shrink-0 items-center gap-1.5 rounded-md border border-ink-600 px-2.5 py-1.5 text-[12px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40"
          >
            {copied && <CheckIcon className="h-3.5 w-3.5 text-ok-400" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        {copyError && (
          <p className="mt-1 flex items-start gap-1.5 text-[11px] leading-relaxed text-danger-400">
            <WarningIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{copyError}</span>
          </p>
        )}
        <p className="mt-1 text-[11px] leading-relaxed text-parchment-faint">
          Generated when you turn the switch on, never typed — turning the API off keeps it, so
          re-enabling hands the same URL and the same token back. The phone sends it as{' '}
          <span className="font-mono">Authorization: Bearer …</span>, so paste it somewhere only the
          phone will see it.
        </p>
      </div>
    </>
  )
}

/** The modal's field markup, restated — see the note at the top of this file. */
function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  mono
}: {
  label: string
  value: string
  onChange(value: string): void
  placeholder?: string
  hint?: string
  mono?: boolean
}) {
  return (
    <label className="block min-w-0">
      <span className="text-[11px] font-semibold uppercase tracking-widest text-parchment-faint">
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className={`mt-1 w-full rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[13px] text-parchment placeholder:text-parchment-faint/50 focus:border-gold-500/60 focus:outline-none focus:ring-1 focus:ring-gold-500/30 ${
          mono ? 'font-mono text-[12px]' : ''
        }`}
      />
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-parchment-faint">{hint}</p>}
    </label>
  )
}
