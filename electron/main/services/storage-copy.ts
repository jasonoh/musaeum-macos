import type { NASRecovery, NASState, NASStatusCopy, StorageKind } from '@shared/metadata.types'
import { ICLOUD_DRIVE } from './storage-kind'

/**
 * Every sentence this app shows about its library's storage, composed here — in
 * the main process, where a unit test can assert them (D4 of
 * `docs/superpowers/specs/2026-09-24-local-library-design.md`).
 *
 * **Why the words live in main.** The alternative is what the app did until this
 * slice: `Sidebar.tsx` and `SettingsModal.tsx` each carried their own nested
 * ternary over `NASState`, so a state was a branch in both and the two could
 * disagree — and a user whose library is a *folder* was read the sentence a
 * dropped share gets, with a *Retry Now* that shelled an SMB mount. Here the
 * copy is a value: a surface renders it, and the only thing a surface decides
 * is which control the state's `recovery` names.
 *
 * Everything is a pure function of what the state machine already knows, so this
 * module needs no database and no window.
 */

/**
 * The banner's sentence, per state.
 *
 * Two of these are the app's own and are unchanged on purpose: the unconfigured
 * line is the model the rest follow (storage-neutral, an instruction, no server
 * named), and the offline line is the one D-B's fix made reachable more than
 * once. The `missing` line keeps the *consequence* half for the same reason the
 * offline one carries it — "editing is disabled" is the part a user has to know,
 * and the action is on the button rather than in the sentence.
 */
const MESSAGES: Record<NASState, string | null> = {
  connected: null,
  unconfigured: 'No library folder configured — choose where Musaeum should keep your books.',
  reconnecting: 'Reconnecting to the library…',
  disconnected: 'Library offline — browsing from cache, editing disabled.',
  missing: 'Library folder missing — browsing from cache, editing disabled.'
}

/**
 * The one-line status the sidebar row and the Settings row **both** render.
 *
 * One string for both rows, deliberately: they are the same fact, and the two
 * disagreeing is the defect D4 exists to remove. The sidebar's own label was
 * the only one of its four that carried a frame (`Library connected`), so the
 * shared word drops it — the sidebar column already says *Library* one row
 * above.
 */
const LABELS: Record<NASState, string> = {
  connected: 'Connected',
  unconfigured: 'Not configured',
  reconnecting: 'Reconnecting…',
  disconnected: 'Offline',
  missing: 'Folder missing'
}

/**
 * The one control a state offers, or null.
 *
 * `reconnecting` keeps the button's *place* so the row does not jump while an
 * attempt is in flight; the renderer's own in-flight flag is what disables it,
 * which is the one thing a status value cannot know.
 */
const RECOVERIES: Record<NASState, NASRecovery | null> = {
  connected: null,
  unconfigured: 'choose',
  reconnecting: 'retry',
  disconnected: 'retry',
  missing: 'locate'
}

/**
 * The words for a state, and the one control it offers.
 *
 * `kind` is not decoration: a `missing` root is a **local** one by
 * construction, because the state machine only sets `missing` where a mount
 * cannot help. A caller describing anything else is describing a share that is
 * away, and the retryable copy is the only honest answer for it — the same
 * asymmetry the resolver keeps when it claims `network` on positive evidence
 * only.
 */
export function storageStatusCopy(
  state: NASState,
  kind: StorageKind | null,
  nextRetryMs: number | null
): NASStatusCopy {
  const effective: NASState = state === 'missing' && kind === 'network' ? 'disconnected' : state
  const message = MESSAGES[effective]
  return {
    message:
      message === null || effective !== 'disconnected'
        ? message
        : `${message}${retryClause(nextRetryMs)}`,
    label: LABELS[effective],
    recovery: RECOVERIES[effective]
  }
}

/**
 * "Retrying in Ns." — absent, not empty, when nothing is armed.
 *
 * `nextRetryMs` is null for a `missing` root and null in the instant between
 * `disconnected` and its timer being armed, and the banner must not claim a
 * retry in either. This is the clause that stops the sentence lying.
 */
function retryClause(nextRetryMs: number | null): string {
  if (nextRetryMs === null) return ''
  return ` Retrying in ${Math.ceil(nextRetryMs / 1000)}s.`
}

/**
 * What kind of storage the library sits on, in the words a Settings row shows.
 *
 * Here rather than in the renderer because the kind travels as a fact and the
 * *name* for it is a word: a component rendering `local` verbatim would be the
 * second place the vocabulary lives, and the renderer may not import this
 * module across the bridge anyway.
 */
export function storageKindLabel(kind: StorageKind | null): string {
  if (kind === 'local') return 'Local folder'
  if (kind === 'network') return 'Network share'
  return 'Not known yet'
}

/**
 * The note under the storage-kind row.
 *
 * The unknown case is the stale one the *stored* kind exists to create (D1): a
 * library written before the key did, where the answer is not yet known — and
 * the row has to say that rather than guess a recovery for it.
 */
export function libraryKindDetail(kind: StorageKind | null): string {
  return kind
    ? 'Resolved from the folder when it was chosen'
    : 'Not resolved yet — the next time the library is reachable it will be'
}

/**
 * The note under the SMB field (D5).
 *
 * The unset case is the point: **nothing is compiled in any more**, so a
 * network library with nothing typed here is told what will *not* happen
 * instead of being shown someone else's hostname. This was the only place a
 * personal server name reached a user who had never set one — and, in
 * `nas-manager`'s mount fallback, the only place it silently *acted*.
 */
export function smbUrlDetail(configured: boolean): string {
  return configured
    ? 'Mounted automatically when the library folder goes missing'
    : 'No share set — the app will not mount one for you. Type the share here, or mount it yourself.'
}

/**
 * The one line Settings shows beside a root a cloud client syncs (D7).
 *
 * **Claims only what is known.** The catalog is last-write-wins, one machine at
 * a time (`docs/invariants/nas-and-catalog.md`), so a second machine writing the
 * same library can lose changes — true of every client here. The eviction
 * hazard is iCloud's own documented behaviour and is claimed for **iCloud
 * alone**: nothing measured says a Dropbox or Google Drive folder behaves the
 * same way, and guessing would be exactly the "unsupported" claim this copy
 * exists to avoid. The revival condition for turning it into a refusal is a
 * measurement, not a taste.
 */
export function syncRootNote(client: string): string {
  const shared = `This folder is synced by ${client} — a second machine writing the same library can lose changes.`
  return client === ICLOUD_DRIVE
    ? `${shared} iCloud may also remove a file’s contents until something opens it.`
    : shared
}
