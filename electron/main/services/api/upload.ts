import { randomUUID } from 'crypto'
import { promises as fs, createWriteStream } from 'fs'
import type { IncomingMessage } from 'http'
import { join } from 'path'
import type { Writable } from 'stream'
import { app } from 'electron'
import type { BookFormat, ImportResult } from '@shared/book.types'
import { BOOK_FILE_EXTENSIONS } from '@shared/book.types'
import * as importer from '../importer'
import * as nas from '../nas-manager'

/**
 * The upload's own half (design D1–D4): what a phone's book body is validated
 * as, where it lands, and the two bounds it is read under.
 *
 * **This module has no socket.** It takes a request stream and a directory and
 * answers with a *decision* — `bad-request`, `too-large`, `stalled`, `offline`,
 * `internal`, or the import's own result. Mapping that decision to a status
 * line is the route's job (slice 2), deliberately: the bytes, the bounds and the
 * scratch lifecycle are decidable without a port, and the status table belongs
 * where `API_ERRORS` lives.
 *
 * **It calls the importer the Mac already uses, and re-implements nothing.**
 * There is no second copy path, no second duplicate policy and no new metadata
 * shape (design *What follows*): `importer.addFiles` is the one entry point the
 * watcher and the picker share, and it is called exactly as they call it plus an
 * explicit duplicate policy.
 */

/**
 * The largest body this route will write (design D4).
 *
 * A figure with a census behind it rather than a round number: the largest EPUB
 * on this library's share measured **554,110,279 bytes (528 MiB)** on 2026-09-22,
 * and the census counted EPUBs — so this is roughly twice the worst case that
 * was measured, and a PDF book may still exceed it. Past the cap the answer is a
 * clear refusal rather than a truncated import, which is why the bound exists at
 * all: half a book written to the share is a row claiming a size and a format
 * for bytes that are not there.
 */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024

/**
 * How long the body may stop arriving before it is refused (design D4).
 *
 * **A stall clock, not a total one.** The timer is reset by every chunk, so it
 * bounds "a client that declared more than it sent, or a link that died" — and
 * it does not bound a legitimate slow upload, which a total-duration clock
 * cannot distinguish from a dead one (528 MiB over a tailnet is minutes).
 *
 * **30 s is a measurement, not a judgement.** Measured 2026-09-23 (harness:
 * `~/.hermes/profiles/dev/cache/scratch/upload-probe/`), a 320 MiB body streamed
 * to a listener on this Mac's tailnet address never left a gap longer than
 * **99.7 ms** between chunks (p99 0.43 ms, 44,706 chunks). TCP delivers at
 * MTU-sized pieces for as long as the link lives, so a live client at
 * *one-fiftieth* of the slowest rate measured still produces gaps seconds apart.
 * 30 s is a ~300× margin over the worst gap observed and 3× the read surface's
 * own total-body bound (`BODY_TIMEOUT_MS`), which is the same failure class
 * bounded harder here because this clock is reset rather than absolute.
 *
 * Reversal: a real upload from the phone on a cold radio whose gaps approach
 * seconds. See the spec's *Risks* #1.
 */
export const UPLOAD_STALL_MS = 30_000

/** The formats `format=` accepts, derived from the one extension declaration. */
export function isUploadFormat(value: string): value is BookFormat {
  return Object.prototype.hasOwnProperty.call(BOOK_FILE_EXTENSIONS, value)
}

/**
 * A filename longer than this many *bytes* is refused (see `safeFileName`).
 * `NAME_MAX` is 255 on APFS and on the share's own filesystem, so a name past it
 * could only fail inside the write — as a 500 the phone cannot act on.
 */
const MAX_NAME_BYTES = 255

export interface UploadParams {
  format: BookFormat
  /** The client's own filename, sanitised — see `safeFileName`. */
  filename: string
}

/**
 * Where an upload's bytes land (design D2): the app's own `userData`, never
 * `{library_root}/imports/` and never the library tree.
 *
 * `imports/` is watched by `services/file-watcher.ts`, which imports **and
 * deletes** whatever appears there — a router writing into it would race its own
 * watcher (the same file imported twice, or a partial file taken mid-write).
 * One writer per landing zone is the rule, and both end at `importer.addFiles`.
 * The library tree is refused for a second reason: a partially-written file
 * inside `books/` is a row that claims a size and a format for bytes that are
 * not there.
 *
 * The cost of the choice is stated in the spec: a 528 MiB upload needs that much
 * free here for the length of the import, and it puts the phone's bytes across
 * the network once rather than twice.
 */
export function uploadScratchDir(): string {
  return join(app.getPath('userData'), 'uploads')
}

/**
 * The name the book arrives under, with everything that could escape the
 * scratch directory removed.
 *
 * The filename is a **query parameter**, so it is untrusted input that becomes a
 * path component: only the last segment survives (`path.basename` is not enough
 * on its own — it does not strip a backslash on this platform), control
 * characters and leading dots go, and the result must be a name rather than the
 * empty string, a bare dot, or a bare extension.
 *
 * **The declared format's extension is forced.** The importer keys every lookup
 * on the extension (invariant 2), so a body arriving as `book.mobi` with
 * `format=epub` would be a file the pipeline cannot see; a suffix that *is* one
 * of the four book extensions is replaced by the declared one, so a client that
 * mislabelled its own format still lands under a name the library can read. A
 * suffix the library does not know (`book.txt`) is left alone — it is part of
 * the name the client sent, and guessing that it meant an extension is how a
 * title loses a word.
 *
 * **The stem is kept, not replaced by the uuid.** `titleFromFilename`
 * (`services/importer.ts`) derives the book's title from the basename, so a
 * nameless upload would produce a book named after a temp file — the outcome
 * D1's required `filename` exists to prevent. Uniqueness lives in the directory
 * instead (see `receiveUpload`).
 *
 * `null` means "a 400 the phone can fix", exactly as a missing one does.
 */
export function safeFileName(raw: string, format: BookFormat): string | null {
  const leaf = raw.split(/[\\/]/).pop() ?? ''
  const cleaned = leaf
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  if (!cleaned) return null

  // Leading dots carry nothing: `.epub` and `..Dune.epub` both name `Dune.epub`.
  const stem = cleaned.replace(/^\.+/, '').trim()
  if (!stem) return null

  // A name that *is* an extension names nothing, in either spelling: `epub`,
  // `.epub` and `...epub` would each end up `epub.epub` — a book titled "epub".
  // The test is on the dotless stem, because that is what the rule below would
  // append the format's extension to.
  const extensions = Object.values(BOOK_FILE_EXTENSIONS)
  const lowered = stem.toLowerCase()
  if (extensions.includes(lowered) || extensions.some((ext) => ext.slice(1) === lowered)) {
    return null
  }

  const known = extensions.find((ext) => lowered.endsWith(ext))
  const withoutExt = (known ? stem.slice(0, -known.length) : stem).trim()
  const final = `${withoutExt}${BOOK_FILE_EXTENSIONS[format]}`
  // A stem that vanished with its extension is not a name either, and a name the
  // filesystem cannot hold is refused here rather than surfacing as an
  // ENAMETOOLONG from the write.
  if (!withoutExt || Buffer.byteLength(final, 'utf8') > MAX_NAME_BYTES) return null
  return final
}

/**
 * The request's query, validated (design D1). `format` is required and one of
 * four; `filename` is required and must survive `safeFileName`. `null` is the
 * single 400: a client that asked for neither cannot be told which of its
 * mistakes to fix in a way it can act on differently, and D1 refuses both rather
 * than defaulting either (a defaulted format would import a mistyped body under
 * the wrong extension, and a defaulted filename would title the book after a
 * temp file).
 */
export function parseUploadQuery(params: URLSearchParams): UploadParams | null {
  const format = params.get('format')
  const filename = params.get('filename')
  if (!format || !filename || !isUploadFormat(format)) return null
  const safe = safeFileName(filename, format)
  return safe ? { format, filename: safe } : null
}

/** Why an upload did not become a book. Each maps to one status in slice 2. */
export type UploadRefusal = 'bad-request' | 'too-large' | 'stalled' | 'offline' | 'internal'

/**
 * The answer. `bytes` is what arrived, and it is answered only for bytes that
 * really reached the file — see `writeBody`'s flush rule.
 *
 * The scratch path is deliberately **not** part of this value: it is removed on
 * the way out (AC7), so a caller that held it would be holding a path that is
 * already gone.
 */
export type UploadOutcome =
  | { ok: true; bytes: number; result: ImportResult }
  | { ok: false; reason: UploadRefusal; message?: string }

/** What a case may change; the route passes none of them. */
export interface UploadOptions {
  scratchDir?: string
  maxBytes?: number
  stallMs?: number
  /**
   * How the scratch file is opened; default `fs.createWriteStream`. The seam
   * exists for the same reason the server's own `transfer` seam does (`rest.ts`
   * → `ServerOptions`) — so a case can decide a *write failure* without a full
   * disk, which is the one path that must never answer `ok`.
   */
  writeStream?: (path: string) => Writable
}

/**
 * One upload: validate, write the body under its bounds, hand the file to the
 * importer, and remove the scratch directory on **every** exit path.
 *
 * The ordering is the design's, and each step depends on the one before it:
 *
 * 1. **Validation before a byte is written** (D1) — a wrong `format` is the
 *    client's error and costs it nothing to fix.
 * 2. **The share is checked before the body is accepted** (S4 of the slice
 *    annex). Refusing "offline" after taking 528 MiB would put the phone's bytes
 *    across the link twice for no benefit, which is the cost D2 exists to avoid.
 * 3. **The body streams to disk** (D4, AC4) — never buffered whole, bounded by
 *    the cap and the stall clock.
 * 4. **The import runs with the policy that answers the duplicate gate** (D3):
 *    `'add-new'`, because a phone mid-upload has nobody to ask, and the match
 *    comes back on the result so the caller can put it on the wire (D6).
 *
 * Uniqueness comes from a uuid **directory** per upload, so two phones sending
 * `book.epub` at the same moment cannot collide while each file still keeps the
 * name its client gave it (the name is what titles the book).
 *
 * Every failure is an answer rather than a throw (invariant 12), and the
 * scratch directory is removed in a `finally` — including the paths where the
 * importer failed, which is where a leaked 528 MiB would be worst.
 */
export async function receiveUpload(
  req: IncomingMessage,
  query: URLSearchParams,
  options: UploadOptions = {}
): Promise<UploadOutcome> {
  const params = parseUploadQuery(query)
  if (!params) return { ok: false, reason: 'bad-request' }
  if (!nas.isOnline()) return { ok: false, reason: 'offline' }

  const dir = join(options.scratchDir ?? uploadScratchDir(), randomUUID())
  const filePath = join(dir, params.filename)

  try {
    await fs.mkdir(dir, { recursive: true })
    const body = await writeBody(req, filePath, {
      maxBytes: options.maxBytes ?? MAX_UPLOAD_BYTES,
      stallMs: options.stallMs ?? UPLOAD_STALL_MS,
      open: options.writeStream ?? createWriteStream
    })
    if (!body.ok) return { ok: false, reason: body.reason, message: body.message }

    const [result] = await importer.addFiles([filePath], { duplicate: 'add-new' })
    if (!result?.success) {
      // A share that went away between the pre-body check and the copy is the one
      // failure whose *reason* this module can still name, so it names it rather
      // than flattening it into the importer's prose — the same 503 the byte
      // routes answer, reached without string-matching an error message.
      if (!nas.isOnline()) return { ok: false, reason: 'offline' }
      return { ok: false, reason: 'internal', message: result?.error ?? 'import failed' }
    }
    return { ok: true, bytes: body.bytes, result }
  } catch (err) {
    // Disk full, a permission problem in `userData`, a uuid directory that could
    // not be made — the client gets a refusal it can report, never an unhandled
    // rejection (invariant 12).
    return {
      ok: false,
      reason: 'internal',
      message: err instanceof Error ? err.message : String(err)
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

interface BodyBound {
  maxBytes: number
  stallMs: number
  open: (path: string) => Writable
}

type BodyResult =
  | { ok: true; bytes: number }
  | { ok: false; reason: 'bad-request' | 'too-large' | 'stalled' | 'internal'; message?: string }

/**
 * The body, streamed to `filePath`. At most one chunk is held at a time, and a
 * target that falls behind slows the *client* rather than growing this process's
 * buffer — which is what makes a 528 MiB book a 528 MiB *file* rather than a
 * 528 MiB heap (AC4).
 *
 * Four endings, and they are not symmetric:
 *
 * - **Complete**: the request ends, and the answer waits for the write stream to
 *   finish *and* for its own report: **`end`'s callback is invoked with the
 *   stream's error, and invoked before the `'error'` event** (node), so a
 *   success folded into that callback without reading its argument would resolve
 *   `ok` for bytes that never reached the file. That is the one answer that can
 *   hand the importer a short file — the failure D2 and D4 exist to prevent —
 *   and it is why the flush is the decider here rather than the request's `end`.
 * - **Past the cap**: the write stops, the refusal resolves **at the breach**
 *   rather than at `end`, and a drop-only `data` listener stays attached so the
 *   client's remaining bytes keep flowing — no memory, no disk, and the best
 *   available chance for the caller's 413 to arrive instead of a reset. Draining
 *   fully, as `readJsonBody` does past its 4 KB cap, is not available here: that
 *   body is bounded, this one is not, so "drain to be polite" would mean
 *   discarding an unbounded stream.
 * - **Stalled**: no chunk for `stallMs`, answered by the timer that every chunk
 *   refreshes. The listeners are detached and the socket is deliberately **not**
 *   destroyed, matching `readJsonBody`'s timeout — the caller answers in the
 *   vocabulary the reading route already uses for a body that never finished
 *   arriving. An abrupt disconnect is bounded by this same clock: it emits no
 *   `end`, so the timer is what recovers the handler. A silence the *handler*
 *   asked for — the request paused for backpressure, so no chunk can arrive — is
 *   answered as this module's own failure instead, because a lagging local target
 *   is a third case the client's stalls do not explain.
 * - **Failed**: a write (or the flush) failed. Refused, never `ok`, so a partial
 *   file is never handed on.
 */
function writeBody(req: IncomingMessage, filePath: string, bound: BodyBound): Promise<BodyResult> {
  return new Promise((resolve) => {
    const out = bound.open(filePath)
    let arrived = 0
    let settled = false
    let tooLarge = false

    /** One answer per request, whichever of the endings arrives first. */
    const finish = (result: BodyResult, mode: 'detach' | 'drain'): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.removeListener('error', onRequestError)
      // A listener stays attached for the request's *later* errors: node's own
      // server keeps one for the real thing (`api/rest.ts`), and a stream with
      // none throws synchronously on a post-settle `'error'` — the shape this
      // module's own cases hand it.
      req.on('error', () => undefined)
      if (mode === 'detach') {
        req.removeListener('data', onData)
        req.removeListener('end', onEnd)
      } else {
        // A paused body must be let go on the cap path, or the bytes this
        // module deliberately drops would stop arriving altogether.
        req.resume()
      }
      resolve(result)
    }

    const timer = setTimeout(() => {
      out.destroy()
      // A silence the handler *asked for* is not the client's failure: while the
      // request is paused for backpressure no chunk can arrive, so what stopped
      // making progress is the local target. The clock still bounds the request
      // (a hang would be the worse failure), but the reason is this module's.
      finish(
        req.isPaused()
          ? { ok: false, reason: 'internal', message: 'the target stopped draining' }
          : { ok: false, reason: 'stalled' },
        'detach'
      )
    }, bound.stallMs)

    const onData = (chunk: Buffer): void => {
      // Past the cap the chunks are dropped rather than written, and the timer
      // is not refreshed — this body is already refused.
      if (tooLarge) return
      arrived += chunk.length
      if (arrived > bound.maxBytes) {
        tooLarge = true
        out.destroy()
        finish({ ok: false, reason: 'too-large' }, 'drain')
        return
      }
      timer.refresh()
      // Backpressure: a lagging target volume slows the client rather than
      // letting this process's buffer grow with the body.
      if (!out.write(chunk)) req.pause()
    }

    const onEnd = (): void => {
      if (tooLarge) return
      if (!arrived) {
        // A 0-byte body is not a book — and it is the *client's* mistake, so it
        // is refused in the vocabulary the route answers 400 with rather than as
        // the 500 an internal failure would carry (the rule `api/rest.ts` states
        // for the reading route: never a 500 for the client's own error).
        out.destroy()
        finish({ ok: false, reason: 'bad-request', message: 'empty body' }, 'detach')
        return
      }
      out.end((err?: Error | null) => {
        // Reading this argument is the whole guard: see the docblock above. The
        // message is the filesystem's own, for the log — a caller must not put it
        // on the wire verbatim, since it carries this machine's paths.
        const message = err?.message
        if (message) {
          finish({ ok: false, reason: 'internal', message }, 'detach')
          return
        }
        finish({ ok: true, bytes: arrived }, 'detach')
      })
    }

    const fail = (message: string): void => {
      out.destroy()
      finish({ ok: false, reason: 'internal', message }, 'detach')
    }

    const onRequestError = (err: Error): void => fail(err.message)
    const onStreamError = (err: Error): void => fail(err.message)

    out.on('error', onStreamError)
    out.on('drain', () => req.resume())

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onRequestError)
  })
}
