import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import { existsSync } from 'fs'
import { getConfig } from './db'
import { resolvePython, sidecarDir, type ToolResolution } from './python-env'

// Interpreter resolution lives in ./python-env, which also owns the managed
// venv a packaged build creates on first launch. It is re-exported here
// because this is the module that actually spawns the thing — Settings asks
// `sidecar.resolvePython()` rather than re-deriving detection of its own.
export { resolvePython } from './python-env'
export type { ToolResolution } from './python-env'

/**
 * JSON-RPC over stdio bridge to the Python sidecar.
 * Requests are newline-delimited JSON; responses carry the request id.
 * Messages from Python without an id are notifications (e.g. migration progress).
 */

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

const DEFAULT_TIMEOUT_MS = 120_000

let proc: ChildProcessWithoutNullStreams | null = null
let nextId = 1
let restartCount = 0
const pending = new Map<string, PendingCall>()
const notificationHandlers = new Map<string, Set<(params: unknown) => void>>()

/** Subscribe to sidecar notifications for a method. Returns an unsubscribe fn. */
export function onNotification(method: string, handler: (params: unknown) => void): () => void {
  let handlers = notificationHandlers.get(method)
  if (!handlers) {
    handlers = new Set()
    notificationHandlers.set(method, handlers)
  }
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
  }
}

/**
 * The Google Books key handed to the sidecar. `app_config` wins over the
 * environment so a key set in Settings survives a double-clicked .app, while
 * `infisical run -- npm run dev` still works with nothing configured.
 */
export function resolveGoogleBooksKey(): { key: string | null; source: 'configured' | 'env' | 'none' } {
  const configured = getConfig('google_books_api_key')
  if (configured) return { key: configured, source: 'configured' }
  const fromEnv = process.env.GOOGLE_BOOKS_API_KEY
  if (fromEnv) return { key: fromEnv, source: 'env' }
  return { key: null, source: 'none' }
}

export function isAvailable(): boolean {
  return proc !== null
}

export function start(): boolean {
  if (proc) return true
  const { path: python } = resolvePython()
  if (!python) {
    console.error('[sidecar] no python interpreter found')
    return false
  }

  const { key } = resolveGoogleBooksKey()
  const p = spawn(python, ['main.py'], {
    cwd: sidecarDir(),
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      ...(key ? { GOOGLE_BOOKS_API_KEY: key } : {})
    }
  })
  proc = p

  let buffer = ''
  p.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line) handleMessage(line)
    }
  })
  p.stderr.on('data', (chunk: Buffer) => {
    console.error('[sidecar]', chunk.toString('utf8').trimEnd())
  })
  p.on('exit', (code) => {
    console.error(`[sidecar] exited with code ${code}`)
    // A process we already replaced (stop/restart) must not tear down its
    // successor — stop() clears `proc` and the pending map synchronously,
    // and this event arrives after the new process is running
    if (proc !== p) return
    proc = null
    failPending('Sidecar process exited')
    // Restart with a cap so a crash-looping sidecar doesn't spin forever
    if (restartCount < 3) {
      restartCount++
      setTimeout(() => start(), 1_000 * restartCount)
    }
  })

  return true
}

function failPending(message: string): void {
  for (const [id, call] of pending) {
    clearTimeout(call.timer)
    call.reject(new Error(message))
    pending.delete(id)
  }
}

export function stop(): void {
  restartCount = 99 // suppress auto-restart during shutdown
  const p = proc
  proc = null
  p?.kill()
  failPending('Sidecar process stopped')
}

/**
 * Relaunch under the current config — the interpreter and the Google Books key
 * are both read at spawn time, so a Settings change only takes effect here.
 */
export function restart(): boolean {
  stop()
  restartCount = 0
  return start()
}

function handleMessage(line: string): void {
  let msg: { id?: string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } | string | null }
  try {
    msg = JSON.parse(line)
  } catch {
    console.error('[sidecar] unparseable message:', line.slice(0, 200))
    return
  }

  if (!msg.id && msg.method) {
    const handlers = notificationHandlers.get(msg.method)
    if (handlers) {
      // Iterate a copy so handlers can unsubscribe safely mid-dispatch
      for (const handler of [...handlers]) handler(msg.params)
    }
    return
  }

  const call = msg.id ? pending.get(msg.id) : undefined
  if (!call) return
  pending.delete(msg.id!)
  clearTimeout(call.timer)
  if (msg.error) {
    const text = typeof msg.error === 'string' ? msg.error : (msg.error.message ?? 'Sidecar error')
    call.reject(new Error(text))
  } else {
    call.resolve(msg.result)
  }
}

export function call<T = unknown>(
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<T> {
  if (!proc && !start()) {
    return Promise.reject(
      new Error('Python sidecar is unavailable — install Python 3.11+ to enable metadata features')
    )
  }
  const id = `req-${nextId++}`
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Sidecar call ${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    proc!.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
}

const STANDARD_EBOOK_CONVERT = '/Applications/calibre.app/Contents/MacOS/ebook-convert'

/** Locate ebook-convert; configurable, defaults to the standard Calibre install path. */
export function resolveEbookConvert(): ToolResolution {
  const configured = getConfig('ebook_convert_path')
  if (configured && existsSync(configured)) return { path: configured, source: 'configured' }
  if (existsSync(STANDARD_EBOOK_CONVERT)) return { path: STANDARD_EBOOK_CONVERT, source: 'auto' }
  return { path: null, source: 'none' }
}

export function ebookConvertPath(): string | null {
  return resolveEbookConvert().path
}
