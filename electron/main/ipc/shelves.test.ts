import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * The preload invokes a channel by string and main registers it by string; a
 * typo in either is a promise that rejects with "No handler registered" and no
 * type error anywhere. So the two spellings are compared here.
 */
describe('shelves IPC — the preload and the handlers name the same channels', () => {
  const channels = (file: string): string[] =>
    [...readFileSync(join(process.cwd(), file), 'utf8').matchAll(/'(shelves:[A-Za-z]+)'/g)]
      .map((m) => m[1])
      .sort()

  it('registers exactly the eight channels the preload invokes', () => {
    const registered = channels('electron/main/ipc/shelves.ts')
    expect(registered).toEqual([
      'shelves:addBooks',
      'shelves:create',
      'shelves:delete',
      'shelves:forBook',
      'shelves:list',
      'shelves:removeBooks',
      'shelves:rename',
      'shelves:restoreBooks'
    ])
    expect(channels('electron/preload/index.ts')).toEqual(registered)
  })
})
