import type { LexiconSaveInput } from '@shared/lexicon.types'
import * as lexicon from '../services/lexicon'
import { handle } from './handle'

/**
 * The library's pronunciation list (`docs/superpowers/specs/2026-10-15-voice-reader-design.md`,
 * D8; slice annex `docs/superpowers/plans/2026-10-22-voice-reader-lexicon.md`). Thin by rule
 * (invariant 8): the cache, the queue, the re-read and every refusal sentence are
 * `services/lexicon.ts`'s, and a refusal reaches the renderer as the envelope's `error`.
 *
 * Preview is deliberately **not** here: it is a synthesis, so it lives on the `tts`
 * namespace (`ipc/tts.ts`) where the engine's own door already is.
 */
export function registerLexiconHandlers(): void {
  handle('lexicon:list', () => lexicon.list())
  handle('lexicon:save', (input: LexiconSaveInput) => lexicon.save(input))
  handle('lexicon:remove', (word: string) => lexicon.remove(word))
}
