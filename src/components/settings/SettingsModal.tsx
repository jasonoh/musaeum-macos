import { useCallback, useEffect, useState } from 'react'
import type { AiProbeResult } from '@shared/ai.types'
import type { EditableSettings, ExecutableKind, SettingsView } from '@shared/settings.types'
import { useNASStore } from '@/stores/nas.store'
import { useUIStore } from '@/stores/ui.store'
import { AppearanceSection } from './AppearanceSection'
import { RestApiSection } from './RestApiSection'
import { useLibraryStore } from '@/stores/library.store'
import { CheckIcon, EyeIcon, SpinnerIcon } from '@/components/shared/icons'
import { AI_PROVIDERS, endpointHint, hostOf, matchProvider, providerById } from '@/lib/ai-providers'

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

/** The model datalist, wired to the Model field by id. */
const AI_MODELS_LIST_ID = 'musaeum-ai-models'

/** One verdict's colour. `refused`/`no-model-list` are warnings, not failures. */
const VERDICT_TONE: Record<AiProbeResult['verdict'], string> = {
  ok: 'text-ok-400',
  rejected: 'text-danger-400',
  unreachable: 'text-danger-400',
  timeout: 'text-danger-400',
  refused: 'text-warn-400',
  'no-model-list': 'text-warn-400'
}

interface FormState {
  smbUrl: string
  restApiPort: string
  restApiBind: string
  aiBaseUrl: string
  aiModel: string
  aiApiKey: string
  pythonPath: string
  ebookConvertPath: string
  googleBooksApiKey: string
}

const EMPTY_FORM: FormState = {
  smbUrl: '',
  restApiPort: '',
  restApiBind: '',
  aiBaseUrl: '',
  aiModel: '',
  aiApiKey: '',
  pythonPath: '',
  ebookConvertPath: '',
  googleBooksApiKey: ''
}

function toForm(view: SettingsView): FormState {
  return {
    smbUrl: view.values.smbUrl ?? '',
    // The phone API's two fields. The flag and the token are deliberately *not*
    // form fields: the switch applies on click (AC27), and the token is
    // generated when the API is enabled and never typed by hand (D13).
    restApiPort: view.values.restApiPort ?? '',
    restApiBind: view.values.restApiBind ?? '',
    aiBaseUrl: view.values.aiBaseUrl ?? '',
    aiModel: view.values.aiModel ?? '',
    aiApiKey: view.values.aiApiKey ?? '',
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
  const sync = useLibraryStore((s) => s.catalogSync)
  const refreshLibrary = useLibraryStore((s) => s.refreshLibrary)
  const rebuildCatalog = useLibraryStore((s) => s.rebuildCatalog)

  const connected = nasStatus?.state === 'connected'
  const syncRunning = sync?.outcome === 'running'

  const [view, setView] = useState<SettingsView | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  // The phone API row's own in-flight flag. The switch starts and stops a
  // socket, so it owns its own `await`: a click on it must neither grey the
  // whole dialog (a Save elsewhere has nothing to do with it) nor be greyed by
  // one.
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [revealKey, setRevealKey] = useState(false)
  // Its own switch: two keys in one dialog, and one Eye toggling both would
  // reveal a key nobody asked to see
  const [revealAiKey, setRevealAiKey] = useState(false)
  // The Test verdict. Local and transient on purpose: a restored "the key
  // works" would describe a request that is not in flight, against a key that
  // may since have been revoked — the persisted-state rule this dialog already
  // follows for everything it does not save.
  const [probe, setProbe] = useState<AiProbeResult | null>(null)
  const [probeError, setProbeError] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)

  const close = useCallback(() => openModal(null), [openModal])

  const load = useCallback(async () => {
    const next = await window.Musaeum.settings.get()
    setView(next)
    setForm(toForm(next))
  }, [])

  useEffect(() => {
    // State is set after the IPC round-trip resolves, never synchronously
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
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
      // The reply *is* the re-read: the main process composes it after the
      // write (and after the phone API's listener has moved), so nothing here
      // has to assume what a cleared field fell back to — and a second round
      // trip cannot race the write it is meant to report on.
      const next = await window.Musaeum.settings.save(updates)
      setView(next)
      setForm(toForm(next))
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /**
   * The phone API's switch — the one control in this dialog that applies on
   * click rather than on Save (AC27).
   *
   * *Why it cannot wait for Save.* What it changes is a socket. `settings:save`
   * writes the flag and starts or stops the listener before it answers, so the
   * status the row shows afterwards is the state the server is *in* — a switch
   * that showed "On" beside a stale "Not listening" is the failure the
   * criterion names. The reply is the freshly-composed view, which is why the
   * row updates from one call and cannot read a status older than its own
   * write.
   *
   * *Why it sends the row's other two fields only when they moved.* The switch
   * applies what the row shows, so a port typed into the field above it is the
   * port it starts on — but a value that has not moved is not sent at all, so
   * the write stays exactly the row's own keys. `restApiToken` is never in this
   * payload: it is generated on enable, and sending a blank one would clear the
   * credential the phone is already configured with.
   *
   * *Why the form is left alone.* The form holds what the user has typed in
   * every section; a click on one switch must not throw those edits away. The
   * comparison in `changedFields` still sees them, because the values the
   * switch wrote are the values it re-read.
   */
  const setEnabled = async (enabled: boolean) => {
    if (!view) return
    const updates: Partial<EditableSettings> = { restApiEnabled: enabled ? 'true' : 'false' }
    if (form.restApiPort.trim() !== (view.values.restApiPort ?? '').trim()) {
      updates.restApiPort = form.restApiPort.trim() || null
    }
    if (form.restApiBind.trim() !== (view.values.restApiBind ?? '').trim()) {
      updates.restApiBind = form.restApiBind.trim() || null
    }

    setApplying(true)
    setError(null)
    try {
      setView(await window.Musaeum.settings.save(updates))
    } catch (err) {
      // A refused port or bind leaves the switch where it was: the save wrote
      // nothing, so the flag the row renders is still the truth. The refusal
      // lands in the dialog's error line, where the other fields' refusals go.
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
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

  /**
   * The Ask fields write through here, so editing any of them drops a verdict
   * that was about the values just replaced. A stale "the key works" beside a
   * URL the user is halfway through changing is the one lie this section could
   * tell.
   */
  const setAi = (key: 'aiBaseUrl' | 'aiModel' | 'aiApiKey') => (value: string) => {
    set(key)(value)
    setProbe(null)
    setProbeError(null)
  }

  /**
   * Choosing a provider writes its base URL into the form and nothing else —
   * no key is stored for it, and nothing is saved until Save is pressed. The
   * select's own value is *derived* from the endpoint (`matchProvider`), so
   * this can only ever move the field, never record a second opinion about it.
   */
  const chooseProvider = (id: string) => {
    const row = providerById(id)
    if (!row.baseUrl) return
    set('aiBaseUrl')(row.baseUrl)
    setProbe(null)
    setProbeError(null)
  }

  /**
   * Test the endpoint, model and key **in the form** — not the stored ones.
   * The button exists to answer before committing, so it can only report on
   * what is on screen; where the field is blank the resolved value is what the
   * app would actually use, which is what makes a first Test meaningful on a
   * machine with nothing configured yet.
   */
  const test = async () => {
    if (!view) return
    setProbing(true)
    setProbe(null)
    setProbeError(null)
    try {
      setProbe(
        await window.Musaeum.ai.test({
          baseUrl: form.aiBaseUrl.trim() || view.resolved.aiBaseUrl.value || '',
          model: form.aiModel.trim() || null,
          apiKey: form.aiApiKey.trim() || null
        })
      )
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : String(err))
    } finally {
      setProbing(false)
    }
  }

  const browse = async (kind: ExecutableKind, key: keyof FormState) => {
    const picked = await window.Musaeum.settings.chooseExecutable(kind)
    if (picked) set(key)(picked)
  }

  const changeRoot = async () => {
    setBusy(true)
    setError(null)
    try {
      // *Locate*, when that is the recovery this state offers (D6): the picker
      // opens where the folder used to be. The composer decides which recovery a
      // state has, so this asks it rather than reading the state again.
      const hint =
        nasStatus?.copy.recovery === 'locate' ? (nasStatus?.libraryRoot ?? undefined) : undefined
      const root = await window.Musaeum.nas.chooseLibraryRoot(hint)
      if (root) await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // The provider is *derived* from the effective endpoint — the form's value, or
  // what the app resolves to when the field is blank. Deriving it from the raw
  // field would read "Custom" on a fresh install, where the app is in fact
  // pointed at the compiled-in local model.
  const effectiveBaseUrl = form.aiBaseUrl.trim() || view?.resolved.aiBaseUrl.value || null
  const selected = providerById(matchProvider(effectiveBaseUrl))
  const listedModels = probe?.models ?? []
  const modelNote = listedModels.length
    ? `${probe?.modelCount ?? listedModels.length} models listed by this endpoint — type to filter, or pick one.`
    : view?.resolved.aiModel.detail

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-scrim/80 p-8 backdrop-blur-sm"
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
                    {/* The words are the main process's (D4), and they are
                        the same ones the sidebar row renders */}
                    <p className="mt-0.5 text-[11px] text-parchment-faint">
                      {nasStatus?.copy.label}
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
                  Changing the folder applies immediately — if it already holds a Musaeum library
                  you’ll be asked whether to load it.
                </p>
                {/* Which of the two the app settled on (D1), and the one line
                    that names a cloud client when the folder is inside one
                    (D7). Both sentences are composed in main. */}
                <p className="mt-2 text-[11px] leading-relaxed text-parchment-faint">
                  Storage:{' '}
                  <span className="text-parchment-dim">{view.resolved.libraryKind.value}</span>
                  {view.resolved.libraryKind.detail && ` — ${view.resolved.libraryKind.detail}`}
                </p>
                {view.syncRootNote && (
                  <p className="mt-2 text-[11px] leading-relaxed text-gold-400/80">
                    {view.syncRootNote}
                  </p>
                )}
              </div>

              {/* **Gated on the kind in force** (D5): a share is the only thing an
                  SMB URL can name, and a folder library used to be shown this field
                  with someone else's server in its placeholder. No placeholder now
                  either — nothing is compiled in, and the note says so. */}
              {nasStatus?.kind === 'network' && (
                <Field
                  label="SMB URL"
                  value={form.smbUrl}
                  onChange={set('smbUrl')}
                  mono
                  hint={view.resolved.smbUrl.detail}
                />
              )}
            </Section>

            <Section title="Maintenance">
              <MaintenanceRow
                title="Reload from the shared catalog"
                description="Re-reads the library's shared catalog and reloads Musaeum from it. This is what picks up what another machine has changed — the ordinary, quick case."
                caveat="If that catalog can't be read, this rebuilds from disk instead, which takes minutes rather than a second."
                action="Reload"
                busy={syncRunning && sync?.kind === 'refresh'}
                disabled={!connected || syncRunning}
                onRun={() => void refreshLibrary()}
              />
              <MaintenanceRow
                title="Rebuild the catalog"
                description="Recovery: walks every book folder's metadata and rewrites the shared catalog from what it finds. Use it when the catalog is missing or unreadable, or when books on disk aren't showing up here."
                caveat="Slow — around 21 minutes for a library this size, measured over the network. Nothing is written until the walk finishes, so cancelling it is free; the counter and its Cancel appear in the status bar."
                action="Rebuild"
                busy={syncRunning && sync?.kind === 'rebuild'}
                disabled={!connected || syncRunning}
                onRun={() => void rebuildCatalog()}
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

            <Section title="Ask (AI)">
              <label className="block min-w-0">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-parchment-faint">
                  Provider
                </span>
                <select
                  value={selected.id}
                  onChange={(e) => chooseProvider(e.target.value)}
                  className="mt-1 w-full rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[13px] text-parchment focus:border-gold-500/60 focus:outline-none focus:ring-1 focus:ring-gold-500/30"
                >
                  {AI_PROVIDERS.map((row) => (
                    <option key={row.id} value={row.id} disabled={row.baseUrl === null}>
                      {row.label}
                      {row.local ? ' — local' : ''}
                      {row.baseUrl === null ? ' — type an endpoint below' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <Field
                label="Endpoint"
                value={form.aiBaseUrl}
                onChange={setAi('aiBaseUrl')}
                placeholder={view.resolved.aiBaseUrl.value ?? ''}
                mono
                hint={endpointHint(form.aiBaseUrl, view.resolved.aiBaseUrl)}
              />
              <Field
                label="Model"
                value={form.aiModel}
                onChange={setAi('aiModel')}
                placeholder="No model set — the ask panel stays off"
                mono
                hint={modelNote}
                list={listedModels.length ? AI_MODELS_LIST_ID : undefined}
              />
              {listedModels.length > 0 && (
                <datalist id={AI_MODELS_LIST_ID}>
                  {listedModels.map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
              )}
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Field
                    label="API key (optional)"
                    value={form.aiApiKey}
                    onChange={setAi('aiApiKey')}
                    placeholder={
                      view.resolved.aiApiKey.source === 'env'
                        ? 'Set in the environment'
                        : selected.local
                          ? 'Not needed for a local model'
                          : `Paste the key ${selected.baseUrl ? `for ${hostOf(selected.baseUrl)}` : 'for this endpoint'}`
                    }
                    mono
                    type={revealAiKey ? 'text' : 'password'}
                  />
                </div>
                <button
                  onClick={() => setRevealAiKey((v) => !v)}
                  aria-label={revealAiKey ? 'Hide API key' : 'Show API key'}
                  className="mb-px shrink-0 rounded-md border border-ink-600 p-1.5 text-parchment-dim hover:bg-ink-800 hover:text-parchment"
                >
                  <EyeIcon className="h-4 w-4" off={revealAiKey} />
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void test()}
                  disabled={probing}
                  className="flex shrink-0 items-center gap-1.5 rounded-md border border-ink-600 px-2.5 py-1 text-[12px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40"
                >
                  {probing ? (
                    <SpinnerIcon className="h-3.5 w-3.5" />
                  ) : (
                    <CheckIcon className="h-3.5 w-3.5" />
                  )}
                  Test
                </button>
                <button
                  disabled={busy}
                  onClick={() => void save()}
                  className="shrink-0 rounded-md bg-gold-500 px-2.5 py-1 text-[12px] font-semibold text-ink-950 hover:bg-gold-400 disabled:opacity-40"
                >
                  Save
                </button>
                <span className="text-[11px] leading-relaxed text-parchment-faint">
                  Test asks the endpoint for its model list — Save is the dialog’s save, every
                  field.
                </span>
              </div>
              {probeError && <p className="text-[12px] text-danger-400">{probeError}</p>}
              {probe && (
                <p className={`text-[12px] leading-relaxed ${VERDICT_TONE[probe.verdict]}`}>
                  {probe.message}
                </p>
              )}
              <Note>
                What the reader’s ask panel sends: the title, author, section and your highlight —
                the book’s own text only when the model can’t place it, or when you ask for it. Read
                per question, so nothing here has to restart.
              </Note>
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

            {/* The phone API's row, last because it is the newest surface and the
                only one that puts a socket on the network — and because its
                switch applies on click, which reads better at the end of a
                dialog whose other controls wait for Save. */}
            <Section title="Phone access">
              <RestApiSection
                view={view}
                applying={applying}
                busy={busy}
                onSetEnabled={(next) => void setEnabled(next)}
                port={form.restApiPort}
                bind={form.restApiBind}
                onPort={set('restApiPort')}
                onBind={set('restApiBind')}
              />
            </Section>

            <p className="text-[11px] leading-relaxed text-parchment-faint">
              Leave a field blank to go back to auto-detection. Changing the interpreter or the
              metadata API key restarts the metadata sidecar; the Ask settings are read per question
              and restart nothing. The phone API’s switch applies the moment you click it, carrying
              a port or bind you have changed with it.
            </p>
          </div>
        )}

        <div className="shrink-0 border-t border-ink-800 px-5 py-3">
          {error && <p className="mb-2 text-[12px] text-danger-400">{error}</p>}
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

/**
 * A maintenance action: what it does, what it costs, and the button. The
 * description is the whole point of the row — these two actions used to be
 * unlabelled rows in the sidebar, where "Refresh" and "Rebuild" were
 * indistinguishable until one of them took twenty minutes, and where Refresh's
 * fallback into a rebuild (`library-sync.refreshLibrary`) was invisible.
 *
 * The run's own progress deliberately does *not* live here: a rebuild outlives
 * this dialog, so its counter and Cancel are in the status bar.
 */
function MaintenanceRow({
  title,
  description,
  caveat,
  action,
  busy,
  disabled,
  onRun
}: {
  title: string
  description: string
  caveat: string
  action: string
  busy: boolean
  disabled: boolean
  onRun(): void
}) {
  return (
    <div className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-parchment">{title}</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-parchment-dim">{description}</p>
        </div>
        <button
          disabled={disabled}
          onClick={onRun}
          className="mt-px flex shrink-0 items-center gap-1.5 rounded-md border border-ink-600 px-2.5 py-1 text-[12px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40 disabled:hover:bg-transparent"
        >
          {busy && <SpinnerIcon className="h-3.5 w-3.5" />}
          {action}
        </button>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-parchment-faint">{caveat}</p>
    </div>
  )
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
  type,
  list
}: {
  label: string
  value: string
  onChange(value: string): void
  placeholder?: string
  hint?: string
  mono?: boolean
  type?: 'text' | 'password'
  /** A `<datalist>` id, when the field has values the app has learned. */
  list?: string
}) {
  return (
    <label className="block min-w-0">
      <span className="text-[11px] font-semibold uppercase tracking-widest text-parchment-faint">
        {label}
      </span>
      <input
        value={value}
        type={type ?? 'text'}
        list={list}
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
