import { describe, expect, it } from 'vitest'
import {
  AI_PROVIDERS,
  CUSTOM_PROVIDER_ID,
  endpointHint,
  hostOf,
  matchProvider,
  providerById
} from './ai-providers'

/**
 * The provider table and the deriver.
 *
 * The table's job is small and the deriver's job is smaller — but both are
 * *data the user acts on*: a row with a typo sends the reader's questions to
 * nothing, and a select that names the wrong row tells the user their requests
 * go somewhere they do not. So the walk over every row below is the point of
 * this file, not decoration.
 */

describe('matchProvider', () => {
  it('names the row a listed URL belongs to', () => {
    expect(matchProvider('https://api.openai.com/v1')).toBe('openai')
    expect(matchProvider('http://localhost:11434/v1')).toBe('ollama')
    expect(matchProvider('https://api.deepseek.com')).toBe('deepseek')
  })

  it('is unmoved by the spelling a hand-typed URL picks up', () => {
    // Case and a trailing slash are the two differences a person produces by
    // hand, and neither means anything to a server
    expect(matchProvider('HTTPS://API.OPENAI.COM/v1')).toBe('openai')
    expect(matchProvider('https://api.openai.com/v1/')).toBe('openai')
    expect(matchProvider('  https://api.openai.com/v1///  ')).toBe('openai')
  })

  it('reads Custom for a URL no row names', () => {
    // The state that matters when someone points the app at their own gateway
    expect(matchProvider('https://gateway.internal.example/v1')).toBe(CUSTOM_PROVIDER_ID)
    // A near miss is a miss: this URL has no /v1 and would 404
    expect(matchProvider('https://api.openai.com')).toBe(CUSTOM_PROVIDER_ID)
  })

  it('reads Custom for nothing at all', () => {
    // The caller resolves a blank field to the compiled-in default *before*
    // matching, so a blank here is genuinely unset rather than the default
    expect(matchProvider(null)).toBe(CUSTOM_PROVIDER_ID)
    expect(matchProvider('')).toBe(CUSTOM_PROVIDER_ID)
  })
})

describe('providerById', () => {
  it('never hands back an undefined row for a value off a select', () => {
    expect(providerById('groq').label).toBe('Groq')
    expect(providerById('nonsense').id).toBe(CUSTOM_PROVIDER_ID)
  })

  it('gives Custom no URL, which is what stops it being chosen', () => {
    // The select renders Custom as a disabled option: it is the *derived* state
    // for a URL we do not know, never a choice that would clear the field
    expect(providerById(CUSTOM_PROVIDER_ID).baseUrl).toBeNull()
  })
})

describe('AI_PROVIDERS', () => {
  it('offers exactly one row per provider, and one Custom', () => {
    const ids = AI_PROVIDERS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter((id) => id === CUSTOM_PROVIDER_ID)).toHaveLength(1)
    expect(AI_PROVIDERS.filter((p) => p.baseUrl === null)).toHaveLength(1)
  })

  it('gives every row a URL our own client can append /models to', () => {
    // The anti-drift walk: a row added with a typo, a trailing slash or a
    // scheme we never fetch is a row that fails in the user's hands, and this
    // is the only place that can catch it before it ships
    for (const row of AI_PROVIDERS) {
      if (row.baseUrl === null) continue
      expect(row.baseUrl, row.id).toMatch(/^https?:\/\/\S+$/)
      expect(() => new URL(row.baseUrl as string), row.id).not.toThrow()
      expect(row.baseUrl, row.id).not.toMatch(/\/$/)
      expect(row.baseUrl, row.id).not.toMatch(/\/(chat\/completions|models)$/)
      expect(row.label.length, row.id).toBeGreaterThan(0)
    }
  })

  it('lists the loopback servers first, which is the app posture', () => {
    // Local-first is the ask panel's standing promise, and the select's order
    // is where it is visible
    const firstCloud = AI_PROVIDERS.findIndex((p) => !p.local && p.baseUrl !== null)
    const lastLocal = AI_PROVIDERS.map((p) => p.local).lastIndexOf(true)
    expect(lastLocal).toBeLessThan(firstCloud)
    expect(AI_PROVIDERS.filter((p) => p.local).map((p) => p.id)).toEqual([
      'ollama',
      'lmstudio',
      'llamacpp'
    ])
    // And Custom is last, so it reads as the escape hatch rather than a peer
    expect(AI_PROVIDERS[AI_PROVIDERS.length - 1].id).toBe(CUSTOM_PROVIDER_ID)
  })

  it('does not ship Anthropic, deliberately', () => {
    // O3 (2026-09-20): Anthropic's OpenAI-compatibility layer is documented by
    // Anthropic as not production-ready, and its /v1/models wants x-api-key —
    // measured, it answers "x-api-key header is required" to the Bearer this
    // client sends. Claude is reachable through Custom.
    expect(AI_PROVIDERS.map((p) => p.id)).not.toContain('anthropic')
    expect(AI_PROVIDERS.some((p) => /anthropic|claude/i.test(p.baseUrl ?? ''))).toBe(false)
  })
})

describe('hostOf', () => {
  it('names the host without the path, and the input when it is not a URL', () => {
    expect(hostOf('https://api.openai.com/v1')).toBe('api.openai.com')
    expect(hostOf('http://localhost:11434/v1')).toBe('localhost:11434')
    expect(hostOf(null)).toBeNull()
    expect(hostOf('not a url')).toBe('not a url')
  })
})

describe('endpointHint', () => {
  const stored = {
    value: 'https://api.openai.com/v1',
    source: 'configured' as const,
    detail: 'api.openai.com receives what you send'
  }
  const fallback = {
    value: 'http://localhost:11434/v1',
    source: 'default' as const,
    detail: 'Default — a local model on this machine · Local — nothing leaves this machine'
  }

  it('hands the value in force to the main process to describe', () => {
    // The egress sentence is `describeEndpoint()`'s, computed once, in main.
    // This function only decides *which* value the line is about.
    expect(endpointHint(stored.value as string, stored)).toBe(stored.detail)
    expect(endpointHint('', fallback)).toBe(fallback.detail)
  })

  it('says when the value on screen is not the value in force', () => {
    // The one thing the renderer knows and main does not — and the sentence the
    // Provider select used to contradict, mid-edit, with a form-derived copy
    expect(endpointHint('https://openrouter.ai/api/v1', stored)).toBe(
      'Unsaved — the reader still sends to api.openai.com until you save.'
    )
    expect(endpointHint('https://openrouter.ai/api/v1', fallback)).toBe(
      'Unsaved — the reader still sends to localhost:11434 until you save.'
    )
  })

  it('explains a blank field that is about to clear something', () => {
    // Blank means "back to auto-detection" in this dialog, and for the endpoint
    // that is the compiled-in local default — which the renderer cannot name,
    // so it does not try
    expect(endpointHint('   ', stored)).toMatch(/goes back to the built-in local default/)
    expect(endpointHint('   ', fallback)).toBe(fallback.detail)
  })
})
