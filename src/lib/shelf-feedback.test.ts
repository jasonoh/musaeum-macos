import { describe, expect, it } from 'vitest'
import { createShelfFailureReporter } from './shelf-feedback'

/** A fixture sentence on purpose: main's own sentences live in main, and a copy
 *  of one in a renderer test is the drift storage-copy-scan exists to prevent. */
const UNREADABLE = 'the share says no this time'
const MISSING_SHELF = 'that shelf is not in the file'

function reporter() {
  const said: string[] = []
  return { said, report: createShelfFailureReporter((m) => said.push(m)) }
}

describe('one sentence, once a session', () => {
  it('says the same sentence the first time and never again', () => {
    const { said, report } = reporter()
    report(new Error(UNREADABLE))
    report(new Error(UNREADABLE))
    report(new Error(UNREADABLE))
    expect(said).toEqual([UNREADABLE])
  })

  it('says a second, different sentence — a session is not one report', () => {
    const { said, report } = reporter()
    report(new Error(UNREADABLE))
    report(new Error(MISSING_SHELF))
    expect(said).toEqual([UNREADABLE, MISSING_SHELF])
  })

  it('renders the error\u2019s own text, verbatim', () => {
    // Main writes these for a person to read; re-wording one here is how the
    // sentence in the log and the sentence on screen drift apart
    const { said, report } = reporter()
    report(new Error('That shelf no longer exists'))
    expect(said).toEqual(['That shelf no longer exists'])
  })

  it('takes a non-Error rejection, because a bridge that throws a string does', () => {
    const { said, report } = reporter()
    report('boom')
    expect(said).toEqual(['boom'])
  })

  it('keeps two sessions apart', () => {
    const first = reporter()
    const second = reporter()
    first.report(new Error(UNREADABLE))
    second.report(new Error(UNREADABLE))
    expect(first.said).toEqual([UNREADABLE])
    expect(second.said).toEqual([UNREADABLE])
  })
})
