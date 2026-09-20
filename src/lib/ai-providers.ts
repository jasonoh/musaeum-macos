/**
 * The provider picker's table.
 *
 * A provider here is **a base URL and a label** — nothing else. Choosing one
 * writes the URL into the Endpoint field, and that is the whole of its job:
 * the three `app_config` keys stay exactly as the ask panel's spec defines
 * them (`ai_base_url` / `ai_model` / `ai_api_key`), no new key is stored, and
 * the selection is *derived* from the stored URL rather than remembered beside
 * it (`matchProvider` below). Two representations of one fact can disagree
 * silently; one cannot.
 *
 * **This file is renderer-only, and that is load-bearing.** The parent spec's
 * D3 promises "no provider enumeration in the schema, no per-vendor branch in
 * the client": `electron/main/services/ai.ts` knows a URL, a model and a key,
 * and no vendor at all. Nothing in `electron/main/` may import this module.
 *
 * Every URL below was probed from this machine on 2026-09-20 with an
 * unauthenticated `GET {base}/models` — an unauthenticated 401 proves the host
 * and the route exist. The results, and the two rows that surprised:
 *
 * | Row      | `{base}/models` |                        |
 * | -------- | --------------- | ---------------------- |
 * | OpenAI   | 401             | exists                 |
 * | Gemini   | **404**         | its *documented* route is absent |
 * | xAI      | 401             | exists                 |
 * | Groq     | **403**         | network-blocked, not a key problem |
 * | OpenRouter | 200           | lists without a key    |
 * | DeepSeek | 401             | exists; body is not JSON |
 * | Mistral  | 401             | exists; error carries `detail` |
 *
 * The consequence of the Gemini row is deliberate and recorded in the slice
 * plan (§2 O2): an endpoint with no model list cannot be tested by a probe
 * that *is* the model list, and it says so instead of blaming the key.
 *
 * **Anthropic is not a row.** Its OpenAI-compatibility layer is documented by
 * Anthropic as "not considered a long-term or production-ready solution", and
 * its `/v1/models` wants `x-api-key` — probed 2026-09-20, it answers
 * `x-api-key header is required` to the `Authorization: Bearer` this client
 * sends. Claude is reachable through **Custom**.
 */

import type { SettingSource } from '@shared/settings.types'

export interface AiProvider {
  id: string
  label: string
  /** Null only for Custom: the row that means "I will type the URL myself". */
  baseUrl: string | null
  /** Loopback, so choosing this row keeps the app's egress at exactly zero. */
  local: boolean
}
export const CUSTOM_PROVIDER_ID = 'custom'

/**
 * The table. Order is the select's order: the loopback servers first, because
 * a local model is this app's stated posture ("no account, no service, no
 * listener"), then the cloud endpoints, then the escape hatch.
 */
export const AI_PROVIDERS: AiProvider[] = [
  { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', local: true },
  { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', local: true },
  { id: 'llamacpp', label: 'llama.cpp / vLLM', baseUrl: 'http://localhost:8080/v1', local: true },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', local: false },
  {
    id: 'gemini',
    label: 'Google Gemini',
    // Google's own OpenAI-compatibility base; our client appends
    // `/chat/completions` and `/models` to it.
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    local: false
  },
  { id: 'xai', label: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', local: false },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', local: false },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', local: false },
  // No `/v1`: DeepSeek's documented OpenAI base is the bare host, and our
  // client posts to `{base}/chat/completions` — which is what their docs curl.
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', local: false },
  { id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', local: false },
  { id: CUSTOM_PROVIDER_ID, label: 'Custom', baseUrl: null, local: false }
]

/**
 * Normalize a URL for comparison only — never for storage or for the request.
 * Case and a trailing slash are the two differences a user can produce by
 * hand and never mean anything to a server.
 */
function normalize(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase()
}

/**
 * Which row the stored endpoint corresponds to — the *whole* of the picker's
 * state. A URL no row names (including one the user typed, and including a
 * blank, which resolves to the compiled-in localhost default) is `custom`.
 */
export function matchProvider(baseUrl: string | null): string {
  if (!baseUrl) return CUSTOM_PROVIDER_ID
  const needle = normalize(baseUrl)
  const row = AI_PROVIDERS.find((p) => p.baseUrl !== null && normalize(p.baseUrl) === needle)
  return row?.id ?? CUSTOM_PROVIDER_ID
}

/** The row a provider id names, or Custom — a select value is not trusted. */
export function providerById(id: string): AiProvider {
  return AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[AI_PROVIDERS.length - 1]
}

/**
 * A URL's host, for a sentence that has to name where requests go — never the
 * whole URL, which is long and often says less. `null` when there is no URL.
 */
export function hostOf(baseUrl: string | null): string | null {
  if (!baseUrl) return null
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

/**
 * The Endpoint field's own line.
 *
 * The egress sentence belongs to the main process — `describeEndpoint()` in
 * `services/ai.ts` is the one place that computes it, and this file refuses to
 * re-derive it (the rule `services/settings.ts` states for Python and Calibre).
 * What the renderer knows and main does not is whether the value on screen is
 * the value in force, and that is the whole of this function's job. Written as
 * a pure function because a *second* egress line is what this replaced: the
 * Provider select carried a form-derived "Requests go to X" beside the field's
 * stored-derived "Y receives what you send", and mid-edit the two contradicted
 * each other on the same screen — one of them about where the book's own text
 * travels.
 */
export function endpointHint(
  formBaseUrl: string,
  resolved: { value: string | null; source: SettingSource; detail?: string }
): string | undefined {
  const form = formBaseUrl.trim()
  if (!form) {
    return resolved.source === 'configured'
      ? 'Blank — this goes back to the built-in local default when you save.'
      : resolved.detail
  }
  if (form === resolved.value) return resolved.detail
  return `Unsaved — the reader still sends to ${hostOf(resolved.value)} until you save.`
}
