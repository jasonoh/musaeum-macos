import { exec } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { NASStatus, NASState, StorageKind } from '@shared/metadata.types'
import { getConfig, setConfig } from './db'
import { broadcast } from './events'
import { readLibraryKind, resolveStorageKind, writeLibraryKind } from './storage-kind'
import { storageStatusCopy } from './storage-copy'

const HEALTH_CHECK_INTERVAL_MS = 30_000
const RECONNECT_BACKOFF_MS = [5_000, 15_000, 60_000]

let state: NASState = 'unconfigured'

/**
 * The kind in force: the stored fact, or the one derived the first time this
 * root was reachable. Null until a health check has resolved a root, and null
 * again when no root is configured.
 */
let kind: StorageKind | null = null

let lastCheckedAt: string | null = null
let healthTimer: NodeJS.Timeout | null = null
let retryTimer: NodeJS.Timeout | null = null
let retryAttempt = 0
let nextRetryAt: number | null = null

/**
 * The parts of the last status sent to surfaces, so the next one goes out only
 * when something a surface renders has moved.
 *
 * **Not keyed on the state alone.** The state is one of three facts the rows and
 * the copy are built from, and the kind moves on its own: a re-pick that swaps a
 * folder for a share keeps the state at `connected`, so a broadcast keyed on the
 * state left the renderer holding the old kind. Measured on the probe
 * 2026-09-24, on the criterion that reads Settings with `library_kind` set to
 * `network`: Settings went on rendering *"Local folder"* with the SMB URL row
 * hidden after the stored kind had already moved — this feature's
 * two-surfaces-disagreeing defect, one layer up from where it was fixed.
 */
let sent: string | null = null

/**
 * Whether a `reconnect()` attempt is in flight **right now**.
 *
 * Deliberately not the same thing as the state, which is the whole of D3:
 * `reconnecting` describes this moment, `disconnected` describes "the share is
 * away and a timer is armed". Conflating the two pinned the state at
 * `reconnecting` for good once the first automatic retry had run — every later
 * health check declined to downgrade it — so the app stopped telling the user
 * their library was away and editing was disabled, and implied it was
 * mid-recovery indefinitely. Measured 2026-09-24: the informative copy was
 * visible for four samples, then *"Reconnecting to the library…"* for the next
 * 20+ across a minute.
 */
let attemptInFlight = false

type Listener = (status: NASStatus) => void
const listeners = new Set<Listener>()

export function onStatusChange(fn: Listener): void {
  listeners.add(fn)
}

export function getLibraryRoot(): string | null {
  return getConfig('library_root')
}

/**
 * Wire a root in, and resolve its **kind** here — the one moment the path
 * necessarily exists.
 *
 * `library_root` and `library_kind` are written by the same flow on purpose.
 * The kind is a fact about where the user chose to put the library: it does not
 * change when the path temporarily does, and re-picking is the one event that
 * re-derives it (`services/storage-kind.ts` carries the argument for storing it
 * at all).
 */
export async function setLibraryRoot(path: string): Promise<void> {
  setConfig('library_root', path)
  kind = await resolveStorageKind(path)
  writeLibraryKind(kind)
  retryAttempt = 0
  await checkHealth()
}

export function getStatus(): NASStatus {
  const nextRetryMs = nextRetryAt ? Math.max(0, nextRetryAt - Date.now()) : null
  return {
    state,
    kind,
    libraryRoot: getLibraryRoot(),
    nextRetryMs,
    lastCheckedAt,
    // Composed here rather than in the renderer (D4) — and from the three facts
    // above it, so the sentence cannot disagree with the state it describes.
    copy: storageStatusCopy(state, kind, nextRetryMs)
  }
}

export function isOnline(): boolean {
  return state === 'connected'
}

/**
 * Throws a friendly error when the library is not writable.
 *
 * **The sentence names no server.** It said "Reconnect to the NAS to make
 * changes", which was measured being shown to a user whose library is a folder
 * on the boot disk (reading 12, 2026-09-24) — an instruction to fix a machine
 * they do not own. `missing` and `disconnected` are different problems with
 * different fixes, so they say different things.
 */
export function assertOnline(): void {
  if (state === 'unconfigured') {
    throw new Error('No library folder is configured. Choose a library location in Settings.')
  }
  if (state !== 'connected') {
    throw new Error(
      state === 'missing'
        ? 'The library folder is missing — choose where it went to make changes.'
        : 'The library is offline. Reconnect to make changes.'
    )
  }
}

/**
 * Send the status when a fact a surface renders has moved — the state, the kind,
 * or the root. `sent` carries the argument for why the state is not the test on
 * its own.
 *
 * `nextRetryMs` is deliberately outside the comparison: it is a countdown, so
 * including it would make every poll a broadcast. The one moment a status has to
 * travel while nothing but the countdown changed says so itself —
 * `scheduleReconnect` broadcasts for exactly that reason.
 */
function announce(): void {
  const status = getStatus()
  const shape = JSON.stringify([status.state, status.kind, status.libraryRoot])
  if (shape === sent) return
  sent = shape
  broadcast('nasStatusChanged', status)
  for (const fn of listeners) fn(status)
}

/**
 * Set the state and let `announce` decide whether that is news.
 *
 * No early return here on purpose: an unchanged state is not the only way a
 * status goes stale (see `sent`), so the comparison lives in one place rather
 * than two.
 */
function setState(next: NASState): void {
  state = next
  announce()
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

/**
 * The kind in force: the stored fact, or one derived the first time this root
 * is reachable with nothing stored — an install that predates the key.
 *
 * Persisting the derived answer is what makes the fact survive the launch where
 * it matters. Absent both, the answer is `local`, because network is claimed
 * only on positive evidence: misreading a folder as a share is the defect this
 * whole design removes. The residual is a library that predates the key whose
 * share is *away* on the first launch after this ships — it reads `missing`
 * until the root is seen once, or the folder is picked again. A bad day rather
 * than a broken library, and the Settings row is where it becomes visible.
 */
async function kindInForce(root: string, reachable: boolean): Promise<StorageKind> {
  const stored = readLibraryKind()
  if (stored) return stored
  if (!reachable) return 'local'
  const derived = await resolveStorageKind(root)
  writeLibraryKind(derived)
  return derived
}

export async function checkHealth(): Promise<NASStatus> {
  lastCheckedAt = new Date().toISOString()
  const root = getLibraryRoot()
  if (!root) {
    kind = null
    clearRetry()
    setState('unconfigured')
    return getStatus()
  }

  const reachable = await isMounted(root)
  kind = await kindInForce(root, reachable)

  if (reachable) {
    retryAttempt = 0
    clearRetry()
    try {
      await ensureLibraryDirs(root)
    } catch {
      // Mounted but not writable — still browsable, treat as connected
    }
    setState('connected')
    return getStatus()
  }

  if (kind === 'local') {
    // A backoff is a claim that waiting is a strategy. For a folder it is not:
    // nothing is coming back on its own, so the retry's only effects were three
    // `open -g` calls a minute and a banner that lied. No timer is armed and
    // `nextRetryMs` stays null, which is what stops the banner rendering
    // "Retrying in Ns" for a state that is not retrying.
    clearRetry()
    setState('missing')
    return getStatus()
  }

  // A share is away and will come back: describe *that*, and arm the backoff.
  // Skipped while an attempt is in flight, so a 30 s poll landing mid-attempt
  // cannot stomp the transient state that attempt is about to settle itself.
  if (!attemptInFlight) setState('disconnected')
  scheduleReconnect()
  return getStatus()
}

/**
 * Disarm the backoff. `nextRetryMs` is null afterwards — "not retrying" is
 * reported, not left to be inferred from the absence of a timer.
 */
function clearRetry(): void {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  nextRetryAt = null
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

/**
 * The recovery for a **share**: mount it again, then re-check. Returns true when
 * connected.
 *
 * For a folder there is nothing to mount and nothing that could come back, so
 * this shells nothing at all — it re-checks and reports. That matters beyond
 * tidiness: this is what the banner's *Retry Now* calls, and reading 10
 * measured that button running an SMB mount for a local library. A missing
 * folder's recovery is the picker (`ipc/nas.ts`, D6) — a different verb, behind
 * a different button.
 */
export async function reconnect(): Promise<boolean> {
  const root = getLibraryRoot()
  if (!root) return false

  const reachable = await isMounted(root)
  kind = await kindInForce(root, reachable)
  if (kind === 'local') return (await checkHealth()).state === 'connected'

  attemptInFlight = true
  setState('reconnecting')
  try {
    if (!(await isMounted(root))) {
      // **The share is one the user named.** Nothing is compiled in any more —
      // the fallback this used to carry was the owner's own server, which made
      // this the second place a personal hostname shipped in the product and the
      // worse of the two, because it silently *acted*. With nothing configured
      // there is nothing to mount, so the attempt falls through to the re-check
      // and lands in `disconnected`, where the Settings row's own note says the
      // app will not mount one for you.
      const smbUrl = getConfig('smb_url')?.trim()
      if (smbUrl) {
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
    }
  } finally {
    // Cleared *before* the health check, deliberately: the attempt is over, so
    // the state it lands in is the truth about the library rather than about
    // the attempt. A failed mount therefore lands in `disconnected` — with the
    // timer re-armed — instead of pinning `reconnecting` (D3).
    attemptInFlight = false
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
  healthTimer = null
  clearRetry()
}
