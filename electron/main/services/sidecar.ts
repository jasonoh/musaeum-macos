import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'child_process'
import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { getConfig } from './db'

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
const PYTHON_CANDIDATES = ['python3.12', 'python3.11', 'python3']

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

function sidecarDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'sidecar')
    : join(app.getAppPath(), 'sidecar')
}

function resolvePython(): string | null {
  const configured = getConfig('python_path')
  if (configured && existsSync(configured)) return configured
  // Prefer the sidecar's own venv (created by `python3 -m venv sidecar/.venv`)
  const venvPython = join(sidecarDir(), '.venv', 'bin', 'python')
  if (existsSync(venvPython)) return venvPython
  for (const cmd of PYTHON_CANDIDATES) {
    const res = spawnSync(cmd, ['--version'], { encoding: 'utf8' })
    if (res.status === 0) return cmd
  }
  return null
}

export function isAvailable(): boolean {
  return proc !== null
}

export function start(): boolean {
  if (proc) return true
  const python = resolvePython()
  if (!python) {
    console.error('[sidecar] no python interpreter found')
    return false
  }

  const p = spawn(python, ['main.py'], {
    cwd: sidecarDir(),
    env: { ...process.env, PYTHONUNBUFFERED: '1' }
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
    proc = null
    for (const [id, call] of pending) {
      clearTimeout(call.timer)
      call.reject(new Error('Sidecar process exited'))
      pending.delete(id)
    }
    // Restart with a cap so a crash-looping sidecar doesn't spin forever
    if (restartCount < 3) {
      restartCount++
      setTimeout(() => start(), 1_000 * restartCount)
    }
  })

  return true
}

export function stop(): void {
  restartCount = 99 // suppress auto-restart during shutdown
  proc?.kill()
  proc = null
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

/** Locate ebook-convert; configurable, defaults to the standard Calibre install path. */
export function ebookConvertPath(): string | null {
  const configured = getConfig('ebook_convert_path')
  if (configured && existsSync(configured)) return configured
  const standard = '/Applications/calibre.app/Contents/MacOS/ebook-convert'
  return existsSync(standard) ? standard : null
}
