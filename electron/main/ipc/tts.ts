import type { TtsRequest } from '@shared/tts.types'
import * as tts from '../services/tts'
import { handle } from './handle'

/**
 * The speech engine's door (docs/superpowers/specs/2026-10-15-voice-reader-design.md, D3/D4).
 * Thin by rule (invariant 8): validation, the sidecar call and the progress rebroadcast are
 * all `services/tts.ts`'s, and a refusal reaches the renderer as the envelope's `error`.
 */
export function registerTtsHandlers(): void {
  handle('tts:status', () => tts.status())
  handle('tts:synthesize', (request: TtsRequest) => tts.synthesize(request))
  handle('tts:downloadModel', () => tts.downloadModel())
  handle('tts:cancelDownload', () => tts.cancelDownload())
}
