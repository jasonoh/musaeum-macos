import { describe, expect, it } from 'vitest'
import type { NASState } from '@shared/metadata.types'
import { smbUrlDetail, storageKindLabel, storageStatusCopy, syncRootNote } from './storage-copy'

/**
 * D4: **the words for every storage state are composed here, in the main
 * process**, so a unit test can assert them instead of an eye.
 *
 * What this file is for, in one sentence: two components used to each carry
 * their own ternary over `NASState`, and a user whose library is a folder on
 * this Mac was read the sentence a dropped share gets — so the sentences are
 * values now, and this is where they are decided.
 *
 * **The absence assertions are half the point.** A status message must name no
 * server: reading 12 measured *"Reconnect to the NAS to make changes"* being
 * shown to someone who has no NAS. The sweep at the bottom walks every state and
 * both kinds rather than the one state the copy happened to be written for,
 * because the sentence that leaks a server is usually the one nobody re-read.
 */

const STATES: NASState[] = ['connected', 'unconfigured', 'reconnecting', 'disconnected', 'missing']

describe('the banner’s sentence', () => {
  it('says nothing at all when the library is there', () => {
    const copy = storageStatusCopy('connected', 'local', null)
    expect(copy.message).toBeNull()
    expect(copy.recovery).toBeNull()
  })

  it('keeps the two sentences that were already right, word for word', () => {
    // The model the rest of the copy follows: storage-neutral, an instruction,
    // no server named. Neither may drift without this case reddening.
    expect(storageStatusCopy('unconfigured', null, null).message).toBe(
      'No library folder configured — choose where Musaeum should keep your books.'
    )
    expect(storageStatusCopy('disconnected', 'network', null).message).toBe(
      'Library offline — browsing from cache, editing disabled.'
    )
  })

  it('describes a missing folder as missing, and carries the same consequence', () => {
    // The defect this criterion is about: this state used to render the offline
    // sentence, which is the share's problem, not a folder's
    const copy = storageStatusCopy('missing', 'local', null)
    expect(copy.message).toBe('Library folder missing — browsing from cache, editing disabled.')
    expect(copy.message).not.toMatch(/offline/i)
  })

  it('appends the retry clause only where something is retrying', () => {
    expect(storageStatusCopy('disconnected', 'network', 12_400).message).toBe(
      'Library offline — browsing from cache, editing disabled. Retrying in 13s.'
    )
    // Armed but not yet: the timer is set a beat after the state broadcasts, and
    // a sentence claiming a retry that is not scheduled is the lie this clause
    // exists to prevent
    expect(storageStatusCopy('disconnected', 'network', null).message).toBe(
      'Library offline — browsing from cache, editing disabled.'
    )
    // A missing root arms nothing, so the clause must never appear for one
    expect(storageStatusCopy('missing', 'local', 0).message).not.toMatch(/Retrying/)
    expect(storageStatusCopy('missing', 'local', 60_000).message).not.toMatch(/Retrying/)
  })

  it('names the attempt rather than the situation while one is in flight', () => {
    // During an attempt `nextRetryMs` reads 0 (the timer has been consumed), and
    // "Retrying in 0s" beside "Reconnecting…" is exactly the sort of sentence
    // two components composing their own copy used to produce
    expect(storageStatusCopy('reconnecting', 'network', 0).message).toBe(
      'Reconnecting to the library…'
    )
  })
})

describe('the row label', () => {
  it('is one word per state, the same one for both rows', () => {
    const labels = STATES.map((state) => storageStatusCopy(state, 'local', null).label)
    expect(labels).toEqual([
      'Connected',
      'Not configured',
      'Reconnecting…',
      'Offline',
      'Folder missing'
    ])
    // No two states share a label: a row that reads the same for two different
    // problems is how "Offline" came to be shown for a folder that had moved
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('which recovery a state offers', () => {
  it('offers the picker with no hint when no root is chosen', () => {
    expect(storageStatusCopy('unconfigured', null, null).recovery).toBe('choose')
  })

  it('offers the picker, pre-pointed, for a folder that is gone — never a retry', () => {
    // D2/D6: there is nothing for a retry to do, and slice 2's fourth settled
    // reading is that the affordance replaces *Retry Now* rather than joining it
    expect(storageStatusCopy('missing', 'local', null).recovery).toBe('locate')
  })

  it('offers the retry only where a mount is the recovery', () => {
    expect(storageStatusCopy('disconnected', 'network', null).recovery).toBe('retry')
    expect(storageStatusCopy('reconnecting', 'network', 0).recovery).toBe('retry')
    expect(storageStatusCopy('connected', 'local', null).recovery).toBeNull()
  })
})

/**
 * The guard that makes `kind` load-bearing rather than decorative.
 *
 * `missing` is only ever set for a local root, so a caller describing anything
 * else is describing a share that is away — and the retryable copy is the only
 * honest answer, because a share is the one thing that comes back on its own.
 */
describe('a missing root described as a share', () => {
  it('falls back to the retryable copy rather than offering a picker for a share', () => {
    const copy = storageStatusCopy('missing', 'network', 5_000)
    // The whole record, deliberately: the guard has to move *every* sentence the
    // state carries, and the delete notice is one of them now (2026-09-24) — a
    // `toMatchObject` here would leave the fourth field able to disagree.
    expect(copy).toEqual({
      message: 'Library offline — browsing from cache, editing disabled. Retrying in 5s.',
      label: 'Offline',
      recovery: 'retry',
      deleteBlocked: 'The library is offline — reconnect before deleting. Retrying in 5s.'
    })
  })
})

describe('the storage kind, in words', () => {
  it('names the two kinds and the unresolved case', () => {
    expect(storageKindLabel('local')).toBe('Local folder')
    expect(storageKindLabel('network')).toBe('Network share')
    expect(storageKindLabel(null)).toBe('Not known yet')
  })
})

describe('the SMB row’s note (D5)', () => {
  it('says what happens when a share is configured', () => {
    expect(smbUrlDetail(true)).toBe('Mounted automatically when the library folder goes missing')
  })

  it('and, when none is, says the app will not mount one — naming no hostname', () => {
    const note = smbUrlDetail(false)
    expect(note).toMatch(/will not mount one for you/)
    // The placeholder this replaces was the owner's own server, shipped to every
    // user of the product. Nothing like it may come back through the note.
    expect(note).not.toMatch(/smb:|nas/i)
  })
})

describe('the cloud-synced root line (D7)', () => {
  it('names the client and the hazard the catalog documents', () => {
    const note = syncRootNote('Dropbox')
    expect(note).toContain('Dropbox')
    expect(note).toMatch(/a second machine writing the same library can lose changes/)
  })

  it('claims the eviction hazard for iCloud alone', () => {
    expect(syncRootNote('iCloud Drive')).toMatch(/iCloud may also remove a file’s contents/)
    // Nothing measured says a Dropbox or Google Drive folder evicts anything, so
    // the sentence must not say it — this is the "claim only what is known" rule
    for (const client of ['Dropbox', 'Google Drive', 'OneDrive', 'Box', 'Proton Drive']) {
      expect(syncRootNote(client)).not.toMatch(/remove a file/i)
    }
  })

  it('never refuses the folder', () => {
    for (const client of ['iCloud Drive', 'Dropbox', 'Google Drive', 'AcmeSync-Acme']) {
      expect(syncRootNote(client)).not.toMatch(/unsupported|not supported|can’t be used/i)
      expect(syncRootNote(client)).toContain(client)
    }
  })
})

/**
 * Slice 2's second residue, closed: **the delete dialogs' one sentence for four
 * states.**
 *
 * Both dialogs rendered *"The library is offline — reconnect before deleting."*
 * for `unconfigured`, `disconnected`, `reconnecting` **and** `missing`, because
 * they read the state as a boolean (`state === 'connected'`) and could not have
 * said anything else. "Reconnect" is a remedy exactly one of the four has: a
 * folder that has moved wants the picker, a library with no folder wants one
 * chosen, and an attempt in flight wants waiting out. The verb is therefore the
 * load-bearing half of every case below, and each names the one it must *not*
 * carry — a case that only asserted the sentence it expects would stay green
 * while all four drifted back to the offline wording.
 */
describe('what a delete is told when it cannot run', () => {
  it('says nothing when the library can take one', () => {
    expect(storageStatusCopy('connected', 'local', null).deleteBlocked).toBeNull()
  })

  it('sends a folder that has moved to the picker, and never to a reconnect', () => {
    const blocked = storageStatusCopy('missing', 'local', null).deleteBlocked
    expect(blocked).toBe('The library folder is missing — choose where it went before deleting.')
    expect(blocked).not.toMatch(/reconnect|offline/i)
  })

  it('keeps "reconnect" for the one state that has a mount to redo', () => {
    expect(storageStatusCopy('disconnected', 'network', null).deleteBlocked).toBe(
      'The library is offline — reconnect before deleting.'
    )
  })

  it('carries the retry clause where a retry is armed, and only there', () => {
    expect(storageStatusCopy('disconnected', 'network', 12_400).deleteBlocked).toBe(
      'The library is offline — reconnect before deleting. Retrying in 13s.'
    )
    // A folder arms no timer, so the clause must never appear on its sentence
    expect(storageStatusCopy('missing', 'local', 60_000).deleteBlocked).not.toMatch(/Retrying/)
  })

  it('tells a mid-attempt user to wait rather than claiming a state that is not true', () => {
    const blocked = storageStatusCopy('reconnecting', 'network', 0).deleteBlocked
    expect(blocked).toBe('Reconnecting to the library — wait a moment before deleting.')
    // It must not claim the offline state, and it must not be the disconnected
    // sentence — whose verb names the attempt this state is already making. The
    // verb itself is "Reconnecting", so the assertion is on the sentence, not on
    // a substring: `/reconnect/` matches the word that belongs here.
    expect(blocked).not.toMatch(/offline/i)
    expect(blocked).not.toBe(storageStatusCopy('disconnected', 'network', 0).deleteBlocked)
  })

  it('sends a library with no folder at all to choose one', () => {
    const blocked = storageStatusCopy('unconfigured', null, null).deleteBlocked
    expect(blocked).toMatch(/choose where Musaeum should keep your books/)
    expect(blocked).not.toMatch(/reconnect|offline/i)
  })

  it('falls back to the retryable sentence for a `missing` root described as a share', () => {
    expect(storageStatusCopy('missing', 'network', 5_000).deleteBlocked).toBe(
      'The library is offline — reconnect before deleting. Retrying in 5s.'
    )
  })

  it('is never the banner’s own sentence, which has a control beside it', () => {
    // The reason the two fields exist: the banner can leave the verb to the
    // button it draws, and a dialog draws none. A copy that collapsed them into
    // one value — one sentence reused for both — is what this case refuses.
    for (const state of STATES) {
      const copy = storageStatusCopy(state, 'local', 5_000)
      if (copy.deleteBlocked !== null && copy.message !== null) {
        expect(copy.deleteBlocked, state).not.toBe(copy.message)
      }
    }
  })
})

/**
 * The sweep: **no state's copy names a server, from any angle.**
 *
 * Run over the whole matrix rather than over the states this slice happened to
 * write copy for, because the sentence that leaks is the one nobody re-read —
 * and the two `kind`s are both walked, since a state machine hands out pairs and
 * copy is composed from the pair.
 *
 * The delete notice is swept here too: it is a second sentence per state, and a
 * sentence nobody re-read is exactly what this walk is for.
 */
describe('no state names a server', () => {
  it.each(
    STATES.flatMap((state) =>
      ([null, 'local', 'network'] as const).map((kind) => [state, kind] as const)
    )
  )('%s + %s', (state, kind) => {
    const copy = storageStatusCopy(state, kind, 5_000)
    const words = [
      copy.message ?? '',
      copy.label,
      copy.recovery ?? '',
      copy.deleteBlocked ?? ''
    ].join(' ')
    expect(words).not.toMatch(/NAS|smb|nas\/|server|share/i)
  })
})
