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
  ask,
  cancel,
  createSseParser,
  getStatus,
  isLoopback,
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
  return { url: `http://127.0.0.1:${port}/v1`, requests }
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
