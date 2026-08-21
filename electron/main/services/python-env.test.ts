import { createHash } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * This file replaces the shared electron mock with one whose `getAppPath` and
 * `userData` point at a scratch tree, so the branches that depend on which
 * environments exist are all reachable. The default mock answers `process.cwd()`
 * — the real repo, which always has `sidecar/.venv` — under which
 * `needsBootstrap` can only ever return false.
 */
const paths = vi.hoisted(() => {
  const base = `${(process.env.TMPDIR || '/tmp').replace(/\/$/, '')}/musaeum-pyenv-${process.pid}`
  return { base, appRoot: `${base}/app`, userData: `${base}/data` }
})

vi.mock('electron', () => ({
  app: {
    getAppPath: (): string => paths.appRoot,
    getPath: (name: string): string => (name === 'userData' ? paths.userData : tmpdir()),
    setPath: (): void => undefined,
    whenReady: (): Promise<void> => Promise.resolve(),
    on: (): void => undefined,
    isPackaged: false
  },
  ipcMain: { handle: (): void => undefined },
  dialog: {},
  shell: {},
  net: {},
  protocol: {
    registerSchemesAsPrivileged: (): void => undefined,
    handle: (): void => undefined
  },
  BrowserWindow: class {}
}))

const { closeDb, setConfig } = await import('./db')
const {
  ensurePythonEnv,
  getPythonEnvState,
  findBaseInterpreter,
  managedVenvDir,
  meetsMinimum,
  needsBootstrap,
  parseVersion,
  resolvePython,
  sidecarDir
} = await import('./python-env')

const REQUIREMENTS = join(paths.appRoot, 'sidecar', 'requirements.txt')
const DEV_VENV_PYTHON = join(paths.appRoot, 'sidecar', '.venv', 'bin', 'python')
const MANAGED_PYTHON = join(paths.userData, 'sidecar-venv', 'bin', 'python')
const MARKER = join(paths.userData, 'sidecar-venv', '.musaeum-requirements')

/** What a completed install records. Recomputed so editing a fixture can't drift. */
function currentHash(): string {
  return createHash('sha256').update(readFileSync(REQUIREMENTS)).digest('hex')
}

function touch(path: string, contents = ''): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, contents)
}

function writeRequirements(contents = 'Pillow>=10.0\n'): void {
  touch(REQUIREMENTS, contents)
}

beforeEach(() => {
  closeDb()
  rmSync(paths.base, { recursive: true, force: true })
  mkdirSync(paths.appRoot, { recursive: true })
  mkdirSync(paths.userData, { recursive: true })
})

describe('parseVersion', () => {
  it('reads a version from stdout', () => {
    expect(parseVersion('Python 3.12.4\n')).toEqual([3, 12])
  })

  it('reads a two-digit minor', () => {
    expect(parseVersion('Python 3.100.0')).toEqual([3, 100])
  })

  it('returns null for output that is not a Python banner', () => {
    expect(parseVersion('bash: python3: command not found')).toBeNull()
    expect(parseVersion('')).toBeNull()
  })
})

describe('meetsMinimum', () => {
  it('accepts the minimum and anything newer', () => {
    expect(meetsMinimum([3, 11])).toBe(true)
    expect(meetsMinimum([3, 12])).toBe(true)
    expect(meetsMinimum([4, 0])).toBe(true)
  })

  it('rejects older interpreters', () => {
    expect(meetsMinimum([3, 10])).toBe(false)
    expect(meetsMinimum([2, 7])).toBe(false)
  })
})

describe('findBaseInterpreter', () => {
  it('finds a system interpreter new enough to build a venv from', () => {
    const found = findBaseInterpreter()
    // The dev machine and CI both have one; if this ever fails, the packaged
    // app's bootstrap would fail on the same machine for the same reason
    expect(found).toBeTruthy()
  })
})

describe('resolvePython', () => {
  it('prefers a configured interpreter over every detected one', () => {
    touch(DEV_VENV_PYTHON)
    touch(MANAGED_PYTHON)
    setConfig('python_path', process.execPath)
    expect(resolvePython()).toEqual({ path: process.execPath, source: 'configured' })
  })

  it('ignores a configured interpreter that no longer exists', () => {
    touch(DEV_VENV_PYTHON)
    setConfig('python_path', join(paths.base, 'deleted', 'python'))
    expect(resolvePython()).toEqual({ path: DEV_VENV_PYTHON, source: 'auto' })
  })

  it("prefers the repo's dev venv over the managed one", () => {
    touch(DEV_VENV_PYTHON)
    touch(MANAGED_PYTHON)
    expect(resolvePython()).toEqual({ path: DEV_VENV_PYTHON, source: 'auto' })
  })

  it('falls back to the managed venv when there is no dev venv', () => {
    touch(MANAGED_PYTHON)
    expect(resolvePython()).toEqual({ path: MANAGED_PYTHON, source: 'auto' })
  })

  it('falls back to a system interpreter when no venv exists at all', () => {
    const { path, source } = resolvePython()
    expect(source).toBe('auto')
    expect(path).toBe(findBaseInterpreter())
  })
})

describe('needsBootstrap', () => {
  it('is true when nothing but requirements.txt exists', () => {
    writeRequirements()
    expect(needsBootstrap()).toBe(true)
  })

  it('is false without a requirements.txt to install from', () => {
    expect(needsBootstrap()).toBe(false)
  })

  it('is false when the user configured their own interpreter', () => {
    writeRequirements()
    setConfig('python_path', process.execPath)
    expect(needsBootstrap()).toBe(false)
  })

  it("is false when the repo's dev venv is present", () => {
    writeRequirements()
    touch(DEV_VENV_PYTHON)
    expect(needsBootstrap()).toBe(false)
  })

  it('is false once the managed venv is installed and its marker matches', () => {
    writeRequirements()
    touch(MANAGED_PYTHON)
    touch(MARKER, currentHash())
    expect(needsBootstrap()).toBe(false)
  })

  it('is true again after requirements.txt changes', () => {
    writeRequirements()
    touch(MANAGED_PYTHON)
    touch(MARKER, currentHash())
    expect(needsBootstrap()).toBe(false)

    writeRequirements('Pillow>=10.0\npypdf>=4.0\n')
    expect(needsBootstrap()).toBe(true)
  })

  it('is true when the venv exists but the install never finished', () => {
    // The marker is written last, so a killed pip leaves no marker
    writeRequirements()
    touch(MANAGED_PYTHON)
    expect(needsBootstrap()).toBe(true)
  })

  it('is true when the marker survives but the interpreter is gone', () => {
    writeRequirements()
    touch(MARKER, currentHash())
    expect(needsBootstrap()).toBe(true)
  })
})

describe('ensurePythonEnv', () => {
  it('resolves without spawning anything when an environment already exists', async () => {
    writeRequirements()
    touch(DEV_VENV_PYTHON)
    const progress = vi.fn()

    const result = await ensurePythonEnv(progress)

    expect(result).toEqual({ ok: true, python: DEV_VENV_PYTHON })
    // Nothing to report: the status bar stays empty on a normal launch
    expect(progress).not.toHaveBeenCalled()
  })

  it('reports a configured interpreter as the answer without building a venv', async () => {
    writeRequirements()
    setConfig('python_path', process.execPath)

    const result = await ensurePythonEnv(vi.fn())

    expect(result).toEqual({ ok: true, python: process.execPath })
    expect(existsSync(managedVenvDir())).toBe(false)
  })

  // The bootstrap runs before the renderer subscribes, so a failure nobody
  // heard is a failure nobody can see — the app looks healthy while every
  // metadata feature silently does nothing.
  // Driven by making the venv target unwritable, because the no-interpreter
  // case can't be forced on a machine that has one (and this file's other
  // tests need the real interpreter search).
  it('holds a failure for a renderer that mounted too late to hear it', async () => {
    writeRequirements()
    // Open the DB first: `needsBootstrap` reads config, and SQLite can't
    // create its files once the directory below goes read-only
    setConfig('smb_url', 'smb://noop')
    chmodSync(paths.userData, 0o500)
    try {
      const result = await ensurePythonEnv(vi.fn())

      expect(result.ok).toBe(false)
      expect(getPythonEnvState()).toMatchObject({ stage: 'failed' })
    } finally {
      chmodSync(paths.userData, 0o700)
    }
  })

  it('reports nothing to a late renderer when the environment is fine', async () => {
    writeRequirements()
    touch(DEV_VENV_PYTHON)

    await ensurePythonEnv(vi.fn())

    expect(getPythonEnvState()).toBeNull()
  })
})

describe('sidecarDir', () => {
  it('resolves inside the app path in development', () => {
    expect(sidecarDir()).toBe(join(paths.appRoot, 'sidecar'))
  })
})
