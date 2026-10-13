import type { BrowserWindow } from 'electron'
import { EVENT_CHANNELS } from '@shared/api.types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ChannelKey = keyof typeof EVENT_CHANNELS
type Events = typeof import('./events')

// `listeners` and `mainWindow` are module-level state in `events.ts`, so a
// listener left registered by one case would receive the next case's dispatch.
// `beforeEach` re-imports the module fresh, which isolates that state per case;
// every case still registers through `listen`, and the shared `afterEach` hands
// back whatever it subscribed.
let events: Events
let unsubscribes: (() => void)[]

beforeEach(async () => {
  vi.resetModules()
  events = await import('./events')
  unsubscribes = []
})

function listen(listener: (event: ChannelKey, payload?: unknown) => void): () => void {
  const off = events.subscribe(listener)
  unsubscribes.push(off)
  return off
}

/** Just enough of a `BrowserWindow` for `broadcast` to reach `webContents.send`. */
function fakeWindow(
  send: (channel: string, payload?: unknown) => void,
  destroyed = false
): BrowserWindow {
  return { isDestroyed: () => destroyed, webContents: { send } } as unknown as BrowserWindow
}

afterEach(() => {
  for (const off of unsubscribes) off()
  events.setMainWindow(null)
  vi.restoreAllMocks()
})

describe('events', () => {
  it('stops delivering to a listener once its unsubscribe has run', () => {
    const first = vi.fn()
    const second = vi.fn()
    const offFirst = listen(first)
    listen(second)

    offFirst()
    events.broadcast('themeChanged')

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('runs the other listeners, and does not throw to its caller, when one throws', () => {
    const second = vi.fn()
    listen(() => {
      throw new Error('listener exploded')
    })
    listen(second)

    expect(() => events.broadcast('themeChanged')).not.toThrow()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('still pushes to the renderer when a listener throws', () => {
    const send = vi.fn()
    events.setMainWindow(fakeWindow(send))
    listen(() => {
      throw new Error('listener exploded')
    })

    events.broadcast('themeChanged', 'payload')

    expect(send).toHaveBeenCalledWith(EVENT_CHANNELS.themeChanged, 'payload')
  })

  it('logs a listener that throws, naming the event key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    listen(() => {
      throw new Error('listener exploded')
    })

    events.broadcast('themeChanged')

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('themeChanged'))
  })

  it('delivers this dispatch to a listener a peer unsubscribed mid-dispatch, but not the next', () => {
    const second = vi.fn()
    let offSecond = (): void => {}
    // Registered first, so it runs (and unsubscribes the second) first.
    listen(() => offSecond())
    offSecond = listen(second)

    events.broadcast('themeChanged')
    expect(second).toHaveBeenCalledTimes(1)

    events.broadcast('themeChanged')
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('is inert before a window exists, and pushes to it once one is set', () => {
    const listener = vi.fn()
    const send = vi.fn()
    listen(listener)
    events.setMainWindow(null)

    expect(() => events.broadcast('themeChanged')).not.toThrow()
    expect(listener).toHaveBeenCalledTimes(1)

    events.setMainWindow(fakeWindow(send))
    events.broadcast('themeChanged', 'payload')

    expect(send).toHaveBeenCalledWith(EVENT_CHANNELS.themeChanged, 'payload')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('does not push to a window that has been destroyed', () => {
    const send = vi.fn()
    const listener = vi.fn()
    events.setMainWindow(fakeWindow(send, true))
    listen(listener)

    events.broadcast('themeChanged', 'payload')

    expect(send).not.toHaveBeenCalled()
    // The guard drops the *window*, not main's own listeners: a destroyed window
    // is the state every quit passes through, and these still have to run.
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
