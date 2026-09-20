import type { AskRequest, AiProbeRequest } from '@shared/ai.types'
import * as ai from '../services/ai'
import { handle } from './handle'

/**
 * The ask panel's three calls, plus Settings' Test.
 *
 * Thin wrappers, no logic (invariant 8): the client, the endpoint and the key
 * live in `services/ai.ts`, and everything a caller could get wrong here is
 * either a streamed event or a rejection that `handle()` turns into
 * `{ success: false }`.
 *
 * `ai:test` takes its endpoint, model and key as **arguments** rather than
 * reading `app_config`, because Settings' Test button answers for the values in
 * the form, before they are saved. See the slice plan
 * `docs/superpowers/plans/2026-09-20-reader-ai-config-slice4.md` §3 D3.4.
 */
export function registerAiHandlers(): void {
  handle('ai:getStatus', () => ai.getStatus())
  handle('ai:ask', (request: AskRequest) => ai.ask(request))
  handle('ai:cancel', (requestId: string) => ai.cancel(requestId))
  handle('ai:test', (request: AiProbeRequest) => ai.probe(request))
}
