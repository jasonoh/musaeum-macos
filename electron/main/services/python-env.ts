import { spawn, spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import type { PythonEnvProgress } from '@shared/settings.types'
import { getConfig } from './db'
import { isPackaged } from './runtime'

/**
 * Where the sidecar's Python comes from, and how a packaged build gets one.
 *
 * In development the answer is the venv the README tells you to create. A
 * packaged `.app` has no such thing: `sidecar/.venv` is deliberately excluded
 * from the bundle (it is built against one machine's Python and hard-codes
 * absolute paths), and the bundle itself must stay read-only — writing inside
 * a signed `.app` breaks its signature. So the packaged app builds its own
 * venv **once**, in `userData`, from the `requirements.txt` it ships.
 *
 * This module owns interpreter identity for the whole main process:
 * `services/sidecar.ts` re-exports `resolvePython` as its public face and
 * `services/settings.ts` validates against the same version rules, so there is
 * one definition of "a Python this app can use".
 */

/** The oldest interpreter the sidecar's dependencies support. */
export const MIN_PYTHON: readonly [number, number] = [3, 11]

/** How long a `pip install` may run before it is treated as hung. */
const INSTALL_TIMEOUT_MS = 10 * 60_000

/** Tried on the PATH first — a terminal launch usually has a full one. */
const BARE_CANDIDATES = ['python3.12', 'python3.11', 'python3']

/**
 * Then by absolute path. launchd hands a double-clicked `.app` a minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), so a Homebrew interpreter that resolves
 * by name from a terminal is invisible to the same app opened from Finder.
 * That difference is exactly the kind that shows up only in a packaged build.
 */
const ABSOLUTE_CANDIDATES = [
  '/opt/homebrew/bin/python3.12',
  '/opt/homebrew/bin/python3.11',
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3.12',
  '/usr/local/bin/python3.11',
  '/usr/local/bin/python3',
  '/usr/bin/python3'
]

/** Where the sidecar's Python source lives — bundled into Resources when packaged. */
export function sidecarDir(): string {
  return isPackaged ? join(process.resourcesPath, 'sidecar') : join(app.getAppPath(), 'sidecar')
}

/** The venv the README tells a developer to create. Never present when packaged. */
function devVenvPython(): string {
  return join(sidecarDir(), '.venv', 'bin', 'python')
}

/** The venv this module creates and owns, outside the bundle so it stays writable. */
export function managedVenvDir(): string {
  return join(app.getPath('userData'), 'sidecar-venv')
}

function managedVenvPython(): string {
  return join(managedVenvDir(), 'bin', 'python')
}

/**
 * A self-contained interpreter shipped inside the bundle.
 *
 * Nothing produces this today — it is the slot for the option-B packaging
 * path (ship python-build-standalone with the wheels pre-installed). It is
 * checked *before* the managed venv so that adding one entry to
 * `extraResources` is the whole change: the bootstrap below then sees an
 * interpreter that already carries its dependencies and does nothing.
 */
function bundledPython(): string | null {
  if (!isPackaged) return null
  const p = join(process.resourcesPath, 'python', 'bin', 'python3')
  return existsSync(p) ? p : null
}

/** Where a resolved tool path came from — surfaced in Settings. */
export interface ToolResolution {
  path: string | null
  source: 'configured' | 'auto' | 'none'
}

/**
 * The interpreter the sidecar runs under, with its provenance so Settings
 * reports what is actually in force rather than re-deriving it.
 *
 * Order matters: an explicitly configured path always wins, then a bundled
 * runtime, then the dev venv, then the venv we manage, and only then a bare
 * system interpreter. That last one is a genuine fallback for someone who
 * installed the dependencies globally — but it is also what a packaged app
 * used to land on with nothing installed, producing a `ModuleNotFoundError`
 * crash-loop. `ensurePythonEnv` runs before the sidecar starts so the managed
 * venv exists by the time it is reached.
 */
export function resolvePython(): ToolResolution {
  const configured = getConfig('python_path')
  if (configured && existsSync(configured)) return { path: configured, source: 'configured' }

  const bundled = bundledPython()
  if (bundled) return { path: bundled, source: 'auto' }

  const dev = devVenvPython()
  if (existsSync(dev)) return { path: dev, source: 'auto' }

  const managed = managedVenvPython()
  if (existsSync(managed)) return { path: managed, source: 'auto' }

  const base = findBaseInterpreter()
  return base ? { path: base, source: 'auto' } : { path: null, source: 'none' }
}

/**
 * A system interpreter new enough to build the venv from. Unlike the old
 * candidate scan this checks the version, so a `python3` that is too old is
 * reported as "not found" instead of being handed to the sidecar.
 */
export function findBaseInterpreter(): string | null {
  for (const cmd of [...BARE_CANDIDATES, ...ABSOLUTE_CANDIDATES]) {
    if (cmd.startsWith('/') && !existsSync(cmd)) continue
    const version = readVersion(cmd)
    if (version && meetsMinimum(version)) return cmd
  }
  return null
}

export function readVersion(path: string): [number, number] | null {
  const res = spawnSync(path, ['--version'], { encoding: 'utf8' })
  if (res.status !== 0) return null
  return parseVersion(`${res.stdout}${res.stderr}`)
}

/** `Python 3.12.4` → [3, 12]. Old versions print to stderr, so both are searched. */
export function parseVersion(output: string): [number, number] | null {
  const match = /Python (\d+)\.(\d+)/.exec(output)
  return match ? [Number(match[1]), Number(match[2])] : null
}

export function meetsMinimum([major, minor]: [number, number]): boolean {
  return major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1])
}

function requirementsFile(): string {
  return join(sidecarDir(), 'requirements.txt')
}

/** Written only after a successful install — see `needsBootstrap`. */
function markerFile(): string {
  return join(managedVenvDir(), '.musaeum-requirements')
}

/**
 * sha256 of requirements.txt. The marker holds this, so editing the
 * requirements re-runs pip on the next launch and nothing else does — a
 * check that costs one file read instead of asking pip to resolve the world.
 */
function requirementsHash(): string | null {
  try {
    return createHash('sha256').update(readFileSync(requirementsFile())).digest('hex')
  } catch {
    return null
  }
}

/**
 * Whether the managed venv has to be built or updated.
 *
 * Deliberately false for every case where someone else owns the environment:
 * an interpreter chosen in Settings is the user's to maintain, a bundled
 * runtime ships its own packages, and a dev venv is the README's job. Building
 * a second environment alongside any of those would be surprising and slow.
 */
export function needsBootstrap(): boolean {
  if (getConfig('python_path')) return false
  if (bundledPython()) return false
  if (existsSync(devVenvPython())) return false

  const want = requirementsHash()
  if (!want) return false // nothing to install from
  if (!existsSync(managedVenvPython())) return true
  try {
    return readFileSync(markerFile(), 'utf8').trim() !== want
  } catch {
    return true
  }
}

export type PythonEnvResult = { ok: true; python: string } | { ok: false; reason: string }

let inFlight: Promise<PythonEnvResult> | null = null

/**
 * Make a usable interpreter exist, reporting progress as it goes. Returns
 * fast when nothing is needed, which is every launch after the first.
 *
 * Never throws: a failure here costs metadata hydration, not the app, and the
 * caller starts the sidecar either way (globally installed dependencies are a
 * legitimate setup this module cannot detect).
 */
export function ensurePythonEnv(
  onProgress: (progress: PythonEnvProgress) => void
): Promise<PythonEnvResult> {
  if (!inFlight) {
    inFlight = bootstrap(onProgress)
    // Cleared on settle so a later call (a retry from Settings) can run again
    void inFlight.finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

async function bootstrap(
  onProgress: (progress: PythonEnvProgress) => void
): Promise<PythonEnvResult> {
  if (!needsBootstrap()) {
    const { path } = resolvePython()
    return path ? { ok: true, python: path } : { ok: false, reason: noInterpreterMessage() }
  }

  const base = findBaseInterpreter()
  if (!base) {
    const reason = noInterpreterMessage()
    onProgress({ stage: 'failed', message: 'Python not found', detail: reason })
    return { ok: false, reason }
  }

  const venvDir = managedVenvDir()
  const python = managedVenvPython()

  try {
    if (!existsSync(python)) {
      // A directory without an interpreter is a first run that was interrupted
      // partway; rebuild it rather than installing into something half-made
      if (existsSync(venvDir)) rmSync(venvDir, { recursive: true, force: true })
      mkdirSync(dirname(venvDir), { recursive: true })
      onProgress({
        stage: 'creating',
        message: 'Preparing the metadata engine…',
        detail: `Creating a Python environment with ${base}`
      })
      await run(base, ['-m', 'venv', venvDir])
    }

    onProgress({
      stage: 'installing',
      message: 'Installing metadata dependencies…',
      detail: 'This happens once, and needs a network connection'
    })
    await run(python, [
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '--no-input',
      '-r',
      requirementsFile()
    ])

    // Last, so an interrupted install is retried rather than recorded as done
    writeFileSync(markerFile(), `${requirementsHash()}\n`)
    onProgress({ stage: 'ready', message: 'Metadata engine ready' })
    return { ok: true, python }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error('[python-env] bootstrap failed:', reason)
    onProgress({
      stage: 'failed',
      message: 'Could not prepare the metadata engine',
      detail: reason
    })
    return { ok: false, reason }
  }
}

function noInterpreterMessage(): string {
  const [major, minor] = MIN_PYTHON
  return (
    `No Python ${major}.${minor} or newer found. Install one ` +
    `(\`brew install python@3.12\`) and reopen Musaeum, or point Settings at an ` +
    `interpreter that already has the sidecar's packages.`
  )
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    // Keep only the tail: pip prints hundreds of lines and the failure is at
    // the end, but an unbounded buffer of it has no business in memory
    let tail = ''
    const keep = (chunk: Buffer): void => {
      tail = (tail + chunk.toString('utf8')).slice(-4000)
    }
    proc.stdout.on('data', keep)
    proc.stderr.on('data', keep)

    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`${basename(cmd)} ${args.join(' ')} timed out after ${INSTALL_TIMEOUT_MS}ms`))
    }, INSTALL_TIMEOUT_MS)

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`${cmd} could not run — ${err.message}`))
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve()
        return
      }
      const lastLine = tail.trimEnd().split('\n').pop()?.trim() ?? ''
      reject(new Error(`${basename(cmd)} ${args[1] ?? ''} failed (exit ${code}) — ${lastLine}`))
    })
  })
}
