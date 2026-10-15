import { describe, expect, it } from 'vitest'
import {
  TTS_DEFAULT_VOICE,
  TTS_MODEL_ID,
  TTS_SPEED_MAX,
  TTS_SPEED_MIN,
  TTS_VOICES,
  clampTtsSpeed
} from './tts.types'

describe('the speech contract', () => {
  it('offers exactly the five voices Jason chose, and the default is one of them', () => {
    expect([...TTS_VOICES]).toEqual(['af_heart', 'af_bella', 'bf_emma', 'bm_george', 'am_michael'])
    expect(TTS_VOICES).toContain(TTS_DEFAULT_VOICE)
  })

  it('names the model, because a rendered file will stamp it', () => {
    expect(TTS_MODEL_ID).toBe('kokoro-v1.0-int8')
  })

  it('clamps a speed to 0.8-1.5 and rounds to a step of 0.1', () => {
    expect(clampTtsSpeed(5)).toBe(TTS_SPEED_MAX)
    expect(clampTtsSpeed(0.1)).toBe(TTS_SPEED_MIN)
    expect(clampTtsSpeed(1.04)).toBe(1.0)
    expect(clampTtsSpeed(1.26)).toBe(1.3)
    expect(clampTtsSpeed(Number.NaN)).toBe(1.0)
  })
})
