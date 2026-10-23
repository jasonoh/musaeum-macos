import type { LexiconPreviewRequest } from '@shared/lexicon.types'
import type { TtsRequest, TtsWarmRequest } from '@shared/tts.types'
import * as tts from '../services/tts'
import { handle } from './handle'

/**
 * The speech engine's door (docs/superpowers/specs/2026-10-15-voice-reader-design.md, D3/D4).
 * Thin by rule (invariant 8): validation, the sidecar call and the progress rebroadcast are
 * all `services/tts.ts`'s, and a refusal reaches the renderer as the envelope's `error`.
 *
 * `preview` is here rather than on the lexicon's own namespace because it *is* a
 * synthesis — it speaks one word with a one-entry lexicon and writes nothing (D8).
 */
export function registerTtsHandlers(): void {
  handle('tts:status', () => tts.status())
  handle('tts:warm', (request: TtsWarmRequest) => tts.warm(request))
  handle('tts:synthesize', (request: TtsRequest) => tts.synthesize(request))
  handle('tts:preview', (request: LexiconPreviewRequest) => tts.preview(request))
  handle('tts:downloadModel', () => tts.downloadModel())
  handle('tts:cancelDownload', () => tts.cancelDownload())
}
