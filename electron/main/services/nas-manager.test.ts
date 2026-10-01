import { mkdirSync, mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, deleteConfig, getConfig, setConfig } from './db'
import * as nas from './nas-manager'
import { LIBRARY_KIND_KEY } from './storage-kind'

/**
 * `open -g '<share>'` is this module's only way out of the process, and counting
 * it is the whole instrument for AC2 and AC3 — reading 9 measured three of them
 * a minute against a library that was a folder.
 *
 * `mount` (the kind resolver's own call) is answered here too, with an **empty
 * table**: no network filesystem is named, so `local` is what derivation would
 * say and the stored kind is what decides every case in this file. That
 * separation matters — a fixture table naming `/Volumes/books` would make the
 * resolver, not the case, decide the answer.
 */
const shim = vi.hoisted(() => ({
  /** Every `open …` this process ran, in order. */
  opened: [] as string[],
  /** Whether the fake mount actually appears when asked for. */
  appears: false,
  /** What the fake mount creates. */
  root: ''
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  const exec = (
    command: string,
    callback?: (err: unknown, stdout: string, stderr: string) => void
  ): void => {
    // A fake mount that appears is a *real* directory — the state machine asks
    // `fs.access`, and a stub that answered for it would decide nothing
    if (command !== 'mount') {
      shim.opened.push(command)
      if (shim.appears) mkdirSync(shim.root, { recursive: true })
    }
    callback?.(null, '', '')
  }
  // A `ChildProcess` return is the one thing a recorder cannot honour, and
  // nothing in the module under test reads it.
  return { ...actual, exec: exec as unknown as typeof actual.exec }
})

/**
 * Everything a case needs lives under one temp directory that is removed
 * afterwards — including the share that *appears* mid-case, which is a real
 * directory by the time the case ends. Leaving it behind makes the next case
 * find a share that is not away, which is a fixture bug that reads exactly like
 * a broken state machine.
 */
let scratch: string
/** An existing folder on the boot disk: the local root. */
let local: string
/** A path on a share that is away — nothing answers for it, or for its parent. */
let away: string

beforeEach(() => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
  deleteConfig('library_root')
  shim.opened.length = 0
  shim.appears = false
  shim.root = ''

  scratch = mkdtempSync(join(tmpdir(), 'musaeum-nas-'))
  local = join(scratch, 'local')
  mkdirSync(local)
  away = join(scratch, 'share', 'musaeum')
})

afterEach(async () => {
  nas.stopHealthChecks()
  vi.useRealTimers()
  // Drain anything still in flight before the next case tears the database out
  // from under it. A retry chain that resumes *after* the case ends reads a
  // database that has since been deleted and writes a kind of its own choosing,
  // which surfaces later as a wrong sentence — a failure that looks like a
  // broken state machine and is not one.
  await new Promise((resolve) => setImmediate(resolve))
  rmSync(scratch, { recursive: true, force: true })
})

/** What `assertOnline` says, rather than whether it said something. */
function refusal(): string {
  try {
    nas.assertOnline()
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  return ''
}

describe('checkHealth', () => {
  it('reports a local root that exists as connected, and writes the library dirs (AC1)', async () => {
    setConfig('library_root', local)

    const status = await nas.checkHealth()

    expect(status.state).toBe('connected')
    // Derived on the first reachable look at a root that has no kind stored —
    // and persisted, which is what makes it survive the launch where it matters
    expect(status.kind).toBe('local')
    expect(getConfig(LIBRARY_KIND_KEY)).toBe('local')
    expect(status.nextRetryMs).toBeNull()
    for (const dir of ['books', 'imports', 'exports']) {
      expect(statSync(join(local, dir)).isDirectory()).toBe(true)
    }
  })

  it('reports no folder as unconfigured, with no kind', async () => {
    setConfig('library_root', local)
    await nas.checkHealth()

    deleteConfig('library_root')
    const status = await nas.checkHealth()

    expect(status).toMatchObject({ state: 'unconfigured', kind: null, nextRetryMs: null })
  })

  it('reports a missing local root as missing, with nothing armed and nothing shelled (AC2)', async () => {
    setConfig('library_root', local)
    setConfig(LIBRARY_KIND_KEY, 'local')
    rmSync(local, { recursive: true, force: true })

    vi.useFakeTimers()
    const status = await nas.checkHealth()

    expect(status.state).toBe('missing')
    expect(status.kind).toBe('local')
    // The field the banner reads: null is what stops it rendering "Retrying in
    // Ns" for a state that is not retrying
    expect(status.nextRetryMs).toBeNull()

    // A real timer window, not an inspection: 70 s is past the whole 5 s / 15 s /
    // 60 s ladder, so an armed retry would have fired several times over. Paired
    // with the network case below, which shells out of the same window.
    await vi.advanceTimersByTimeAsync(70_000)
    expect(shim.opened).toEqual([])
  })

  it('still reports a missing share as a retryable failure, and still mounts it (AC3)', async () => {
    setConfig('library_root', away)
    setConfig(LIBRARY_KIND_KEY, 'network')
    // **The share the user named.** Slice 2 removed the hostname this used to
    // fall back on (reading 13: `smb://nas`, the owner's own server, compiled
    // into a shipped default), so the case configures one.
    setConfig('smb_url', 'smb://server/books')
    shim.root = away

    vi.useFakeTimers()
    const status = await nas.checkHealth()

    expect(status.state).toBe('disconnected')
    expect(status.kind).toBe('network')
    expect(status.nextRetryMs).toBeGreaterThan(0)

    // The share comes back when asked for: this is the criterion that stops the
    // slice from quietly deleting the NAS feature
    shim.appears = true
    await vi.advanceTimersByTimeAsync(75_000)
    await vi.waitFor(() => expect(nas.getStatus().state).toBe('connected'), { timeout: 5_000 })

    expect(shim.opened.length).toBeGreaterThan(0)
    expect(shim.opened[0]).toBe("open -g 'smb://server/books'")
  })

  it('mounts nothing at all for a share nobody named (D5)', async () => {
    // Through the picker first: the ladder is module state and this case needs
    // the first rung, which is what `setLibraryRoot` resets it to
    await nas.setLibraryRoot(away)
    setConfig(LIBRARY_KIND_KEY, 'network')
    shim.root = away
    shim.appears = true // a mount that *would* appear must still not be asked for

    const seen: string[] = []
    nas.onStatusChange((status) => seen.push(status.state))
    const attempts = (): number => seen.filter((s) => s === 'reconnecting').length

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    expect((await nas.checkHealth()).state).toBe('disconnected')

    // The ladder still runs — a share does come back, and the poll is what sees
    // it — so the criterion is that the attempts happen and shell *nothing*.
    const deadline = Date.now() + 10_000
    while (attempts() < 2 && Date.now() < deadline) {
      await vi.advanceTimersByTimeAsync(5_000)
      await new Promise((resolve) => setImmediate(resolve))
    }

    expect(attempts()).toBeGreaterThanOrEqual(2)
    expect(shim.opened).toEqual([])

    // Let the attempt that is in flight land, so what is asserted is where an
    // attempt *ends*. That landing is the reading-11 claim: an attempt that
    // mounts nothing slips back out of `reconnecting` instead of pinning there,
    // which is where the old ladder parked itself forever.
    for (let i = 0; i < 50 && nas.getStatus().state === 'reconnecting'; i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(nas.getStatus().state).toBe('disconnected')

    nas.stopHealthChecks()
  })

  it('announces the kind when it moves, though the state does not (AC10)', async () => {
    // The state is not the only fact a surface renders, and the kind moves on its
    // own: a re-pick that swaps a folder for a share keeps the state at
    // `connected`, so a broadcast keyed on the state alone left Settings rendering
    // the old kind — and hiding the SMB row — after the stored kind had already
    // moved. Found on the probe 2026-09-24 by the criterion that reads Settings
    // with `library_kind: 'network'`.
    setConfig('library_root', local)
    setConfig(LIBRARY_KIND_KEY, 'local')
    const seen: string[] = []
    nas.onStatusChange((status) => seen.push(`${status.state}/${status.kind}`))

    expect((await nas.checkHealth()).kind).toBe('local')

    // Out of band, so the state is untouched and only the kind moves
    setConfig(LIBRARY_KIND_KEY, 'network')
    expect((await nas.checkHealth()).kind).toBe('network')

    expect(seen).toEqual(['connected/local', 'connected/network'])
  })

  it('keeps reporting the stored kind on a later launch, even where derivation disagrees (AC6)', async () => {
    setConfig('library_root', local)
    setConfig(LIBRARY_KIND_KEY, 'network')

    const status = await nas.checkHealth()

    // The stored fact wins: this is the half of "stored" that makes a wrong
    // guess a displayed fact rather than a silent one
    expect(status.kind).toBe('network')
    expect(getConfig(LIBRARY_KIND_KEY)).toBe('network')
  })
})

describe('reconnect', () => {
  it('shells nothing for a local root, however the user asks (AC2, reading 10)', async () => {
    setConfig('library_root', local)
    setConfig(LIBRARY_KIND_KEY, 'local')
    rmSync(local, { recursive: true, force: true })
    shim.root = local
    shim.appears = true // a mount that *would* appear must still not be asked for

    expect(await nas.reconnect()).toBe(false)
    expect(nas.getStatus().state).toBe('missing')
    expect(nas.getStatus().nextRetryMs).toBeNull()
    expect(shim.opened).toEqual([])
  })

  it('returns a failed attempt to disconnected, twice over (AC5)', async () => {
    // Through the picker first, which is what resets the backoff ladder — the
    // module remembers how many attempts it has made, across cases as in life
    await nas.setLibraryRoot(away)
    setConfig(LIBRARY_KIND_KEY, 'network')
    shim.root = away

    const seen: string[] = []
    nas.onStatusChange((status) => seen.push(status.state))

    const attempts = (): number => seen.filter((s) => s === 'reconnecting').length
    const landings = (): number => seen.filter((s) => s === 'disconnected').length

    // Fake timers **before** the check that arms the backoff: a timer armed on
    // the real clock is not the one `advanceTimersByTimeAsync` runs. `setTimeout`
    // only — the pump below needs `setImmediate` left real so a pending
    // `fs.access` gets a turn to land.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    expect((await nas.checkHealth()).state).toBe('disconnected')

    // Two attempts, both failing. Before this slice the second `reconnecting`
    // was the last state the app ever reported: `checkHealth` declined to
    // downgrade it, so "editing is disabled" was shown once and then replaced
    // for good by "Reconnecting to the library…" (reading 11).
    //
    // Pumped until the *landings* reach three — the check itself, then one per
    // attempt — and not until the attempts merely start: stopping at the second
    // `reconnecting` leaves that attempt's landing to run after the case has
    // ended, writing its state into the next case's fixture. It is also why one
    // long jump will not do: each attempt awaits a real `fs.access` between its
    // sleeps, so a single advance fires the timer, finds the next one not yet
    // scheduled, and stops.
    const deadline = Date.now() + 10_000
    while (landings() < 3 && Date.now() < deadline) {
      await vi.advanceTimersByTimeAsync(5_000)
      await new Promise((resolve) => setImmediate(resolve))
    }

    expect(landings()).toBeGreaterThanOrEqual(3)
    expect(attempts()).toBeGreaterThanOrEqual(2)
    expect(nas.getStatus().state).toBe('disconnected')
    expect(nas.getStatus().nextRetryMs).not.toBeNull()

    // Disarmed here as well as in `afterEach`: the ladder is module state, and a
    // case that leaves it armed hands a live chain to the next one
    nas.stopHealthChecks()
  })
})

/**
 * D4: the words and the one control a state offers ride on the status the
 * renderer already receives.
 *
 * The sentences themselves are decided in `storage-copy.test.ts`, one per
 * state and kind; what is decided *here* is the wiring the renderer depends on
 * — that `getStatus()` composes from the facts it just reported, so the copy
 * cannot describe a state the status does not have.
 */
describe('the composed copy', () => {
  it('describes a missing folder, and offers the picker rather than a retry', async () => {
    setConfig('library_root', local)
    setConfig(LIBRARY_KIND_KEY, 'local')
    rmSync(local, { recursive: true, force: true })

    const status = await nas.checkHealth()

    expect(status.copy).toEqual({
      message: 'Library folder missing — browsing from cache, editing disabled.',
      label: 'Folder missing',
      recovery: 'locate',
      // Rides the same status the renderer already receives, so the dialogs can
      // render a per-state verb without reading `state` themselves (2026-09-24)
      deleteBlocked: 'The library folder is missing — choose where it went before deleting.'
    })
    // Reading 12, inverted: no sentence reaches a user carrying a server's name
    expect(status.copy.message).not.toMatch(/NAS|smb/i)
  })

  it('carries the retry clause a dropped share is owed, and a retry to match', async () => {
    // Through the picker first, so the ladder starts at its first rung and the
    // sentence below is a fixture rather than a leftover
    await nas.setLibraryRoot(away)
    setConfig(LIBRARY_KIND_KEY, 'network')
    shim.root = away

    vi.useFakeTimers()
    const status = await nas.checkHealth()

    expect(status.copy).toEqual({
      message: 'Library offline — browsing from cache, editing disabled. Retrying in 5s.',
      label: 'Offline',
      recovery: 'retry',
      deleteBlocked: 'The library is offline — reconnect before deleting. Retrying in 5s.'
    })

    nas.stopHealthChecks()
  })
})

describe('assertOnline', () => {
  it('separates a gone folder from an away share, and names no server in either', async () => {
    setConfig('library_root', local)
    setConfig(LIBRARY_KIND_KEY, 'local')
    rmSync(local, { recursive: true, force: true })
    shim.root = local
    await nas.checkHealth()
    expect(nas.getStatus().state).toBe('missing')

    // Reading 12, inverted: this sentence used to read "Reconnect to the NAS to
    // make changes" — to a user whose library is a folder
    expect(refusal()).toMatch(/library folder is missing/i)
    expect(refusal()).not.toMatch(/NAS/)

    setConfig('library_root', away)
    setConfig(LIBRARY_KIND_KEY, 'network')
    await nas.checkHealth()
    expect(refusal()).toBe('The library is offline. Reconnect to make changes.')
  })

  it('reports an unconfigured library as its own case', async () => {
    deleteConfig('library_root')
    await nas.checkHealth()
    expect(refusal()).toMatch(/No library folder is configured/)
  })
})
