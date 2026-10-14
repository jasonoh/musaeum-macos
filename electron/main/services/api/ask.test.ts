import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_CONFIG_KEYS, getStatus } from '../ai'
import { closeDb, setConfig } from '../db'
import {
  ASK_SECTION_TEXT_MAX_CHARS,
  frame,
  healthAi,
  parseAskRequest,
  runAsk,
  type AskEventName,
  type AskWireRequest
} from './ask'

/**
 * The relay's brain, end to end.
 *
 * `runAsk` is exercised against a **real** HTTP server and a real `fetch` — the
 * stub mirrors `ai.test.ts`'s own — because the three modes differ in what
 * reaches the model and when an event is emitted, and neither is observable
 * through a mocked client. Events are collected from the `emit` callback the
 * socket module will hand it, so a mode that reports the wrong order of events
 * is a failure here rather than a silent one on the phone.
 */

interface Seen {
  event: AskEventName
  data: Record<string, unknown>
}

let servers: Server[] = []
let seen: Seen[] = []

beforeEach(() => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
  // A developer's own `MUSAEUM_AI_*` must not make "no model set" untestable
  for (const key of ['MUSAEUM_AI_BASE_URL', 'MUSAEUM_AI_MODEL', 'MUSAEUM_AI_API_KEY']) {
    vi.stubEnv(key, '')
  }
  servers = []
  seen = []
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections()
          server.close(() => done())
        })
    )
  )
})

interface Stub {
  url: string
  bodies: { messages: { role: string; content: string }[] }[]
}

async function startStub(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<Stub> {
  const bodies: Stub['bodies'] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')))
    req.on('end', () => {
      try {
        bodies.push(JSON.parse(raw))
      } catch {
        /* not JSON — nothing to record */
      }
      handler(req, res)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies }
}

const sse = (text: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`

/** A stub that answers with the given deltas and ends. */
function answering(...deltas: string[]) {
  return (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const delta of deltas) res.write(sse(delta))
    res.end('data: [DONE]\n\n')
  }
}

function configure(stub: Stub): void {
  setConfig(AI_CONFIG_KEYS.baseUrl, stub.url)
  setConfig(AI_CONFIG_KEYS.model, 'test-model')
}

const SECTION =
  'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness, it was the epoch of belief.'

function request(overrides: Partial<AskWireRequest> = {}): AskWireRequest {
  return {
    bookId: 'b1',
    mode: 'ask',
    rung: 'pointer',
    section: { label: 'Book the First', text: SECTION, offset: null, truncated: false },
    fraction: 0.1,
    selection: null,
    question: 'What is the tone of this opening?',
    ...overrides
  }
}

function run(req: AskWireRequest, signal?: AbortSignal) {
  return runAsk({
    request: req,
    book: { title: 'A Tale of Two Cities', author: 'Charles Dickens' },
    status: getStatus(),
    emit: (event, data) => seen.push({ event, data: data as Record<string, unknown> }),
    signal
  })
}

const names = () => seen.map((s) => s.event)

describe('parseAskRequest', () => {
  it('accepts the smallest request and fills the defaults', () => {
    const parsed = parseAskRequest({ bookId: 'b1', mode: 'preview' })
    expect(parsed).toEqual({
      ok: true,
      request: {
        bookId: 'b1',
        mode: 'preview',
        rung: 'pointer',
        section: { label: null, text: null, offset: null, truncated: false },
        fraction: null,
        selection: null,
        question: null
      }
    })
  })

  it('carries every member of a full ask', () => {
    const parsed = parseAskRequest({
      bookId: 'b1',
      mode: 'ask',
      rung: 'passage',
      section: { label: 'Chapter 4', text: 'Body text.', offset: 5, truncated: false },
      fraction: 0.42,
      selection: 'a highlighted sentence',
      question: 'What does this mean?'
    })
    expect(parsed.ok && parsed.request).toMatchObject({
      mode: 'ask',
      rung: 'passage',
      section: { label: 'Chapter 4', text: 'Body text.', offset: 5 },
      fraction: 0.42,
      selection: 'a highlighted sentence',
      question: 'What does this mean?'
    })
  })

  it('ignores members it does not know, at both levels', () => {
    const parsed = parseAskRequest({
      bookId: 'b1',
      mode: 'probe',
      futureMember: { a: 1 },
      section: { label: 'x', futureToo: true }
    })
    expect(parsed.ok).toBe(true)
  })

  it('needs a question for an ask, and only for an ask', () => {
    expect(parseAskRequest({ bookId: 'b1', mode: 'ask' }).ok).toBe(false)
    expect(parseAskRequest({ bookId: 'b1', mode: 'ask', question: '   ' }).ok).toBe(false)
    expect(parseAskRequest({ bookId: 'b1', mode: 'probe' }).ok).toBe(true)
    expect(parseAskRequest({ bookId: 'b1', mode: 'preview' }).ok).toBe(true)
  })

  it('holds the section text to its cap: at the cap passes, one past is refused', () => {
    const at = 'x'.repeat(ASK_SECTION_TEXT_MAX_CHARS)
    expect(parseAskRequest({ bookId: 'b1', mode: 'probe', section: { text: at } }).ok).toBe(true)
    expect(parseAskRequest({ bookId: 'b1', mode: 'probe', section: { text: at + 'x' } }).ok).toBe(
      false
    )
  })

  it.each([
    ['not an object', 'text'],
    // An array is an object, so the array row has to carry the members of a
    // *valid* request: a bare `[]` is refused one guard later by the empty book
    // id, and would leave the `!Array.isArray` clause unwitnessed (a mutant that
    // drops it stays green).
    ['an array', Object.assign([], { bookId: 'b1', mode: 'preview' })],
    ['null', null],
    ['no book id', { mode: 'ask', question: 'q' }],
    ['a blank book id', { bookId: '  ', mode: 'preview' }],
    ['an over-long book id', { bookId: 'x'.repeat(201), mode: 'preview' }],
    ['an unknown mode', { bookId: 'b1', mode: 'stream' }],
    ['an unknown rung', { bookId: 'b1', mode: 'preview', rung: 'chapter' }],
    ['a non-object section', { bookId: 'b1', mode: 'preview', section: 'text' }],
    ['a non-string label', { bookId: 'b1', mode: 'preview', section: { label: 4 } }],
    ['a negative offset', { bookId: 'b1', mode: 'preview', section: { offset: -1 } }],
    ['a NaN offset', { bookId: 'b1', mode: 'preview', section: { offset: Number.NaN } }],
    ['a string offset', { bookId: 'b1', mode: 'preview', section: { offset: '5' } }],
    ['a non-boolean truncated', { bookId: 'b1', mode: 'preview', section: { truncated: 'yes' } }],
    ['a fraction above 1', { bookId: 'b1', mode: 'preview', fraction: 1.1 }],
    ['a negative fraction', { bookId: 'b1', mode: 'preview', fraction: -0.1 }],
    ['a non-string selection', { bookId: 'b1', mode: 'preview', selection: 7 }],
    ['an over-long question', { bookId: 'b1', mode: 'ask', question: 'q'.repeat(10_001) }]
  ])('refuses %s', (_name, body) => {
    expect(parseAskRequest(body)).toEqual({ ok: false })
  })
})

describe('frame', () => {
  it('writes an event line, a one-line data line and a blank line', () => {
    expect(frame('delta', { text: 'a\nb' })).toBe('event: delta\ndata: {"text":"a\\nb"}\n\n')
  })
})

describe('healthAi', () => {
  it('reads availability, host and locality off the status, and never a key', () => {
    setConfig(AI_CONFIG_KEYS.baseUrl, 'http://localhost:11434/v1')
    setConfig(AI_CONFIG_KEYS.model, 'llama3.2')
    setConfig(AI_CONFIG_KEYS.apiKey, 'sk-secret-key-9999')
    const ai = healthAi(getStatus())
    expect(ai).toEqual({
      available: true,
      reason: null,
      isLocal: true,
      host: 'localhost:11434',
      model: 'llama3.2'
    })
    expect(JSON.stringify(ai)).not.toContain('secret')
  })

  it('says why it is off when no model is set', () => {
    const ai = healthAi(getStatus())
    expect(ai.available).toBe(false)
    expect(ai.reason).toMatch(/model/i)
    expect(ai.model).toBeNull()
  })
})

describe('runAsk — preview', () => {
  it('discloses a probe when there is no question, and calls no model', async () => {
    const stub = await startStub(answering('never'))
    configure(stub)

    await run(request({ mode: 'preview', question: null }))

    expect(names()).toEqual(['disclosure', 'done'])
    expect(stub.bodies).toHaveLength(0)
    expect(seen[0]!.data.text).toMatch(/^Sends: title, author, section/)
    expect(seen[0]!.data.text).not.toMatch(/question/)
    expect(seen[1]!.data).toEqual({ reason: 'stop' })
  })

  it('discloses an ask when there is one, naming the highlight and the question', async () => {
    const stub = await startStub(answering('never'))
    configure(stub)

    await run(request({ mode: 'preview', selection: 'the age of wisdom' }))

    expect(seen[0]!.data.members).toEqual(
      expect.arrayContaining(['title', 'author', 'section', 'position', 'question', 'highlight'])
    )
    expect(seen[0]!.data.endpoint).toEqual({
      host: stub.url.replace(/^http:\/\//, '').replace(/\/v1$/, ''),
      isLocal: true
    })
    expect(stub.bodies).toHaveLength(0)
  })
})

describe('runAsk — ask', () => {
  it('streams the deltas in order and ends with one done', async () => {
    const stub = await startStub(answering('A grand', ' contrast.'))
    configure(stub)

    await run(request())

    expect(names()).toEqual(['disclosure', 'delta', 'delta', 'done'])
    expect(seen.filter((s) => s.event === 'delta').map((s) => s.data.text)).toEqual([
      'A grand',
      ' contrast.'
    ])
    expect(seen.at(-1)!.data).toEqual({ reason: 'stop' })
  })

  it('sends none of the section text at the pointer rung (L0)', async () => {
    const stub = await startStub(answering('ok'))
    configure(stub)

    await run(request({ rung: 'pointer' }))

    const sent = JSON.stringify(stub.bodies[0])
    expect(sent).not.toContain('best of times')
    expect(sent).toContain('A Tale of Two Cities')
  })

  it('sends the passage at the passage rung, and says so', async () => {
    const stub = await startStub(answering('ok'))
    configure(stub)

    await run(request({ rung: 'passage' }))

    expect(JSON.stringify(stub.bodies[0])).toContain('best of times')
    expect(seen[0]!.data.members).toContain('passage')
    expect(seen[0]!.data.rung).toBe('passage')
  })

  it('reports an unreachable endpoint as disclosure then error, and no done', async () => {
    setConfig(AI_CONFIG_KEYS.baseUrl, 'http://127.0.0.1:1/v1')
    setConfig(AI_CONFIG_KEYS.model, 'test-model')

    await run(request())

    expect(names()).toEqual(['disclosure', 'error'])
    expect(String(seen[1]!.data.message)).toMatch(/listening|reach|running/i)
  })
})

describe('runAsk — probe', () => {
  it('scores a verbatim opening strong and never sends the raw reply', async () => {
    const stub = await startStub(answering('RECALL: yes\n', `OPENING: ${SECTION.slice(0, 80)}\n`))
    configure(stub)

    await run(request({ mode: 'probe', question: null }))

    expect(names()).toEqual(['disclosure', 'verdict', 'done'])
    expect(seen[1]!.data).toEqual({ value: 'strong' })
    expect(JSON.stringify(seen)).not.toContain('RECALL')
  })

  it('scores an explicit refusal weak', async () => {
    const stub = await startStub(answering('RECALL: no\nOPENING:\n'))
    configure(stub)

    await run(request({ mode: 'probe', question: null }))

    expect(seen.find((s) => s.event === 'verdict')!.data).toEqual({ value: 'weak' })
  })

  it('scores a reply that does not follow the contract unknown', async () => {
    const stub = await startStub(answering('Certainly! Here is a lovely summary of the book.'))
    configure(stub)

    await run(request({ mode: 'probe', question: null }))

    expect(seen.find((s) => s.event === 'verdict')!.data).toEqual({ value: 'unknown' })
  })

  it('scores a fluent invention weak: the claim is not on the page', async () => {
    const stub = await startStub(
      answering(
        'RECALL: yes\nOPENING: Call me Ishmael some years ago never mind how long precisely\n'
      )
    )
    configure(stub)

    await run(request({ mode: 'probe', question: null }))

    expect(seen.find((s) => s.event === 'verdict')!.data).toEqual({ value: 'weak' })
  })

  it('is pointer-only by construction: no section text goes to the model', async () => {
    const stub = await startStub(answering('RECALL: no\nOPENING:\n'))
    configure(stub)

    await run(
      request({ mode: 'probe', rung: 'passage', selection: 'the age of wisdom', question: null })
    )

    const sent = JSON.stringify(stub.bodies[0])
    expect(sent).not.toContain('best of times')
    expect(sent).not.toContain('age of wisdom')
  })

  it('is unknown, with no section text to check against', async () => {
    const stub = await startStub(answering(`RECALL: yes\nOPENING: ${SECTION.slice(0, 60)}\n`))
    configure(stub)

    await run(
      request({
        mode: 'probe',
        question: null,
        section: { label: 'x', text: null, offset: null, truncated: false }
      })
    )

    expect(seen.find((s) => s.event === 'verdict')!.data).toEqual({ value: 'unknown' })
  })
})

describe('runAsk — hanging up', () => {
  it('aborts the upstream request and emits nothing after the signal fires', async () => {
    let upstreamClosed = false
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse('one'))
      res.on('close', () => (upstreamClosed = true))
    })
    configure(stub)
    const controller = new AbortController()

    const finished = run(request(), controller.signal)
    await vi.waitFor(() => expect(names()).toContain('delta'))
    const before = seen.length
    controller.abort()
    await finished

    await vi.waitFor(() => expect(upstreamClosed).toBe(true))
    expect(seen).toHaveLength(before)
    expect(names()).not.toContain('done')
    expect(names()).not.toContain('error')
  })

  it('does nothing at all when the signal is already aborted', async () => {
    const stub = await startStub(answering('never'))
    configure(stub)
    const controller = new AbortController()
    controller.abort()

    await run(request(), controller.signal)

    expect(seen).toEqual([])
    expect(stub.bodies).toHaveLength(0)
  })
})
