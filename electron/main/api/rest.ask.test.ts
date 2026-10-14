import { rmSync } from 'fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { AI_CONFIG_KEYS } from '../services/ai'
import { ASK_BODY_MAX_BYTES } from '../services/api/ask'
import * as db from '../services/db'
import { setMainWindow } from '../services/events'
import { createRestApiServer } from './rest'

/**
 * `POST /api/ai/ask` over a real socket, against a stub OpenAI-compatible
 * endpoint. No model is needed and the NAS is not involved: the relay reads one
 * book row and talks to the stub. Events the desktop window would receive are
 * captured on a stand-in window so "a phone's ask never paints into the Mac
 * reader" is a measurement and not a reading of the code.
 *
 * Three things this file exists to decide that no other file can:
 *
 * - **The order of the refusals** (400, then 404, then 503, then `busy`) is a
 *   property of the socket's handler, not of `runAsk`.
 * - **The gate and the hang-up** need a client that really goes away, so the
 *   bytes they hold and the slots they release are observable.
 * - **The health member** joins `ai.getStatus()` to `shape.ts`'s `healthAi` on
 *   the wire; `rest.test.ts` mocks its way around the machine's own config, and
 *   the two cases below decide the member against a stub endpoint instead.
 */

const { APP_VERSION } = vi.hoisted(() => ({ APP_VERSION: '9.9.9-test' }))

vi.mock('electron', async (importOriginal) => {
  const actual = await importOriginal<typeof import('electron')>()
  // The health route reads `app.getVersion()` and the shared mock has no such
  // method (which is why `rest.test.ts` carries this same mock): without it the
  // two health cases below answer 500 from the handler's own catch.
  return { ...actual, app: { ...actual.app, getVersion: () => APP_VERSION } }
})

const TOKEN = 'a1b2c3d4'.repeat(8)
const SECTION =
  'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness.'

/**
 * A section long enough for `passageWindow` to window it (`PASSAGE_CHAR_CAP` is
 * 6,000), with an identifiable head and an identifiable phrase deep inside it:
 * the case that decides "the offset's neighbourhood, not the section's head"
 * needs both, or a prefix would satisfy it.
 */
const HEAD_PHRASE = 'The first words of the section are these.'
const DEEP_PHRASE = 'the boatswain answered the whistle'
const SECTION_LONG = [
  HEAD_PHRASE,
  'filler sentence. '.repeat(600),
  DEEP_PHRASE,
  'more filler. '.repeat(1200)
].join(' ')
const DEEP_OFFSET = SECTION_LONG.indexOf(DEEP_PHRASE)

let api: Server
let base: string
let upstream: Server[] = []
let windowEvents: { channel: string; payload: unknown }[] = []

beforeEach(async () => {
  db.closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
  upstream = []
  windowEvents = []
  for (const key of ['MUSAEUM_AI_BASE_URL', 'MUSAEUM_AI_MODEL', 'MUSAEUM_AI_API_KEY']) {
    vi.stubEnv(key, '')
  }
  setMainWindow({
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => windowEvents.push({ channel, payload })
    }
  } as unknown as Parameters<typeof setMainWindow>[0])
  db.insertBook({ ...makeBook('b1', 'A Tale of Two Cities'), author: 'Charles Dickens' })

  api = createRestApiServer(
    { enabled: true, port: 0, bind: '127.0.0.1', token: TOKEN },
    { askHeartbeatMs: 40 }
  )
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
})

afterEach(async () => {
  vi.unstubAllEnvs()
  setMainWindow(null)
  api.closeAllConnections()
  await new Promise<void>((resolve) => api.close(() => resolve()))
  await Promise.all(
    upstream.map(
      (s) => new Promise<void>((done) => (s.closeAllConnections(), s.close(() => done())))
    )
  )
})

async function stub(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const requests: string[] = []
  const closed: boolean[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')))
    req.on('end', () => {
      requests.push(raw)
      // **The socket's own close, not the request stream's.** An
      // `IncomingMessage` here emits `'close'` the moment its body is consumed,
      // so a listener on it would report every request as abandoned and the
      // cancellation case below would pass without a cancel.
      res.on('close', () => closed.push(true))
      handler(req, res)
    })
  })
  upstream.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  db.setConfig(AI_CONFIG_KEYS.baseUrl, url)
  db.setConfig(AI_CONFIG_KEYS.model, 'test-model')
  return { requests, closed }
}

const sse = (text: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
const answering =
  (...deltas: string[]) =>
  (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const d of deltas) res.write(sse(d))
    res.end('data: [DONE]\n\n')
  }
/** An upstream that sends one token and then never finishes. */
const hanging = (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(sse('one'))
}

const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const post = (body: unknown, headers: Record<string, string> = auth, signal?: AbortSignal) =>
  fetch(`${base}/api/ai/ask`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal
  })

const ASK = {
  bookId: 'b1',
  mode: 'ask',
  section: { label: 'Book the First', text: SECTION, offset: null },
  fraction: 0.1,
  question: 'What is the tone of this opening?'
}

/** The named events in a finished stream, comments skipped. */
function events(text: string): { event: string; data: Record<string, unknown> }[] {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('event:'))
    .map((block) => {
      const [event, data] = block.split('\n')
      return {
        event: event!.replace('event: ', ''),
        data: JSON.parse(data!.replace('data: ', '')) as Record<string, unknown>
      }
    })
}

describe('POST /api/ai/ask — refusals before the stream', () => {
  it('answers 401 with no credential, before any route logic', async () => {
    const res = await post(ASK, { 'content-type': 'application/json' })
    expect(res.status).toBe(401)
  })

  it.each([
    ['not JSON', '{nope'],
    ['an empty body', ''],
    ['an ask with no question', { bookId: 'b1', mode: 'ask' }],
    ['an unknown mode', { bookId: 'b1', mode: 'stream' }]
  ])('answers 400 for %s', async (_name, body) => {
    await stub(answering('x'))
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad request' })
  })

  it('holds the body to its cap: one byte past is a 400, and the upstream is never called', async () => {
    const up = await stub(answering('x'))
    const pad = 'x'.repeat(ASK_BODY_MAX_BYTES)
    const res = await post(JSON.stringify({ ...ASK, selection: pad }))
    expect(res.status).toBe(400)
    expect(up.requests).toHaveLength(0)
  })

  it('answers 404 for an unknown book', async () => {
    await stub(answering('x'))
    const res = await post({ ...ASK, bookId: 'nope' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })

  it('answers 404 for an unknown book even with no model set: the book is looked up first', async () => {
    // No `stub()` here, so no model is configured and the 503 the next case
    // settles is the answer a reordered handler would give. The body is a valid
    // ask otherwise, so only the order decides this.
    const res = await post({ ...ASK, bookId: 'nope' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })

  it('answers 503 ai unavailable, with a reason, in every mode when no model is set', async () => {
    for (const mode of ['preview', 'probe', 'ask']) {
      const res = await post({ ...ASK, mode })
      expect(res.status).toBe(503)
      const body = (await res.json()) as { error: string; reason: string }
      expect(body.error).toBe('ai unavailable')
      expect(body.reason).toMatch(/model/i)
      expect(res.headers.get('retry-after')).toBeNull()
    }
  })

  it.each(['GET', 'HEAD', 'PUT', 'DELETE'])('answers the uniform 404 to %s', async (method) => {
    const res = await fetch(`${base}/api/ai/ask`, { method, headers: auth })
    expect(res.status).toBe(404)
  })

  it('answers 400 for a bad body that names an unknown book: the body is parsed first', async () => {
    // The bad body here carries a `bookId`, and it names no row — so the parse
    // has to run before the lookup for this to be a 400 at all. The three cases
    // above either carry no `bookId` or name `b1`, the book this suite inserted,
    // so they still answer 400 with the lookup moved up.
    await stub(answering('x'))
    const res = await post({ bookId: 'nope', mode: 'stream' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad request' })
  })

  it('owns exactly its own pathname: a path that merely starts with it is 404 too', async () => {
    const up = await stub(answering('x'))

    // The wrong-method half, on both paths: a known path behind a method the
    // route does not answer is not distinguished from no path at all (D11).
    for (const method of ['GET', 'HEAD']) {
      for (const path of ['/api/ai/ask', '/api/ai/asked']) {
        const res = await fetch(`${base}${path}`, { method, headers: auth })
        expect(res.status).toBe(404)
      }
    }

    // **The half that decides `isAskRoute`'s exactness, and the reason it is a
    // `POST`.** A prefix match would route this into the relay and answer 200
    // (or 503, or 400) — the two loops above stay green under that mutation,
    // because the router's arm already requires `POST`. With the endpoint
    // stubbed and no book row for it, a prefix match answers 200 from the relay
    // for a path nothing asked for.
    const asked = await fetch(`${base}/api/ai/asked`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(ASK)
    })
    expect(asked.status).toBe(404)
    expect(await asked.json()).toEqual({ error: 'not found' })
    expect(up.requests).toHaveLength(0)
  })
})

describe('POST /api/ai/ask — the stream', () => {
  it('previews without calling the model', async () => {
    const up = await stub(answering('never'))
    const res = await post({ ...ASK, mode: 'preview', question: null })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/)
    expect(res.headers.get('cache-control')).toBe('no-store')

    expect(events(await res.text()).map((e) => e.event)).toEqual(['disclosure', 'done'])
    expect(up.requests).toHaveLength(0)
  })

  it('streams an ask: disclosure, deltas in order, one done', async () => {
    await stub(answering('A grand', ' contrast.'))
    const res = await post(ASK)
    const seen = events(await res.text())

    expect(seen.map((e) => e.event)).toEqual(['disclosure', 'delta', 'delta', 'done'])
    expect(seen.filter((e) => e.event === 'delta').map((e) => e.data.text)).toEqual([
      'A grand',
      ' contrast.'
    ])
  })

  it('sends a window around the offset at the passage rung, never the section’s head', async () => {
    const up = await stub(answering('ok'))
    const res = await post({
      ...ASK,
      rung: 'passage',
      section: { label: 'Book the First', text: SECTION_LONG, offset: DEEP_OFFSET }
    })
    const seen = events(await res.text())
    expect(res.status).toBe(200)

    const sent = up.requests[0]!
    // The text at the offset travelled — AC6's second half, decided through the
    // route rather than through `runAsk`: `services/api/ask.test.ts` sends
    // `rung: 'passage'` with `offset: null`, so the head phrase alone satisfies
    // it there.
    expect(sent).toContain(DEEP_PHRASE)
    // ...and the head did not. Two measurements, neither ordering the other:
    // this line proves the section did not go out from its start, the one above
    // that the offset's neighbourhood did. The first of the two can fail with
    // this one passing; this one cannot fail while the first passes, because the
    // head phrase sits ~9,200 characters before the window's start and no window
    // of `PASSAGE_CHAR_CAP` carries both — so the mutation that could move this
    // line, dropping `section.offset`, reddens the first as well.
    expect(sent).not.toContain(HEAD_PHRASE)
    // The disclosure says which of the two went out (the windowed rule in the
    // prompt is the model's half of the same fact).
    expect(seen[0]!.data).toMatchObject({ rung: 'passage', windowed: true })
  })

  it('answers a probe with a verdict and never the raw reply', async () => {
    await stub(answering('RECALL: yes\n', `OPENING: ${SECTION.slice(0, 70)}\n`))
    const res = await post({ ...ASK, mode: 'probe', question: null })
    const text = await res.text()

    expect(events(text).map((e) => e.event)).toEqual(['disclosure', 'verdict', 'done'])
    expect(text).not.toContain('RECALL')
    expect(events(text)[1]!.data).toEqual({ value: 'strong' })
  })

  it('reports an upstream failure as an error event after a 200', async () => {
    db.setConfig(AI_CONFIG_KEYS.baseUrl, 'http://127.0.0.1:1/v1')
    db.setConfig(AI_CONFIG_KEYS.model, 'test-model')
    const res = await post(ASK)
    expect(res.status).toBe(200)
    expect(events(await res.text()).map((e) => e.event)).toEqual(['disclosure', 'error'])
  })

  it('never lets the key reach a response', async () => {
    await stub(answering('ok'))
    db.setConfig(AI_CONFIG_KEYS.apiKey, 'sk-secret')
    const body = await (await post(ASK)).text()
    expect(body).not.toContain('sk-secret')
    const health = await (await fetch(`${base}/api/health`, { headers: auth })).text()
    expect(health).not.toContain('sk-secret')
  })

  it("never paints into the Mac reader: the window sees none of a phone's events", async () => {
    await stub(answering('a', 'b'))
    await (await post(ASK)).text()
    expect(windowEvents).toEqual([])
  })

  it('writes a heartbeat comment while the model is silent', async () => {
    await stub((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // silence
    })
    const controller = new AbortController()
    const res = await post(ASK, auth, controller.signal)
    const reader = res.body!.getReader()
    let text = ''
    await vi.waitFor(async () => {
      const { value } = await reader.read()
      text += new TextDecoder().decode(value)
      expect(text).toContain(': ping')
    })
    controller.abort()
  })
})

describe('POST /api/ai/ask — concurrency and hanging up', () => {
  it('turns the third concurrent ask away with 503 busy and Retry-After: 1', async () => {
    await stub(hanging)
    const c1 = new AbortController()
    const c2 = new AbortController()
    const first = await post(ASK, auth, c1.signal)
    const second = await post(ASK, auth, c2.signal)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)

    const third = await post(ASK)
    expect(third.status).toBe(503)
    expect(await third.json()).toEqual({ error: 'busy' })
    expect(third.headers.get('retry-after')).toBe('1')

    c1.abort()
    c2.abort()
  })

  it('aborts the upstream request when the phone hangs up, and frees the slot', async () => {
    const up = await stub(hanging)
    const c1 = new AbortController()
    const c2 = new AbortController()
    await post(ASK, auth, c1.signal)
    await post(ASK, auth, c2.signal)

    c1.abort()
    c2.abort()
    await vi.waitFor(() => expect(up.closed.length).toBe(2))

    // The slots came back: two more asks are admitted
    const c3 = new AbortController()
    const again = await post(ASK, auth, c3.signal)
    expect(again.status).toBe(200)
    c3.abort()
  })

  it("a phone ask beside the desktop's own question keeps each stream to itself", async () => {
    await stub(answering('x'))
    const { ask } = await import('../services/ai')
    ask({ requestId: 'desktop-1', mode: 'ask', messages: [{ role: 'user', content: 'hi' }] })
    const seen = events(await (await post(ASK)).text())
    await vi.waitFor(() =>
      expect(
        windowEvents.some((e) => (e.payload as { requestId?: string }).requestId === 'desktop-1')
      ).toBe(true)
    )

    expect(seen.map((e) => e.event)).toEqual(['disclosure', 'delta', 'done'])
    expect(
      windowEvents.every((e) => (e.payload as { requestId?: string }).requestId === 'desktop-1')
    ).toBe(true)
  })
})

describe('GET /api/health — the ai member', () => {
  it('is available when a model is set, with the endpoint as host[:port]', async () => {
    await stub(answering('x'))
    const body = (await (await fetch(`${base}/api/health`, { headers: auth })).json()) as {
      ai: Record<string, unknown>
    }
    expect(body.ai).toMatchObject({
      available: true,
      reason: null,
      isLocal: true,
      model: 'test-model'
    })
    expect(String(body.ai.host)).toMatch(/^127\.0\.0\.1:\d+$/)
  })

  it('says why it is off when no model is set', async () => {
    const body = (await (await fetch(`${base}/api/health`, { headers: auth })).json()) as {
      ai: { available: boolean; reason: string; model: null }
    }
    expect(body.ai.available).toBe(false)
    expect(body.ai.reason).toMatch(/model/i)
    expect(body.ai.model).toBeNull()
  })
})
