import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { AiStatus } from '@shared/ai.types'
import { buildAskMessages, describeEgress } from '@/lib/ask-context'
import { askStatusOf, citationFor, nextRequestId, verdictNotice } from '@/lib/ask-session'
import { useLibraryStore } from '@/stores/library.store'
import { useReaderStore } from '@/stores/reader.store'
import { useUIStore } from '@/stores/ui.store'
import { CloseIcon, InfoIcon, SendIcon, WarningIcon } from '@/components/shared/icons'

/**
 * The ask panel — the third occupant of the reader's side slot (D4).
 *
 * It is deliberately thin. What travels is decided by `src/lib/ask-context.ts`,
 * what a verdict does is decided by `src/lib/ask-session.ts`, and how it travels
 * is decided in the main process (`services/ai.ts`). This file lays out the
 * transcript, holds the one piece of state that is genuinely local — what the
 * reader has typed — and asks the two questions the panel exists to ask: *does
 * the model have this book* (the probe, once per book per session), and *the
 * reader's question*.
 *
 * The renderer has no socket and no key: `index.html`'s CSP is untouched (D2),
 * and the panel only ever sees the masked endpoint and model strings.
 */

/** The endpoint read, on its own so a failed read is not an empty panel. */
type EndpointRead =
  { kind: 'loading' } | { kind: 'failed'; reason: string } | { kind: 'ready'; status: AiStatus }

/** How much of a highlight the composer shows. The payload has its own cap. */
const SELECTION_PREVIEW_CHARS = 160

/**
 * The composer's disclosure has to describe a payload *before* a question
 * exists, and `buildAskMessages` refuses an empty ask on purpose (that refusal
 * is a caller bug, not a failure mode). The placeholder stands in for the
 * question, not for a member: the member list is derived from the payload's own
 * fields, and an ask always carries its question — so the previewed members are
 * exactly the ones the real send will have.
 */
const QUESTION_PLACEHOLDER = 'the question you type'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`
}

export function ReaderAsk({ onNavigate }: { onNavigate: (href: string) => void }) {
  const bookId = useReaderStore((s) => s.bookId)
  const book = useLibraryStore((s) => s.books.find((b) => b.id === bookId) ?? null)
  const toc = useReaderStore((s) => s.toc)
  const percent = useReaderStore((s) => s.percent)
  const sectionLabel = useReaderStore((s) => s.sectionLabel)
  const section = useReaderStore((s) => s.section)
  const sectionOffset = useReaderStore((s) => s.sectionOffset)
  const selection = useReaderStore((s) => s.selection)
  const verdict = useReaderStore((s) => s.askVerdict)
  const rung = useReaderStore((s) => s.askRung)
  const session = useReaderStore((s) => s.askSession)
  const probe = useReaderStore((s) => s.askProbe)
  const setOverride = useReaderStore((s) => s.setOverride)
  const closeAsk = useReaderStore((s) => s.closeAsk)
  const beginProbe = useReaderStore((s) => s.beginProbe)
  const beginAsk = useReaderStore((s) => s.beginAsk)
  const aiError = useReaderStore((s) => s.aiError)
  const openModal = useUIStore((s) => s.openModal)

  const [endpoint, setEndpoint] = useState<EndpointRead>({ kind: 'loading' })
  const [question, setQuestion] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  /** Every request this panel started, so the panel leaving ends all of them. */
  const inFlight = useRef<Set<string>>(new Set())

  // Read once per open rather than once per app: the endpoint and the model are
  // editable in Settings while the reader is open, and the disclosure line has
  // to name what this session will actually reach.
  useEffect(() => {
    let live = true
    void window.Musaeum.ai.getStatus().then(
      (status) => live && setEndpoint({ kind: 'ready', status }),
      (err: unknown) => live && setEndpoint({ kind: 'failed', reason: errorText(err) })
    )
    return () => {
      live = false
    }
  }, [])

  /**
   * A question is cancelled when the panel closes, and when the next one
   * starts — a second question while the first is still streaming is the reader
   * changing their mind, not a queue. `cancel` returns false for a request that
   * has already finished, so this needs no bookkeeping beyond the ids.
   */
  const cancelInFlight = useCallback(() => {
    for (const id of inFlight.current) void window.Musaeum.ai.cancel(id).catch(() => {})
    inFlight.current.clear()
  }, [])

  useEffect(() => cancelInFlight, [cancelInFlight])

  const ready = endpoint.kind === 'ready' && endpoint.status.configured

  /**
   * One probe per (book, session), issued the first time the panel is open on
   * this book **and** the section's text is in hand — the verdict is scored
   * against that text, so probing before it loads would spend a request on a
   * claim nothing could check. `beginProbe` writes the probe synchronously,
   * which is what makes StrictMode's second effect run a no-op.
   */
  useEffect(() => {
    if (!book || !ready || !section || verdict !== null || probe !== null) return
    const requestId = nextRequestId()
    const { messages } = buildAskMessages({
      mode: 'probe',
      title: book.title,
      author: book.author,
      sectionLabel,
      fraction: percent
    })
    inFlight.current.add(requestId)
    beginProbe(requestId)
    void window.Musaeum.ai
      .ask({ requestId, mode: 'probe', messages })
      .catch((err: unknown) => aiError({ requestId, message: errorText(err) }))
  }, [book, ready, section, verdict, probe, sectionLabel, percent, beginProbe, aiError])

  const send = useCallback(() => {
    const text = question.trim()
    if (!book || !ready || !text) return
    cancelInFlight()
    const requestId = nextRequestId()
    const { messages } = buildAskMessages({
      mode: 'ask',
      rung,
      title: book.title,
      author: book.author,
      sectionLabel,
      fraction: percent,
      question: text,
      sectionText: section?.text ?? null,
      sectionOffset,
      selection
    })
    inFlight.current.add(requestId)
    beginAsk(requestId, text)
    setQuestion('')
    void window.Musaeum.ai
      .ask({ requestId, mode: 'ask', messages })
      .catch((err: unknown) => aiError({ requestId, message: errorText(err) }))
  }, [
    question,
    book,
    ready,
    cancelInFlight,
    rung,
    sectionLabel,
    percent,
    section,
    sectionOffset,
    selection,
    beginAsk,
    aiError
  ])

  /**
   * What the *question* will send, from the assembler's own payload — so the
   * line cannot claim less than it sends, and cannot drift as members are added.
   */
  const egress = useMemo(() => {
    if (!book || endpoint.kind !== 'ready' || !endpoint.status.configured) return null
    const { payload } = buildAskMessages({
      mode: 'ask',
      rung,
      title: book.title,
      author: book.author,
      sectionLabel,
      fraction: percent,
      question: question.trim() || QUESTION_PLACEHOLDER,
      sectionText: section?.text ?? null,
      sectionOffset,
      selection
    })
    return describeEgress({
      endpoint: endpoint.status.endpoint.value,
      model: endpoint.status.model.value,
      payload
    })
  }, [book, endpoint, rung, sectionLabel, percent, question, section, sectionOffset, selection])

  /**
   * The probe is a send too, so it gets a line of its own while it is out. The
   * disclosure rule is that nothing leaves quietly (D5) — and the probe is the
   * one request the reader did not press anything for.
   */
  const probeEgress = useMemo(() => {
    if (!book || !probe || endpoint.kind !== 'ready') return null
    const { payload } = buildAskMessages({
      mode: 'probe',
      title: book.title,
      author: book.author,
      sectionLabel,
      fraction: percent
    })
    return describeEgress({
      endpoint: endpoint.status.endpoint.value,
      model: endpoint.status.model.value,
      payload
    })
  }, [book, probe, endpoint, sectionLabel, percent])

  const lastTurn = session.turns[session.turns.length - 1]
  const answer = lastTurn?.role === 'assistant' && !lastTurn.streaming ? lastTurn.text : null
  const citation = useMemo(() => (answer ? citationFor(answer, toc) : null), [answer, toc])

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [session])

  useEffect(() => {
    composer.current?.focus()
  }, [])

  /**
   * The panel owns the keys while focus is inside it. Escape closes the panel
   * rather than the book — a panel the reader owns is not something Escape
   * should take the book away from, the same shape the typography popover
   * already uses — and every other unmodified key stops here, so Space on one
   * of the panel's own buttons is a press and not also a page turn underneath.
   */
  const onPanelKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeAsk()
      return
    }
    if (!e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation()
  }

  const passageReady = Boolean(section?.text)
  const passageLocked = verdict === 'weak'
  const notice = verdictNotice(verdict, passageReady)
  const status = askStatusOf(session, probe !== null)
  const canSend = ready && question.trim().length > 0
  const streaming = session.turns.some((turn) => turn.streaming)

  return (
    <aside
      onKeyDown={onPanelKeyDown}
      className="flex w-72 shrink-0 flex-col border-r border-ink-800 bg-ink-950"
    >
      <div className="flex shrink-0 items-center justify-between px-5 pb-2 pt-4">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-parchment-faint">
          Ask
        </span>
        <div className="flex items-center gap-1">
          {streaming && <span className="text-[10px] italic text-parchment-faint">answering…</span>}
          {status === 'probing' && !streaming && (
            <span className="text-[10px] italic text-parchment-faint">checking…</span>
          )}
          <button
            onClick={closeAsk}
            title="Close (Esc)"
            aria-label="Close the ask panel"
            className="rounded p-1 text-parchment-faint hover:bg-ink-800 hover:text-parchment"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {notice && (
        <p className="mx-4 mb-2 flex shrink-0 items-start gap-1.5 rounded-md border border-ink-700 px-2.5 py-1.5 text-[11px] leading-snug text-parchment-dim">
          {verdict === 'weak' ? (
            <WarningIcon className="mt-px h-3.5 w-3.5 shrink-0 text-gold-400" />
          ) : (
            <InfoIcon className="mt-px h-3.5 w-3.5 shrink-0 text-parchment-faint" />
          )}
          <span>{notice}</span>
        </p>
      )}

      {probeEgress && (
        <p className="mx-4 mb-2 shrink-0 text-[10px] leading-tight text-parchment-faint">
          Checking whether the model knows this book. {probeEgress}
        </p>
      )}

      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4">
        {session.turns.length === 0 ? (
          <p className="pt-1 text-[12px] leading-relaxed text-parchment-faint">
            Ask anything about the book you are reading. Where you are — the section and how far
            through — tells the model what you are looking at.
          </p>
        ) : (
          session.turns.map((turn, i) => (
            <div key={i}>
              {turn.role === 'user' ? (
                <p className="text-[12px] font-medium leading-snug text-gold-300">{turn.text}</p>
              ) : (
                <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-parchment-dim">
                  {turn.text}
                  {turn.streaming && (
                    <span className="ml-0.5 inline-block h-3 w-[2px] translate-y-px animate-pulse bg-gold-300 align-baseline" />
                  )}
                </p>
              )}
            </div>
          ))
        )}
        {session.notice && (
          <p className="rounded-md border border-ink-700 px-2.5 py-1.5 text-[11px] leading-snug text-parchment-dim">
            {session.notice}
          </p>
        )}
      </div>

      {/* The answer's one verifiable claim about *where*: a label the book's own
          TOC carries, which resolves through the path the TOC panel uses. */}
      {citation && (
        <div className="shrink-0 border-t border-ink-800 px-4 py-2">
          <button
            onClick={() => onNavigate(citation.href)}
            className="w-full truncate rounded-md border border-ink-600 px-2.5 py-1.5 text-left text-[11px] text-parchment-dim transition-colors hover:border-gold-500/50 hover:text-gold-300"
          >
            Go to “{citation.label}”
          </button>
        </div>
      )}

      <div className="shrink-0 space-y-2 border-t border-ink-800 p-3">
        {endpoint.kind === 'loading' ? (
          <p className="text-[11px] italic text-parchment-faint">Looking for the endpoint…</p>
        ) : endpoint.kind === 'failed' ? (
          <Unavailable reason={endpoint.reason} onOpenSettings={() => openModal('settings')} />
        ) : !endpoint.status.configured ? (
          <Unavailable
            reason={endpoint.status.reason ?? 'The ask panel is unavailable.'}
            onOpenSettings={() => openModal('settings')}
          />
        ) : (
          <>
            {selection && (
              <p className="rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-[11px] italic leading-snug text-parchment-faint">
                About “{truncate(selection, SELECTION_PREVIEW_CHARS)}”
              </p>
            )}
            <textarea
              ref={composer}
              value={question}
              rows={3}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder="Ask about this part of the book…"
              className="w-full resize-none rounded-md border border-ink-700 bg-ink-900 px-2.5 py-2 text-[13px] leading-snug text-parchment placeholder:text-parchment-faint focus:border-gold-500/50 focus:outline-none"
            />
            <label
              title={
                passageLocked
                  ? 'The model could not place this book, so the passage goes with this session’s questions.'
                  : passageReady
                    ? undefined
                    : 'This section’s text has not loaded yet.'
              }
              className={`flex items-start gap-2 text-[11px] leading-snug ${
                passageReady ? 'text-parchment-dim' : 'text-parchment-faint'
              }`}
            >
              <input
                type="checkbox"
                checked={rung === 'passage'}
                disabled={passageLocked || !passageReady}
                onChange={(e) => setOverride(e.target.checked)}
                className="mt-px accent-gold-500"
              />
              <span>Send this section’s text too</span>
            </label>
            <button
              onClick={send}
              disabled={!canSend}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-gold-500/40 bg-gold-500/10 px-3 py-1.5 text-[12px] text-gold-300 transition-colors hover:bg-gold-500/20 disabled:cursor-not-allowed disabled:border-ink-700 disabled:bg-transparent disabled:text-parchment-faint"
            >
              <SendIcon className="h-3.5 w-3.5" />
              Ask
            </button>
            {egress && (
              <p className="text-[10px] leading-tight text-parchment-faint">
                {egress}
                <span className="block pt-0.5">
                  {endpoint.status.isLocal
                    ? 'local — nothing leaves this machine'
                    : `remote — ${hostOf(endpoint.status.endpoint.value ?? '')} receives this`}
                  {endpoint.status.hasKey && ' · with the stored key'}
                </span>
              </p>
            )}
          </>
        )}
      </div>
    </aside>
  )
}

/** Why the panel cannot ask, and the shortest route to fixing it. */
function Unavailable({ reason, onOpenSettings }: { reason: string; onOpenSettings: () => void }) {
  return (
    <div className="space-y-2">
      <p className="flex items-start gap-1.5 text-[11px] leading-snug text-parchment-dim">
        <WarningIcon className="mt-px h-3.5 w-3.5 shrink-0 text-gold-400" />
        <span>{reason}</span>
      </p>
      <button
        onClick={onOpenSettings}
        className="w-full rounded-md border border-ink-600 px-2.5 py-1.5 text-[11px] text-parchment-dim transition-colors hover:border-gold-500/50 hover:text-gold-300"
      >
        Open Settings
      </button>
    </div>
  )
}
