import type { AskRequest } from '@shared/ai.types'
import * as ai from '../services/ai'
import { handle } from './handle'

/**
 * The ask panel's three calls. Thin wrappers, no logic (invariant 8): the
 * client, the endpoint and the key live in `services/ai.ts`, and everything a
 * caller could get wrong here is either a streamed event or a rejection that
 * `handle()` turns into `{ success: false }`.
 */
export function registerAiHandlers(): void {
  handle('ai:getStatus', () => ai.getStatus())
  handle('ai:ask', (request: AskRequest) => ai.ask(request))
  handle('ai:cancel', (requestId: string) => ai.cancel(requestId))
}
