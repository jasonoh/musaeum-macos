import type { RestApiListenStatus } from '@shared/settings.types'

/**
 * The one line the row shows about the socket — the whole of AC27's "live listen
 * status, including the reason when a bind failed".
 *
 * Read off `api/rest.ts`'s own record and nothing else: `listening` names the
 * address and port *the socket reported*, and every other state carries
 * `status.reason` **verbatim**. The reason's words belong to the module that
 * failed, and a second wording here is how a row ends up describing a failure the
 * server never had. With no reason, the line says only what it knows.
 *
 * `enabled` is the stored flag, and it is here for one state: `disabled` means
 * "the module recorded no listener", which is *usually* the switch being off but
 * can also be a stop that won a race with an enable — the row would then read
 * "the switch is off" beside a switch showing On. The flag is what tells the two
 * apart (`saveSettingsAndApply` has no queue, so the pair can overlap).
 *
 * It lives in `src/lib/` rather than in the component because the renderer has no
 * DOM harness in this repo: this wording is the one piece of row logic a case can
 * decide, and a case cannot reach inside a component.
 */
export function statusLine(status: RestApiListenStatus, enabled: boolean): string {
  if (status.state === 'listening') {
    return `Listening on ${status.address ?? 'an address it did not name'}:${status.port ?? '?'}`
  }
  if (status.state === 'starting') return 'Starting the listener…'
  if (status.state === 'disabled') {
    return enabled ? 'Not listening — the listener stopped' : 'Not listening — the switch is off'
  }
  return status.reason ? `Not listening — ${status.reason}` : 'Not listening'
}
