import { exec } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { NASStatus, NASState } from '@shared/metadata.types'
import { getConfig, setConfig } from './db'
import { broadcast } from './events'

const HEALTH_CHECK_INTERVAL_MS = 30_000
const RECONNECT_BACKOFF_MS = [5_000, 15_000, 60_000]
const DEFAULT_SMB_URL = 'smb://ohnas'

let state: NASState = 'unconfigured'
let lastCheckedAt: string | null = null
let healthTimer: NodeJS.Timeout | null = null
let retryTimer: NodeJS.Timeout | null = null
let retryAttempt = 0
let nextRetryAt: number | null = null

type Listener = (status: NASStatus) => void
const listeners = new Set<Listener>()

export function onStatusChange(fn: Listener): void {
  listeners.add(fn)
}

export function getLibraryRoot(): string | null {
  return getConfig('library_root')
}

export async function setLibraryRoot(path: string): Promise<void> {
  setConfig('library_root', path)
  retryAttempt = 0
  await checkHealth()
}

export function getStatus(): NASStatus {
  return {
    state,
    libraryRoot: getLibraryRoot(),
    nextRetryMs: nextRetryAt ? Math.max(0, nextRetryAt - Date.now()) : null,
    lastCheckedAt
  }
}

export function isOnline(): boolean {
  return state === 'connected'
}

/** Throws a friendly error when the library is not writable. */
export function assertOnline(): void {
  if (state === 'unconfigured') {
    throw new Error('No library folder is configured. Choose a library location in Settings.')
  }
  if (state !== 'connected') {
    throw new Error('The library is offline. Reconnect to the NAS to make changes.')
  }
}

function setState(next: NASState): void {
  if (next === state) return
  state = next
  const status = getStatus()
  broadcast('nasStatusChanged', status)
  for (const fn of listeners) fn(status)
}

async function isMounted(root: string): Promise<boolean> {
  try {
    await fs.access(root)
    return true
  } catch {
    return false
  }
}

async function ensureLibraryDirs(root: string): Promise<void> {
  for (const dir of ['books', 'imports', 'exports']) {
    await fs.mkdir(join(root, dir), { recursive: true })
  }
}

export async function checkHealth(): Promise<NASStatus> {
  lastCheckedAt = new Date().toISOString()
  const root = getLibraryRoot()
  if (!root) {
    setState('unconfigured')
    return getStatus()
  }
  if (await isMounted(root)) {
    retryAttempt = 0
    nextRetryAt = null
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    try {
      await ensureLibraryDirs(root)
    } catch {
      // Mounted but not writable — still browsable, treat as connected
    }
    setState('connected')
  } else {
    if (state !== 'reconnecting') setState('disconnected')
    scheduleReconnect()
  }
  return getStatus()
}

function scheduleReconnect(): void {
  if (retryTimer) return
  const delay = RECONNECT_BACKOFF_MS[Math.min(retryAttempt, RECONNECT_BACKOFF_MS.length - 1)]
  nextRetryAt = Date.now() + delay
  broadcast('nasStatusChanged', getStatus())
  retryTimer = setTimeout(async () => {
    retryTimer = null
    retryAttempt++
    await reconnect()
  }, delay)
}

/** Attempt to mount the SMB share, then re-check. Returns true when connected. */
export async function reconnect(): Promise<boolean> {
  const root = getLibraryRoot()
  if (!root) return false
  setState('reconnecting')

  if (!(await isMounted(root))) {
    const smbUrl = getConfig('smb_url') ?? DEFAULT_SMB_URL
    // `open -g` asks macOS to mount the share without stealing focus
    await new Promise<void>((resolve) => {
      exec(`open -g '${smbUrl.replace(/'/g, "'\\''")}'`, () => resolve())
    })
    // Give the mount a few seconds to appear
    for (let i = 0; i < 10; i++) {
      if (await isMounted(root)) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  const status = await checkHealth()
  return status.state === 'connected'
}

export function startHealthChecks(): void {
  if (healthTimer) return
  void checkHealth()
  healthTimer = setInterval(() => void checkHealth(), HEALTH_CHECK_INTERVAL_MS)
}

export function stopHealthChecks(): void {
  if (healthTimer) clearInterval(healthTimer)
  if (retryTimer) clearTimeout(retryTimer)
  healthTimer = null
  retryTimer = null
}
