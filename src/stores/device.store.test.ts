import { describe, expect, it } from 'vitest'
import type { TransferJob } from '@shared/device.types'
import { failedSendCount, liveSendCount, sendErrorFor, sendStateFor } from './device.store'

/**
 * The send button's state is derived from the queue, and these are the cases the
 * button has to get right: a click that has only been *queued* must still read
 * as sending (the call resolves immediately, which is what let a second click
 * through), and a failure has to be distinguishable from an idle button.
 */
function job(patch: Partial<TransferJob> = {}): TransferJob {
  return {
    jobId: 'job-1',
    bookId: 'a',
    bookTitle: 'A Book',
    deviceId: 'kindle:Kindle',
    deviceName: 'Kindle',
    format: 'azw3',
    status: 'queued',
    progress: 0,
    ...patch
  }
}

const KINDLE = 'kindle:Kindle'

describe('sendStateFor', () => {
  it('is idle with nothing in the queue', () => {
    expect(sendStateFor({}, 'a', KINDLE)).toBe('idle')
  })

  it.each(['queued', 'converting', 'copying'] as const)('reads %s as sending', (status) => {
    expect(sendStateFor({ j: job({ status }) }, 'a', KINDLE)).toBe('sending')
  })

  it('reads a finished send as sent, so the button holds until presence settles', () => {
    expect(sendStateFor({ j: job({ status: 'done' }) }, 'a', KINDLE)).toBe('sent')
  })

  it('reads a failure as failed, with the reason attached', () => {
    const failed = job({ status: 'error', error: 'Kindle disconnected before transfer' })

    expect(sendStateFor({ j: failed }, 'a', KINDLE)).toBe('failed')
    expect(sendErrorFor({ j: failed }, 'a', KINDLE)).toBe('Kindle disconnected before transfer')
  })

  it('ignores other books and other devices', () => {
    const other = { j: job({ bookId: 'b', deviceId: 'kindle:Other', status: 'error' }) }

    expect(sendStateFor(other, 'a', KINDLE)).toBe('idle')
    expect(sendErrorFor(other, 'a', KINDLE)).toBeUndefined()
  })

  it('reads a retry as sending rather than inheriting the failure that prompted it', () => {
    // Job ids are uuids and the object keeps insertion order, so the last
    // matching job is the newest one
    const transfers = {
      old: job({ jobId: 'old', status: 'error', error: 'No source file available for conversion' }),
      fresh: job({ jobId: 'fresh', status: 'queued' })
    }

    expect(sendStateFor(transfers, 'a', KINDLE)).toBe('sending')
    expect(sendErrorFor(transfers, 'a', KINDLE)).toBeUndefined()
  })
})

describe('bulk counts', () => {
  const transfers = {
    a: job({ jobId: 'a', status: 'copying' }),
    b: job({ jobId: 'b', status: 'queued' }),
    c: job({ jobId: 'c', status: 'done' }),
    d: job({ jobId: 'd', status: 'error', error: 'Copy incomplete' }),
    elsewhere: job({ jobId: 'e', deviceId: 'kindle:Other', status: 'queued' })
  }

  it('counts what is still running, and only for this device', () => {
    expect(liveSendCount(transfers, KINDLE)).toBe(2)
  })

  it('counts failures that are still on screen', () => {
    expect(failedSendCount(transfers, KINDLE)).toBe(1)
  })

  it('counts nothing for a device with no work', () => {
    expect(liveSendCount(transfers, 'kindle:Nothing')).toBe(0)
    expect(failedSendCount(transfers, 'kindle:Nothing')).toBe(0)
  })
})
