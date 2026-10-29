import { useState } from 'react'
import type { OpdsListenState, SettingsView } from '@shared/settings.types'
import { CheckIcon, EyeIcon, WarningIcon } from '@/components/shared/icons'
import { statusLine } from '../../lib/rest-api-status'

/**
 * The OPDS catalog's row — the Settings surface for the server a Kindle-class
 * reader app (KOReader, Boox's Neo Reader, Marvin) browses
 * (`docs/superpowers/specs/2026-09-19-opds-catalog-design.md`, Amendments A4/A5).
 *
 * It mirrors `RestApiSection` on purpose and the rules carry over unchanged
 * (`docs/invariants/settings-and-editing.md`, "The phone API's four keys"): the
 * **switch** applies on click through `settings:save`, which starts or stops the
 * listener before it answers; **port and bind** ride the dialog's one Save,
 * blank meaning auto; the **token** is read where it is shown and again where
 * Copy is pressed, never captured at mount, and is generated on enable, never
 * typed; and the status line is the socket's own report, not a description of it.
 *
 * What the phone row does not need is the **username**. The reader apps speak
 * HTTP Basic, so a person types two things: the fixed username `musaeum`, and the
 * token as the password. The row says both, beside the URL.
 *
 * The markup is restated rather than imported for the reason `RestApiSection`
 * gives: the modal's `Field` is private to it and importing it back would close
 * a cycle. A change to one is a change to both.
 */

const STATE_TONE: Record<OpdsListenState, string> = {
  disabled: 'text-parchment-faint',
  starting: 'text-warn-400',
  listening: 'text-ok-400',
  failed: 'text-danger-400'
}

interface OpdsSectionProps {
  view: SettingsView
  /** A row write is in flight — its own flag, so it never grays the whole dialog. */
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

export function OpdsSection({
  view,
  applying,
  busy,
  onSetEnabled,
  port,
  bind,
  onPort,
  onBind
}: OpdsSectionProps) {
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)

  const { status, url } = view.opds
  const token = view.values.opdsToken
  // The stored flag, not a local copy of it: the toggle's own reply is the
  // freshly-composed view, and that is what moves the switch.
  const enabled = view.values.opdsEnabled === 'true'

  /** The token is read here, off the current view, not from an earlier capture. */
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
            <p className="text-[13px] text-parchment">Serve the library to e-reader apps</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-parchment-dim">
              An OPDS catalog that apps like KOReader and the Boox reader browse: search the library
              and download a book straight onto the device. It binds the tailnet only, so the device
              needs Tailscale, and every request carries the username and token below.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Serve the library to e-reader apps"
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

        {/* The socket's own words, never re-worded here (see RestApiSection). */}
        <p className={`mt-2 text-[11px] leading-relaxed ${STATE_TONE[status.state]}`}>
          {statusLine(status, enabled)}
        </p>
      </div>

      <div className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-parchment-faint">
          Type this into the reader app
        </p>
        {url ? (
          <p className="mt-1 font-mono text-[12px] text-parchment">{url}</p>
        ) : (
          // No address: the resolver's own sentence, where the URL would have been.
          // It needs this Mac's Tailscale address; a loopback URL would be a wrong
          // answer wearing the shape of a right one.
          <p className="mt-1 text-[12px] leading-relaxed text-parchment-dim">
            {view.opds.addressReason ??
              'No address to serve on — this needs the Tailscale address.'}
          </p>
        )}
        <p className="mt-2 text-[11px] font-semibold uppercase tracking-widest text-parchment-faint">
          Username
        </p>
        <p className="mt-1 font-mono text-[12px] text-parchment">musaeum</p>
        <p className="mt-1 text-[11px] leading-relaxed text-parchment-faint">
          {view.opds.addressSource === 'override'
            ? 'The bind below names this address. Clear it to go back to this machine’s Tailscale address.'
            : view.opds.addressSource === 'tailnet'
              ? 'This machine’s Tailscale address, resolved when the row reads it. Set the bind below to name one exactly.'
              : 'The address is resolved when the row reads it, and needs Tailscale to be running.'}{' '}
          The port is {view.opds.port}
          {port.trim() && port.trim() !== String(view.opds.port)
            ? ' — the field below takes effect when you save.'
            : '.'}
        </p>
      </div>

      <Field
        label="Port"
        value={port}
        onChange={onPort}
        placeholder={String(view.opds.port)}
        mono
        hint="Blank uses the default port above. Changing it rebuilds the socket when you save."
      />

      <Field
        label="Bind address"
        value={bind}
        onChange={onBind}
        placeholder={view.opds.address ?? 'No address to bind'}
        mono
        hint={
          view.opds.addressSource === 'override'
            ? 'Set here. Blank goes back to this machine’s Tailscale address — a loopback address is only reachable from this Mac.'
            : 'Blank resolves this machine’s Tailscale address when the server starts. Anything but loopback or a tailnet address is refused rather than bound.'
        }
      />

      <div>
        <div className="flex items-end gap-2">
          <label className="block min-w-0 flex-1">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-parchment-faint">
              Token (the password)
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
          Generated when you turn the switch on, never typed — turning the catalog off keeps it. The
          reader app sends it with the username as HTTP Basic credentials, so enter{' '}
          <span className="font-mono">musaeum</span> and this token in its login fields. It is a
          different token from the phone’s.
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
