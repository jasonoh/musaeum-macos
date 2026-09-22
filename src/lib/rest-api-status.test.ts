import { describe, expect, it } from 'vitest'
import { statusLine } from './rest-api-status'

/**
 * The row's only logic that is not a value read off the view (AC27). These four
 * states are what the server can report; if one grows a member, `STATE_TONE`'s
 * `Record` over the union fails `npm run typecheck` and this file is where the
 * wording belongs.
 */
describe('the status line the phone row shows', () => {
  it('names the address and port the socket reported, never the ones asked for', () => {
    expect(
      statusLine(
        { state: 'listening', address: '100.125.135.108', port: 8788, reason: null, at: null },
        true
      )
    ).toBe('Listening on 100.125.135.108:8788')
    // A socket that reported neither is not given a flattering default
    expect(
      statusLine({ state: 'listening', address: null, port: null, reason: null, at: null }, true)
    ).toBe('Listening on an address it did not name:?')
  })

  it('renders a failure reason verbatim, because the words belong to the module that failed', () => {
    expect(
      statusLine(
        {
          state: 'failed',
          address: null,
          port: 8797,
          reason: 'port 8797 is already in use on 127.0.0.1 (EADDRINUSE)',
          at: null
        },
        true
      )
    ).toBe('Not listening — port 8797 is already in use on 127.0.0.1 (EADDRINUSE)')
  })

  it('invents nothing when a failure carries no reason', () => {
    expect(
      statusLine({ state: 'failed', address: null, port: null, reason: null, at: null }, true)
    ).toBe('Not listening')
  })

  it('says the listener stopped when the flag is on, and the switch is off when it is not', () => {
    const off = { state: 'disabled', address: null, port: null, reason: null, at: null } as const
    expect(statusLine(off, false)).toBe('Not listening — the switch is off')
    // The race this wording exists for: a stop that won an epoch, with the switch
    // still reading On. "the switch is off" here would contradict the row itself.
    expect(statusLine(off, true)).toBe('Not listening — the listener stopped')
  })

  it('says a start is in progress rather than reporting the state before it', () => {
    expect(
      statusLine({ state: 'starting', address: null, port: 8788, reason: null, at: null }, true)
    ).toBe('Starting the listener…')
  })
})
