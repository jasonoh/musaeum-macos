import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EVENT_CHANNELS } from '@shared/api.types'
import type { AiChunkEvent, AiDoneEvent, AiErrorEvent } from '@shared/ai.types'
import {
  AI_CONFIG_KEYS,
  AI_ENV_KEYS,
  DEFAULT_AI_BASE_URL,
  PROBE_MODEL_CAP,
  ask,
  cancel,
  createSseParser,
  getStatus,
  isLoopback,
  parseModelIds,
  probe,
  readChunk,
  resolveBaseUrl,
  resolveKey,
  resolveModel
} from './ai'
import { closeDb, setConfig } from './db'
import { setMainWindow } from './events'

/**
 * The AI client's suite.
 *
 * The streaming half runs against a **real** HTTP server and a real `fetch`
 * rather than a mocked one: chunk boundaries, the abort path, the idle deadline
 * and the errno a refused connection produces all come from the genuine stack,
 * and those are precisely the things this file is here to pin down. Events are
 * observed on the **real** event bus through a stand-in window, so a wrong
 * channel name is a failure here rather than a silent one in the app.
 */

interface Captured {
  channel: string
  payload: unknown
}

let captured: Captured[] = []
let servers: Server[] = []

beforeEach(() => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
  captured = []
  servers = []
  setMainWindow({
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        captured.push({ channel, payload })
      }
    }
  } as unknown as Parameters<typeof setMainWindow>[0])
})

afterEach(async () => {
  setMainWindow(null)
  vi.unstubAllEnvs()
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((done) => {
          // undici pools connections, so a keep-alive socket would keep
          // `close()` from ever calling back
          server.closeAllConnections()
          server.close(() => done())
        })
    )
  )
})

// ---------------------------------------------------------------------------
// Stub endpoint
// ---------------------------------------------------------------------------

interface Stub {
  url: string
  /** The server itself, so a case can close it and probe a dead port. */
  server: Server
  /** Everything the client posted, for asserting on the request itself. */
  requests: { url: string; headers: IncomingMessage['headers']; body: unknown }[]
}

/** A real server on an ephemeral port, so tests can run in parallel. */
async function startStub(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<Stub> {
  const requests: Stub['requests'] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
    req.on('end', () => {
      requests.push({ url: req.url ?? '', headers: req.headers, body: parse(body) })
      handler(req, res)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/v1`, server, requests }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** One OpenAI-compatible delta, as JSON — the payload inside an SSE event. */
function payload(text: string): string {
  return JSON.stringify({ choices: [{ delta: { content: text } }] })
}

/** The same delta as SSE, which is what the endpoint actually writes. */
function chunk(text: string): string {
  return `data: ${payload(text)}\n\n`
}

function configure(stub: Stub, model = 'test-model'): void {
  setConfig(AI_CONFIG_KEYS.baseUrl, stub.url)
  setConfig(AI_CONFIG_KEYS.model, model)
}

function eventsFor(requestId: string, channel: string): unknown[] {
  return captured
    .filter((c) => c.channel === channel && sameRequest(c.payload, requestId))
    .map((c) => c.payload)
}

function sameRequest(payload: unknown, requestId: string): boolean {
  return (payload as { requestId?: string }).requestId === requestId
}

async function waitForTerminal(requestId: string): Promise<{ channel: string; payload: unknown }> {
  await vi.waitFor(
    () => {
      const terminal = captured.find(
        (c) =>
          (c.channel === EVENT_CHANNELS.aiDone || c.channel === EVENT_CHANNELS.aiError) &&
          sameRequest(c.payload, requestId)
      )
      expect(terminal).toBeDefined()
    },
    { timeout: 5_000, interval: 10 }
  )
  return captured.find(
    (c) =>
      (c.channel === EVENT_CHANNELS.aiDone || c.channel === EVENT_CHANNELS.aiError) &&
      sameRequest(c.payload, requestId)
  ) as { channel: string; payload: unknown }
}

function askOnce(requestId: string, text = 'who is this?'): void {
  ask({ requestId, mode: 'ask', messages: [{ role: 'user', content: text }] })
}

// ---------------------------------------------------------------------------
// The parser and the chunk reader (both pure)
// ---------------------------------------------------------------------------

describe('createSseParser', () => {
  it('returns nothing until an event is complete', () => {
    const parser = createSseParser()
    expect(parser.push('data: {"a"')).toEqual([])
    expect(parser.push(':1}')).toEqual([])
    expect(parser.push('\n\n')).toEqual([{ event: 'message', data: '{"a":1}' }])
  })

  it('splits several events out of one chunk', () => {
    const parser = createSseParser()
    const events = parser.push('data: one\n\ndata: two\n\ndata: three\n\n')
    expect(events.map((e) => e.data)).toEqual(['one', 'two', 'three'])
  })

  it('handles CRLF, comments and keep-alives', () => {
    const parser = createSseParser()
    // A heartbeat is a comment line, not an event
    expect(parser.push(': ping\r\n\r\n')).toEqual([])
    expect(parser.push('data: hello\r\n\r\n')).toEqual([{ event: 'message', data: 'hello' }])
  })

  it('keeps a CRLF split across chunks together', () => {
    const parser = createSseParser()
    expect(parser.push('data: x\r')).toEqual([])
    expect(parser.push('\n\r\n')).toEqual([{ event: 'message', data: 'x' }])
  })

  it('joins multi-line data and carries an event name', () => {
    const parser = createSseParser()
    expect(parser.push('event: done\ndata: a\ndata: b\n\n')).toEqual([
      { event: 'done', data: 'a\nb' }
    ])
  })

  it('flushes an event that arrived without its final blank line', () => {
    const parser = createSseParser()
    expect(parser.push('data: tail')).toEqual([])
    expect(parser.flush()).toEqual([{ event: 'message', data: 'tail' }])
  })
})

describe('readChunk', () => {
  it('reads a delta', () => {
    expect(readChunk(payload('hello'))).toEqual({ kind: 'delta', text: 'hello' })
  })

  it('treats [DONE] as the end of the stream', () => {
    expect(readChunk('[DONE]')).toEqual({ kind: 'done', reason: 'stop' })
  })

  it('reports a truncated answer', () => {
    const data = JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })
    expect(readChunk(data)).toEqual({ kind: 'done', reason: 'length' })
  })

  it('prefers content over a finish reason in the same chunk', () => {
    // The reason arrives again on its own; a dropped token would not
    const data = JSON.stringify({
      choices: [{ delta: { content: 'x' }, finish_reason: 'length' }]
    })
    expect(readChunk(data)).toEqual({ kind: 'delta', text: 'x' })
  })

  it('surfaces an error object', () => {
    const data = JSON.stringify({ error: { message: "model 'nope' not found" } })
    expect(readChunk(data)).toEqual({ kind: 'error', message: "model 'nope' not found" })
  })

  it('ignores what it cannot read rather than killing the answer', () => {
    expect(readChunk('{"choices": [')).toEqual({ kind: 'ignore' })
    expect(readChunk('')).toEqual({ kind: 'ignore' })
    expect(readChunk(JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] }))).toEqual({
      kind: 'ignore'
    })
  })
})

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe('resolution', () => {
  it('defaults the endpoint to a local model and reports where it came from', () => {
    const endpoint = resolveBaseUrl()
    expect(endpoint.value).toBe(DEFAULT_AI_BASE_URL)
    expect(endpoint.source).toBe('default')
    expect(endpoint.unusable).toBeNull()
  })

  it('takes a configured endpoint over the environment', () => {
    vi.stubEnv(AI_ENV_KEYS.baseUrl, 'http://127.0.0.1:9999/v1')
    setConfig(AI_CONFIG_KEYS.baseUrl, 'http://127.0.0.1:8080/v1/')
    expect(resolveBaseUrl()).toMatchObject({
      value: 'http://127.0.0.1:8080/v1',
      source: 'configured'
    })
  })

  it('falls back to the environment, then to a blank', () => {
    vi.stubEnv(AI_ENV_KEYS.model, 'from-env')
    expect(resolveModel()).toEqual({ value: 'from-env', source: 'env' })
    vi.unstubAllEnvs()
    expect(resolveModel()).toEqual({ value: null, source: 'none' })
    expect(resolveKey().source).toBe('none')
  })

  it('degrades an unusable stored endpoint back to the default, and says so', () => {
    // The rule `theme_tokens` already follows: re-validated on every read,
    // never thrown from a read path
    setConfig(AI_CONFIG_KEYS.baseUrl, 'file:///etc/passwd')
    const endpoint = resolveBaseUrl()
    expect(endpoint.value).toBe(DEFAULT_AI_BASE_URL)
    expect(endpoint.source).toBe('default')
    expect(endpoint.unusable).toBe('file:///etc/passwd')
    expect(getStatus().endpoint.detail).toContain('is not an http(s) URL')
  })

  it.each([
    ['http://localhost:11434/v1', true],
    ['http://127.0.0.1:1234/v1', true],
    ['http://127.0.0.53:1234/v1', true],
    ['http://[::1]:8080/v1', true],
    ['http://192.168.1.5:1234/v1', false],
    ['http://nashost.local:1234/v1', false],
    ['https://api.example.com/v1', false],
    ['not a url', false]
  ])('isLoopback(%s) is %s', (url, expected) => {
    expect(isLoopback(url)).toBe(expected)
  })
})

describe('getStatus', () => {
  it('is unavailable, with a reason, until a model is set', () => {
    const status = getStatus()
    expect(status.configured).toBe(false)
    expect(status.reason).toMatch(/No model set/)
    expect(status.endpoint.value).toBe(DEFAULT_AI_BASE_URL)
    expect(status.endpoint.detail).toContain('nothing leaves this machine')
    expect(status.isLocal).toBe(true)
    expect(status.hasKey).toBe(false)
  })

  it('is configured once a model is set, and names a remote host', () => {
    setConfig(AI_CONFIG_KEYS.model, 'llama3.2')
    setConfig(AI_CONFIG_KEYS.baseUrl, 'https://api.example.com/v1')
    setConfig(AI_CONFIG_KEYS.apiKey, 'secret-value-1234')
    const status = getStatus()
    expect(status.configured).toBe(true)
    expect(status.reason).toBeNull()
    expect(status.isLocal).toBe(false)
    expect(status.endpoint.detail).toContain('api.example.com receives what you send')
    expect(status.hasKey).toBe(true)
    // The key itself is never in the status the renderer can read
    expect(JSON.stringify(status)).not.toContain('secret-value-1234')
  })
})

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

describe('ask', () => {
  it('streams deltas in order, posts what it should, and ends exactly once', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(chunk('Hello'))
      res.write(chunk(' world'))
      res.end('data: [DONE]\n\n')
    })
    configure(stub)

    askOnce('req-1')
    const terminal = await waitForTerminal('req-1')

    expect(terminal.channel).toBe(EVENT_CHANNELS.aiDone)
    expect((terminal.payload as AiDoneEvent).reason).toBe('stop')
    expect(eventsFor('req-1', EVENT_CHANNELS.aiError)).toHaveLength(0)
    expect(
      eventsFor('req-1', EVENT_CHANNELS.aiChunk).map((p) => (p as AiChunkEvent).delta)
    ).toEqual(['Hello', ' world'])

    // The request the endpoint actually saw
    expect(stub.requests).toHaveLength(1)
    expect(stub.requests[0].url).toBe('/v1/chat/completions')
    expect(stub.requests[0].body).toMatchObject({ model: 'test-model', stream: true })
    expect(stub.requests[0].headers.authorization).toBeUndefined()
  })

  it('sends the key as a bearer token when one is set', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: [DONE]\n\n')
    })
    configure(stub)
    setConfig(AI_CONFIG_KEYS.apiKey, 'sk-test-key-1234')

    askOnce('req-key')
    await waitForTerminal('req-key')
    expect(stub.requests[0].headers.authorization).toBe('Bearer sk-test-key-1234')
  })

  it('releases its slot when it settles, so a late cancel is a no-op', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: [DONE]\n\n')
    })
    configure(stub)

    askOnce('req-released')
    await waitForTerminal('req-released')
    await vi.waitFor(() => expect(cancel('req-released')).toBe(false))
    expect(cancel('req-never-started')).toBe(false)
  })

  it('cancels mid-stream as an outcome, not an error', async () => {
    let closed = false
    const stub = await startStub((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(chunk('one'))
      req.on('close', () => (closed = true))
    })
    configure(stub)

    askOnce('req-cancel')
    await vi.waitFor(() => expect(eventsFor('req-cancel', EVENT_CHANNELS.aiChunk)).toHaveLength(1))

    expect(cancel('req-cancel')).toBe(true)
    const terminal = await waitForTerminal('req-cancel')
    expect(terminal.channel).toBe(EVENT_CHANNELS.aiDone)
    expect((terminal.payload as AiDoneEvent).reason).toBe('cancelled')
    expect(eventsFor('req-cancel', EVENT_CHANNELS.aiError)).toHaveLength(0)
    await vi.waitFor(() => expect(closed).toBe(true))
  })

  it('ends an idle stream instead of hanging on it', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(chunk('half an answer'))
      // …and then nothing, ever
    })
    configure(stub)

    ask(
      { requestId: 'req-idle', mode: 'ask', messages: [{ role: 'user', content: 'hi' }] },
      {
        idleTimeoutMs: 80
      }
    )
    const terminal = await waitForTerminal('req-idle')
    expect(terminal.channel).toBe(EVENT_CHANNELS.aiDone)
    expect((terminal.payload as AiDoneEvent).reason).toBe('timeout')
    expect(eventsFor('req-idle', EVENT_CHANNELS.aiChunk)).toHaveLength(1)
  })

  it('diagnoses a refused connection as one', async () => {
    const stub = await startStub((_req, res) => res.end())
    // A port nothing is listening on: bind one, then let it go
    const { url } = stub
    await new Promise<void>((done) => servers.pop()?.close(() => done()))

    setConfig(AI_CONFIG_KEYS.baseUrl, url)
    setConfig(AI_CONFIG_KEYS.model, 'test-model')
    askOnce('req-refused')

    const terminal = await waitForTerminal('req-refused')
    expect(terminal.channel).toBe(EVENT_CHANNELS.aiError)
    expect((terminal.payload as AiErrorEvent).message).toMatch(/Nothing is listening at/)
    expect((terminal.payload as AiErrorEvent).message).toMatch(/model server running\?/)
  })

  it('reports a rejected key as a rejected key', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }))
    })
    configure(stub)
    askOnce('req-401')

    const terminal = await waitForTerminal('req-401')
    expect(terminal.channel).toBe(EVENT_CHANNELS.aiError)
    expect((terminal.payload as AiErrorEvent).message).toMatch(/rejected the key/)
  })

  it('passes on the endpoint’s own explanation of a bad request', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: "model 'test-model' not found" } }))
    })
    configure(stub)
    askOnce('req-400')

    const terminal = await waitForTerminal('req-400')
    expect(terminal.channel).toBe(EVENT_CHANNELS.aiError)
    expect((terminal.payload as AiErrorEvent).message).toBe(
      `${stub.url} answered HTTP 400 (model test-model): model 'test-model' not found`
    )
  })

  it('refuses to ask without a model, without calling anything', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: [DONE]\n\n')
    })
    setConfig(AI_CONFIG_KEYS.baseUrl, stub.url)
    askOnce('req-no-model')

    const terminal = await waitForTerminal('req-no-model')
    expect(terminal.channel).toBe(EVENT_CHANNELS.aiError)
    expect((terminal.payload as AiErrorEvent).message).toMatch(/No model is set/)
    expect(stub.requests).toHaveLength(0)
  })

  it('rejects a duplicate id, an empty request and an oversized one', async () => {
    // Pointed at a port nothing is listening on, so the first ask cannot leave
    // the machine while the "already in flight" check is what is under test
    const stub = await startStub((_req, res) => res.end())
    setConfig(AI_CONFIG_KEYS.baseUrl, stub.url)
    setConfig(AI_CONFIG_KEYS.model, 'test-model')

    askOnce('req-dup')
    expect(() => askOnce('req-dup')).toThrow(/already in flight/)
    cancel('req-dup')

    expect(() => ask({ requestId: 'req-empty', mode: 'ask', messages: [] })).toThrow(
      /at least one message/
    )
    expect(() => ask({ requestId: '', mode: 'ask', messages: [] })).toThrow(/request id/)
    expect(() =>
      ask({
        requestId: 'req-big',
        mode: 'ask',
        messages: [{ role: 'user', content: 'x'.repeat(200_001) }]
      })
    ).toThrow(/too large to send/)
  })
})

// ---------------------------------------------------------------------------
// The probe — Settings' Test button
// ---------------------------------------------------------------------------

/**
 * The verdict ladder, against a real server, one rung per case.
 *
 * The three rungs that are *not* about the key are the ones worth having: a
 * 403 is measured to arrive from a network block with no key involved
 * (`api.groq.com/openai/v1/models`, 2026-09-20), and a 404 on `/models` is a
 * documented, shipped shape (`gemini`). Both would read as "your key is bad"
 * under a naive 401/403/404 mapping, and telling someone to regenerate a key
 * that works is the failure this ladder exists to prevent.
 */
describe('probe', () => {
  /** A model list in the shape every OpenAI-compatible row answers with. */
  const LIST = JSON.stringify({
    object: 'list',
    data: [{ id: 'gpt-a' }, { id: 'gpt-b' }]
  })

  async function probeStub(status: number, body: string, type = 'application/json'): Promise<Stub> {
    return startStub((_req, res) => {
      res.writeHead(status, { 'content-type': type })
      res.end(body)
    })
  }

  it('accepts a key and reports the models the endpoint lists', async () => {
    const stub = await probeStub(200, LIST)
    const result = await probe({ baseUrl: stub.url, model: null, apiKey: 'sk-good' })

    expect(result.verdict).toBe('ok')
    expect(result.models).toEqual(['gpt-a', 'gpt-b'])
    expect(result.modelCount).toBe(2)
    expect(result.modelOffered).toBeNull()
    expect(result.message).toContain('accepted the key')
  })

  it('asks for the model list and nothing else, and carries the key as a bearer', async () => {
    const stub = await probeStub(200, LIST)
    await probe({ baseUrl: stub.url, model: 'gpt-a', apiKey: 'sk-good' })

    expect(stub.requests).toHaveLength(1)
    expect(stub.requests[0].url).toBe('/v1/models')
    expect(stub.requests[0].body).toBeNull()
    expect(stub.requests[0].headers.authorization).toBe('Bearer sk-good')
  })

  it('sends no authorization header when no key is set, and says which that is', async () => {
    // No app_config key and no env key: the 401 is the endpoint asking for a
    // key, not rejecting one, and the two sentences go to different places
    const stub = await probeStub(401, '{"error":{"message":"Missing bearer authentication"}}')
    const result = await probe({ baseUrl: stub.url, model: null, apiKey: null })

    expect(stub.requests[0].headers.authorization).toBeUndefined()
    expect(result.hasKey).toBe(false)
    expect(result.verdict).toBe('rejected')
    expect(result.message).toMatch(/wants a key .*none is set/)
    expect(result.message).not.toMatch(/rejected the key/)
  })

  it('reads a 401 with a key as the key being rejected, in the endpoint own words', async () => {
    const stub = await probeStub(401, '{"error":{"message":"Incorrect API key provided"}}')
    const result = await probe({ baseUrl: stub.url, model: null, apiKey: 'sk-bad' })

    expect(result.verdict).toBe('rejected')
    expect(result.hasKey).toBe(true)
    expect(result.message).toContain('rejected the key')
    expect(result.message).toContain('Incorrect API key provided')
    // The endpoint's own sentence ends in a full stop and so does the line —
    // measured live against api.openai.com, which shipped `…/api-keys..`
    expect(result.message).not.toMatch(/\.\./)
  })

  it('claims no key was accepted when none was sent', async () => {
    // OpenRouter lists its models to anyone (measured live 2026-09-20, 446 of
    // them unkeyed), so a 200 is not evidence about a key that was never sent
    const stub = await probeStub(200, LIST)
    const result = await probe({ baseUrl: stub.url, model: null, apiKey: null })

    expect(result.hasKey).toBe(false)
    expect(result.message).toContain('answered (no key was sent)')
    expect(result.message).not.toContain('accepted the key')
  })

  it('closes a sentence the endpoint left open, without doubling a full stop', async () => {
    const open = await probeStub(403, '{"error":{"message":"Access denied"}}')
    const noStop = await probe({ baseUrl: open.url, model: null, apiKey: null })
    expect(noStop.message).toMatch(/Access denied\.$/)

    const stopped = await probeStub(403, '{"error":{"message":"Access denied."}}')
    const withStop = await probe({ baseUrl: stopped.url, model: null, apiKey: null })
    expect(withStop.message).toMatch(/Access denied\.$/)
    expect(withStop.message).not.toMatch(/\.\./)
  })

  it('reads a 403 as refused, never as a rejected key', async () => {
    // The measured shape: a network block, with no key involved at all
    const stub = await probeStub(
      403,
      '{"error":{"message":"Access denied. Please check your network settings."}}'
    )
    const result = await probe({ baseUrl: stub.url, model: null, apiKey: 'sk-fine' })

    expect(result.verdict).toBe('refused')
    expect(result.message).toContain('refused the request (HTTP 403)')
    expect(result.message).toContain('Access denied')
    expect(result.message).not.toMatch(/rejected the key/)
  })

  it('reads a 404 on /models as no model list, and says the key was not checked', async () => {
    // Gemini's documented OpenAI-compatible /models answers 404 (measured
    // 2026-09-20), so this rung is a shipped row's normal state
    const stub = await probeStub(404, '{"error":{"message":"Requested entity was not found."}}')
    const result = await probe({ baseUrl: stub.url, model: null, apiKey: 'sk-fine' })

    expect(result.verdict).toBe('no-model-list')
    expect(result.url).toBe(`${stub.url}/models`)
    expect(result.message).toMatch(/the key was not checked/)
  })

  it('treats a 405 and a 501 the same way as a 404', async () => {
    for (const status of [405, 501]) {
      const stub = await probeStub(status, '')
      const result = await probe({ baseUrl: stub.url, model: null, apiKey: null })
      expect(result.verdict).toBe('no-model-list')
    }
  })

  it('describes a connection nothing is listening on', async () => {
    // A port that is genuinely closed. Port 9 is not usable here: Node refuses
    // it as a bad port, so the failure arrives as "fetch failed" with no errno
    // at all — which is a real finding about the diagnosis, and not the case
    // this criterion is about.
    const stub = await startStub((_req, res) => res.end())
    await new Promise<void>((done) => {
      stub.server.closeAllConnections()
      stub.server.close(() => done())
    })

    const result = await probe({ baseUrl: stub.url, model: null, apiKey: null })

    expect(result.verdict).toBe('unreachable')
    expect(result.message).toMatch(/Nothing is listening/)
    expect(result.message).not.toContain('ECONNREFUSED')
  })

  it('reports a timeout rather than hanging, and names the deadline it waited', async () => {
    const stub = await startStub((_req, res) => {
      // Answers nothing, ever — the idle endpoint a probe must give up on
      res.writeHead(200, { 'content-type': 'application/json' })
      void res
    })
    const result = await probe({ baseUrl: stub.url, model: null, apiKey: null }, { timeoutMs: 120 })

    expect(result.verdict).toBe('timeout')
    expect(result.message).toMatch(/did not answer within/)
  })

  it('distinguishes an empty list from an unreadable one', async () => {
    const empty = await probeStub(200, '{"object":"list","data":[]}')
    const emptyResult = await probe({ baseUrl: empty.url, model: null, apiKey: null })
    expect(emptyResult.verdict).toBe('ok')
    expect(emptyResult.message).toMatch(/lists no models yet/)

    const nonsense = await probeStub(200, '<html>not json</html>', 'text/html')
    const nonsenseResult = await probe({ baseUrl: nonsense.url, model: null, apiKey: null })
    expect(nonsenseResult.verdict).toBe('ok')
    expect(nonsenseResult.message).toMatch(/didn't parse/)
  })

  it('sorts, dedupes and caps the list, and reports the total it capped', async () => {
    const many = Array.from({ length: PROBE_MODEL_CAP + 50 }, (_v, i) => ({
      // Reversed order and a duplicate, so sorting and deduping both have work
      id: `model-${String(PROBE_MODEL_CAP + 49 - i).padStart(3, '0')}`
    }))
    many.push({ id: 'model-000' })
    const stub = await probeStub(200, JSON.stringify({ data: many }))
    const result = await probe({ baseUrl: stub.url, model: null, apiKey: null })

    expect(result.models).toHaveLength(PROBE_MODEL_CAP)
    expect(result.modelCount).toBe(PROBE_MODEL_CAP + 50)
    expect(result.models[0]).toBe('model-000')
    expect(result.models).toEqual([...result.models].sort((a, b) => a.localeCompare(b)))
    expect(new Set(result.models).size).toBe(PROBE_MODEL_CAP)
  })

  it('answers whether the model asked about is one the endpoint offers', async () => {
    const stub = await probeStub(200, LIST)

    const offered = await probe({ baseUrl: stub.url, model: 'gpt-b', apiKey: null })
    expect(offered.modelOffered).toBe(true)
    expect(offered.message).toContain('gpt-b is one of the 2')

    const missing = await probe({ baseUrl: stub.url, model: 'gpt-zzz', apiKey: null })
    expect(missing.modelOffered).toBe(false)
    expect(missing.message).toMatch(/doesn't list gpt-zzz/)
  })

  it('reports a base URL that is not a URL instead of fetching it', async () => {
    const result = await probe({ baseUrl: 'api.openai.com', model: null, apiKey: null })

    expect(result.verdict).toBe('unreachable')
    expect(result.message).toMatch(/Not an endpoint URL/)
  })

  it('uses the key in the environment when the form carries none', async () => {
    // An env key is invisible to the renderer, so a Test that reported "none is
    // set" while the reader posted with it would answer a different question
    vi.stubEnv(AI_ENV_KEYS.apiKey, 'sk-from-env')
    const stub = await probeStub(401, '{"error":{"message":"nope"}}')
    const result = await probe({ baseUrl: stub.url, model: null, apiKey: null })

    expect(stub.requests[0].headers.authorization).toBe('Bearer sk-from-env')
    expect(result.hasKey).toBe(true)
    expect(result.message).toContain('rejected the key')
  })

  it('reads the model list out of every shape an OpenAI-compatible server sends', () => {
    expect(parseModelIds('{"data":[{"id":"a"}]}')).toEqual(['a'])
    expect(parseModelIds('["a","b"]')).toEqual(['a', 'b'])
    expect(parseModelIds('{"models":[{"name":"a"}]}')).toEqual(['a'])
    expect(parseModelIds('{"data":[{"id":"a"},{"nope":1},null]}')).toEqual(['a'])
    // Not a list at all — a different answer from an empty list
    expect(parseModelIds('<html>x</html>')).toBeNull()
    expect(parseModelIds('{"data":{}}')).toBeNull()
  })
})
