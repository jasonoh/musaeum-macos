import { describe, expect, it, vi } from 'vitest'
import { createBeforeQuitHandler } from './quit'

function makeEvent() {
  return { preventDefault: vi.fn() }
}

describe('createBeforeQuitHandler', () => {
  it('prevents the first quit and does not tear down yet', () => {
    const teardown = vi.fn()
    const quit = vi.fn()
    const handler = createBeforeQuitHandler({
      flush: () => new Promise(() => undefined), // never resolves in this test
      teardown,
      quit
    })
    const event = makeEvent()

    handler(event)

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(teardown).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
  })

  it('quits (and only then) once flush settles, without tearing down itself', async () => {
    const teardown = vi.fn()
    const quit = vi.fn()
    const handler = createBeforeQuitHandler({
      flush: () => Promise.resolve(),
      teardown,
      quit
    })

    handler(makeEvent())
    // flush() resolves on a microtask; let it settle
    await Promise.resolve()
    await Promise.resolve()

    expect(quit).toHaveBeenCalledTimes(1)
    expect(teardown).not.toHaveBeenCalled()
  })

  it('runs teardown without preventing default on the second (re-entrant) call', async () => {
    const teardown = vi.fn()
    const quit = vi.fn()
    const handler = createBeforeQuitHandler({
      flush: () => Promise.resolve(),
      teardown,
      quit
    })

    handler(makeEvent())
    await Promise.resolve()
    await Promise.resolve()
    expect(quit).toHaveBeenCalledTimes(1)

    // Electron re-fires before-quit because quit() was called from inside
    // the first handler invocation — simulate that second, real dispatch.
    const secondEvent = makeEvent()
    handler(secondEvent)

    expect(secondEvent.preventDefault).not.toHaveBeenCalled()
    expect(teardown).toHaveBeenCalledTimes(1)
    // Must not call quit() again — that is exactly what would loop forever.
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('never loops: quit() is called at most once no matter how many times the handler re-enters', async () => {
    const teardown = vi.fn()
    let quitCalls = 0
    const handler = createBeforeQuitHandler({
      flush: () => Promise.resolve(),
      teardown,
      // A pathological quit() that (unrealistically) re-invokes the handler
      // synchronously, the way a bug in the guard would manifest as a loop.
      quit: () => {
        quitCalls += 1
        if (quitCalls < 5) handler(makeEvent())
      }
    })

    handler(makeEvent())
    await Promise.resolve()
    await Promise.resolve()

    // The guard flips to true before quit() is invoked, so even a
    // self-re-entrant quit() only ever reaches the teardown branch.
    expect(quitCalls).toBe(1)
    expect(teardown).toHaveBeenCalledTimes(1)
  })

  it('proceeds to quit even when flush rejects, logging rather than throwing', async () => {
    const teardown = vi.fn()
    const quit = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const handler = createBeforeQuitHandler({
        flush: () => Promise.reject(new Error('NAS write failed')),
        teardown,
        quit
      })

      handler(makeEvent())
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(quit).toHaveBeenCalledTimes(1)
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})
