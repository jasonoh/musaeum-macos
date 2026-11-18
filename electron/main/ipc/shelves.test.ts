import { readFileSync } from 'fs'
import { join } from 'path'
import type { IPCResult } from '@shared/api.types'
import type { ShelfPlacement } from '@shared/shelf.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `test/mocks/electron.ts` keeps `ipcMain` inert, so this file swaps in one that
 * records each registration and lets a case invoke the registered closure — the
 * real `handle()` around a stubbed service, which is what decides the envelope.
 */
const registered = vi.hoisted(
  () => new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
)

vi.mock('electron', async (importOriginal) => ({
  ...(await importOriginal<typeof import('electron')>()),
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
      registered.set(channel, fn)
    }
  }
}))

vi.mock('../services/shelves', () => ({
  list: vi.fn(),
  forBook: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  deleteShelf: vi.fn(),
  addBooks: vi.fn(),
  removeBooks: vi.fn(),
  restoreBooks: vi.fn(),
  moveBooks: vi.fn()
}))

import * as shelves from '../services/shelves'
import { registerShelvesHandlers } from './shelves'

const invoke = (channel: string, ...args: unknown[]): Promise<IPCResult<unknown>> => {
  const fn = registered.get(channel)
  if (!fn) throw new Error(`No handler registered for ${channel}`)
  return fn({}, ...args) as Promise<IPCResult<unknown>>
}

beforeEach(() => {
  vi.resetAllMocks()
  registered.clear()
  registerShelvesHandlers()
})

/**
 * The preload invokes a channel by string and main registers it by string; a
 * typo in either is a promise that rejects with "No handler registered" and no
 * type error anywhere. So the two spellings are compared here.
 */
describe('shelves IPC — the preload and the handlers name the same channels', () => {
  const channels = (file: string): string[] =>
    [...readFileSync(join(process.cwd(), file), 'utf8').matchAll(/'(shelves:[A-Za-z]+)'/g)]
      .map((m) => m[1]!)
      .sort()

  it('registers exactly the nine channels the preload invokes', () => {
    const registeredInSource = channels('electron/main/ipc/shelves.ts')
    expect(registeredInSource).toEqual([
      'shelves:addBooks',
      'shelves:create',
      'shelves:delete',
      'shelves:forBook',
      'shelves:list',
      'shelves:move',
      'shelves:removeBooks',
      'shelves:rename',
      'shelves:restoreBooks'
    ])
    expect(channels('electron/preload/index.ts')).toEqual(registeredInSource)
    expect([...registered.keys()].sort()).toEqual(registeredInSource)
  })
})

describe('shelves:create — the kind travels to the service', () => {
  it('forwards a third `kind` argument', async () => {
    const made = { id: 'q1', name: 'Next up', kind: 'queue' as const, count: 1 }
    vi.mocked(shelves.create).mockResolvedValue(made)

    const result = await invoke('shelves:create', 'Next up', ['a'], 'queue')

    expect(shelves.create).toHaveBeenCalledWith('Next up', ['a'], 'queue')
    expect(result).toEqual({ success: true, data: made })
  })

  it('still forwards a two-argument call, leaving the kind to the service default', async () => {
    vi.mocked(shelves.create).mockResolvedValue({
      id: 's',
      name: 'To Read',
      kind: 'manual',
      count: 0
    })

    await invoke('shelves:create', 'To Read')

    expect(shelves.create).toHaveBeenCalledWith('To Read', undefined, undefined)
  })
})

describe('shelves:move', () => {
  it('forwards (id, bookIds, placement) to moveBooks and answers success', async () => {
    vi.mocked(shelves.moveBooks).mockResolvedValue(undefined)
    const placement: ShelfPlacement = { before: 'b' }

    const result = await invoke('shelves:move', 'q1', ['a', 'c'], placement)

    expect(shelves.moveBooks).toHaveBeenCalledWith('q1', ['a', 'c'], placement)
    expect(result).toEqual({ success: true, data: undefined })
  })

  it("carries a refusal to the envelope as the service's sentence", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(shelves.moveBooks).mockRejectedValue(
      new Error('Only a reading queue can be reordered')
    )

    const result = await invoke('shelves:move', 'm1', ['a'], { to: 'top' })

    expect(result).toEqual({ success: false, error: 'Only a reading queue can be reordered' })
  })
})
