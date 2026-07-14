import { getConfig } from '../services/db'

/**
 * REST API stub — staged for the future iOS companion app.
 *
 * Disabled in MVP via the app_config flag `rest_api_enabled` (default false).
 * When activated, this module will expose the same service layer used by the
 * IPC handlers (electron/main/services/*) over HTTP — the services are
 * deliberately UI-agnostic so extraction to a standalone server stays cheap.
 */
export function startRestApiIfEnabled(): void {
  if (getConfig('rest_api_enabled') !== 'true') return
  console.warn('[rest] rest_api_enabled is set, but the REST API is not implemented yet (post-MVP)')
}
