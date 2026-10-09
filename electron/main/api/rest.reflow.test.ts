import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import * as db from '../services/db'
import * as nas from '../services/nas-manager'
import { REFUSAL_TTL_MS, resetForTests } from '../services/reflow'
import * as sidecar from '../services/sidecar'
import { createRestApiServer } from './rest'

/**
 * The reflow route against the REAL `services/reflow` module — only the sidecar
 * is mocked. `rest.test.ts` mocks the whole service, so it cannot tell whether
 * the refusal the service remembers is the refusal the route answers; this file
 * pins that join: a refusal is answered 422 with its reason, the next poll is
 * answered from memory without a second sidecar call, and after the TTL a request
 * asks again.
 */
vi.mock('../services/sidecar', () => ({
  assertAvailable: vi.fn(),
  call: vi.fn(),
  onNotification: vi.fn(() => () => {})
}))

vi.mock('../services/nas-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/nas-manager')>()
  return { ...actual, isOnline: vi.fn(() => true) }
})

const TOKEN = 'a1b2c3d4'.repeat(8)
const REASON = 'no page carries a text layer'

describe('the reflow route over the real reflow service', () => {
  let server: Server
  let base: string
  let root: string

  beforeEach(async () => {
    resetForTests()
    vi.mocked(sidecar.call).mockReset().mockResolvedValue({
      status: 'fallback',
      reason: REASON,
      verdict: 'no_text_layer'
    } as never)
    root = mkdtempSync(join(tmpdir(), 'musaeum-rest-reflow-int-'))
    await nas.setLibraryRoot(root)
    vi.mocked(nas.isOnline).mockReturnValue(true)
    mkdirSync(join(root, 'books', 'b1'), { recursive: true })
    writeFileSync(join(root, 'books', 'b1', 'Book.pdf'), '%PDF-1.4\n')
    db.insertBook({ ...makeBook('b1'), formats: ['pdf'] })

    server = createRestApiServer({ enabled: true, port: 0, bind: '127.0.0.1', token: TOKEN })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    vi.useRealTimers()
    resetForTests()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })

  const get = () =>
    fetch(`${base}/api/books/b1/file?format=reflow`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })

  it('remembers a refusal for REFUSAL_TTL_MS, then asks the sidecar again', async () => {
    const first = await get()
    expect(first.status).toBe(422)
    expect(await first.json()).toEqual({ error: 'cannot reflow', reason: REASON })
    expect(sidecar.call).toHaveBeenCalledTimes(1)

    const second = await get()
    expect(second.status).toBe(422)
    expect(await second.json()).toEqual({ error: 'cannot reflow', reason: REASON })
    expect(sidecar.call).toHaveBeenCalledTimes(1)

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + REFUSAL_TTL_MS + 1)
    const third = await get()
    expect(third.status).toBe(422)
    expect(sidecar.call).toHaveBeenCalledTimes(2)
  })
})
