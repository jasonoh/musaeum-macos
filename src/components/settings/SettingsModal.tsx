import { useCallback, useEffect, useState } from 'react'
import type { EditableSettings, ExecutableKind, SettingsView } from '@shared/settings.types'
import { useNASStore } from '@/stores/nas.store'
import { useUIStore } from '@/stores/ui.store'
import { AppearanceSection } from './AppearanceSection'
import { EyeIcon, SpinnerIcon } from '@/components/shared/icons'

/**
 * The only way to change `app_config` from the UI. Everything here except the
 * library root is a plain field saved together; the root keeps its own flow
 * (`nas.chooseLibraryRoot`) because picking one can adopt an existing
 * catalog, which is a decision the user has to answer as it happens.
 *
 * Blank means "auto-detect", never "empty" — each field's placeholder is what
 * the app resolves to today, so clearing a path visibly falls back to it
 * rather than breaking the feature.
 */

interface FormState {
  smbUrl: string
  pythonPath: string
  ebookConvertPath: string
  googleBooksApiKey: string
}

const EMPTY_FORM: FormState = {
  smbUrl: '',
  pythonPath: '',
  ebookConvertPath: '',
  googleBooksApiKey: ''
}

function toForm(view: SettingsView): FormState {
  return {
    smbUrl: view.values.smbUrl ?? '',
    pythonPath: view.values.pythonPath ?? '',
    ebookConvertPath: view.values.ebookConvertPath ?? '',
    googleBooksApiKey: view.values.googleBooksApiKey ?? ''
  }
}

/** Only the fields the user actually changed, blanks kept as explicit clears. */
function changedFields(view: SettingsView, form: FormState): Partial<EditableSettings> {
  const original = toForm(view)
  const updates: Partial<EditableSettings> = {}
  for (const [key, value] of Object.entries(form) as [keyof FormState, string][]) {
    if (value.trim() !== original[key].trim()) updates[key] = value.trim() || null
  }
  return updates
}

export function SettingsModal() {
  const openModal = useUIStore((s) => s.openModal)
  const nasStatus = useNASStore((s) => s.status)

  const [view, setView] = useState<SettingsView | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [revealKey, setRevealKey] = useState(false)

  const close = useCallback(() => openModal(null), [openModal])

  const load = useCallback(async () => {
    const next = await window.Musaeum.settings.get()
    setView(next)
    setForm(toForm(next))
  }, [])

  useEffect(() => {
    // State is set after the IPC round-trip resolves, never synchronously
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err))
    )
  }, [load])

  const save = async () => {
    if (!view) return
    const updates = changedFields(view, form)
    if (!Object.keys(updates).length) {
      close()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await window.Musaeum.settings.save(updates)
      // Re-read rather than assume: a saved path changes what resolves, and
      // a cleared one falls back to a value only the main process knows
      await load()
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) close()
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // No dep array: re-bound each render so ⌘↵ saves the current form values
  })

  const set = (key: keyof FormState) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const browse = async (kind: ExecutableKind, key: keyof FormState) => {
    const picked = await window.Musaeum.settings.chooseExecutable(kind)
    if (picked) set(key)(picked)
  }

  const changeRoot = async () => {
    setBusy(true)
    setError(null)
    try {
      const root = await window.Musaeum.nas.chooseLibraryRoot()
      if (root) await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-ink-950/80 p-8 backdrop-blur-sm"
      onClick={() => !busy && close()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-cover-lift"
      >
        <div className="shrink-0 border-b border-ink-800 px-5 py-4">
          <h2 className="font-display text-lg leading-snug text-parchment">Settings</h2>
          <p className="mt-0.5 text-[12px] text-parchment-faint">
            Stored locally on this machine, not in the library
          </p>
        </div>

        {!view ? (
          <div className="flex items-center gap-2 px-5 py-8 text-[13px] text-parchment-dim">
            <SpinnerIcon className="h-4 w-4" />
            Loading…
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
            {/* First, and applying on click rather than on save: it is what this
                dialog is opened for, and the only control here that is its own
                feedback loop (AC4.5) */}
            <AppearanceSection />

            <Section title="Library">
              <div className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-[12px] text-parchment">
                      {view.values.libraryRoot ?? 'No library folder chosen'}
                    </p>
                    <p className="mt-0.5 text-[11px] text-parchment-faint">
                      {nasStatus?.state === 'connected'
                        ? 'Connected'
                        : nasStatus?.state === 'reconnecting'
                          ? 'Reconnecting…'
                          : nasStatus?.state === 'unconfigured'
                            ? 'Not configured'
                            : 'Offline'}
                    </p>
                  </div>
                  <button
                    disabled={busy}
                    onClick={() => void changeRoot()}
                    className="shrink-0 rounded-md border border-ink-600 px-2.5 py-1 text-[12px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40"
                  >
                    Change…
                  </button>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-parchment-faint">
                  Changing the folder applies immediately — if it already holds a Musaeum
                  library you’ll be asked whether to load it.
                </p>
              </div>

              <Field
                label="SMB URL"
                value={form.smbUrl}
                onChange={set('smbUrl')}
                placeholder={view.resolved.smbUrl.value ?? ''}
                mono
                hint={
                  view.resolved.smbUrl.source === 'default'
                    ? 'Default — the share Musaeum mounts when the library folder goes missing'
                    : 'Mounted automatically when the library folder goes missing'
                }
              />
            </Section>

            <Section title="Metadata">
              <div>
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Field
                      label="Google Books API key"
                      value={form.googleBooksApiKey}
                      onChange={set('googleBooksApiKey')}
                      placeholder={
                        view.resolved.googleBooksApiKey.source === 'env'
                          ? 'Set in the environment'
                          : 'Unset — fetches run unauthenticated'
                      }
                      mono
                      type={revealKey ? 'text' : 'password'}
                    />
                  </div>
                  <button
                    onClick={() => setRevealKey((v) => !v)}
                    aria-label={revealKey ? 'Hide API key' : 'Show API key'}
                    className="mb-px shrink-0 rounded-md border border-ink-600 p-1.5 text-parchment-dim hover:bg-ink-800 hover:text-parchment"
                  >
                    <EyeIcon className="h-4 w-4" off={revealKey} />
                  </button>
                </div>
                <Note>
                  {sourceLabel(view.resolved.googleBooksApiKey.source, {
                    configured: 'Using the key set here',
                    env: 'Inherited from the environment — a key set here takes precedence',
                    none: 'No key: hydration still works, but Google Books rate-limits harder'
                  })}
                  {view.resolved.googleBooksApiKey.detail &&
                    view.resolved.googleBooksApiKey.source !== 'none' &&
                    ` (${view.resolved.googleBooksApiKey.detail})`}
                </Note>
              </div>
            </Section>

            <Section title="Tools">
              <PathField
                label="Python interpreter"
                value={form.pythonPath}
                onChange={set('pythonPath')}
                resolved={view.resolved.pythonPath}
                onBrowse={() => void browse('python', 'pythonPath')}
                fallbackNote="Auto-detected — the sidecar venv, or the newest Python 3 on PATH"
                missingNote="No Python 3.11+ found — metadata hydration is disabled"
              />
              <PathField
                label="ebook-convert"
                value={form.ebookConvertPath}
                onChange={set('ebookConvertPath')}
                resolved={view.resolved.ebookConvertPath}
                onBrowse={() => void browse('ebookConvert', 'ebookConvertPath')}
                fallbackNote="Auto-detected from the standard Calibre install"
                missingNote="Calibre not found — Kindle transfers can’t convert EPUB to AZW3"
              />
            </Section>

            <p className="text-[11px] leading-relaxed text-parchment-faint">
              Leave a field blank to go back to auto-detection. Changing the interpreter or the
              API key restarts the metadata sidecar.
            </p>
          </div>
        )}

        <div className="shrink-0 border-t border-ink-800 px-5 py-3">
          {error && <p className="mb-2 text-[12px] text-red-400">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-[11px] text-parchment-faint">
              {saved ? 'Saved' : '⌘↵ to save'}
            </span>
            <button
              disabled={busy}
              onClick={close}
              className="rounded-md border border-ink-600 px-3 py-1.5 text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40"
            >
              Done
            </button>
            <button
              disabled={busy || !view}
              onClick={() => void save()}
              className="flex items-center gap-2 rounded-md bg-gold-500 px-3 py-1.5 text-[13px] font-semibold text-ink-950 hover:bg-gold-400 disabled:opacity-40"
            >
              {busy && <SpinnerIcon className="h-4 w-4" />}
              Save changes
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function sourceLabel(source: string, labels: Record<string, string>): string {
  return labels[source] ?? ''
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-widest text-gold-400/80">
        {title}
      </h3>
      {children}
    </section>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-[11px] leading-relaxed text-parchment-faint">{children}</p>
}

/** A tool path: type it, or browse for it; blank falls back to detection. */
function PathField({
  label,
  value,
  onChange,
  resolved,
  onBrowse,
  fallbackNote,
  missingNote
}: {
  label: string
  value: string
  onChange(value: string): void
  resolved: { value: string | null; source: string; detail?: string }
  onBrowse(): void
  fallbackNote: string
  missingNote: string
}) {
  return (
    <div>
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field
            label={label}
            value={value}
            onChange={onChange}
            placeholder={resolved.value ?? 'Not found'}
            mono
          />
        </div>
        <button
          onClick={onBrowse}
          className="mb-px shrink-0 rounded-md border border-ink-600 px-2.5 py-1.5 text-[12px] text-parchment-dim hover:bg-ink-800 hover:text-parchment"
        >
          Browse…
        </button>
      </div>
      <Note>
        {resolved.source === 'none'
          ? missingNote
          : resolved.source === 'auto'
            ? fallbackNote
            : 'Set here'}
        {resolved.detail && resolved.source !== 'none' && ` — ${resolved.detail}`}
      </Note>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  mono,
  type
}: {
  label: string
  value: string
  onChange(value: string): void
  placeholder?: string
  hint?: string
  mono?: boolean
  type?: 'text' | 'password'
}) {
  return (
    <label className="block min-w-0">
      <span className="text-[11px] font-semibold uppercase tracking-widest text-parchment-faint">
        {label}
      </span>
      <input
        value={value}
        type={type ?? 'text'}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className={`mt-1 w-full rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[13px] text-parchment placeholder:text-parchment-faint/50 focus:border-gold-500/60 focus:outline-none focus:ring-1 focus:ring-gold-500/30 ${
          mono ? 'font-mono text-[12px]' : ''
        }`}
      />
      {hint && <Note>{hint}</Note>}
    </label>
  )
}
