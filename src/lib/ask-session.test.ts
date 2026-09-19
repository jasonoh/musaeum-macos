import { describe, expect, it } from 'vitest'
import {
  appendProbeDelta,
  askStatusOf,
  citationFor,
  effectiveRung,
  EMPTY_ASK_SESSION,
  nextRequestId,
  probeVerdict,
  reduceAsk,
  TRUNCATED_NOTICE,
  TIMEOUT_NOTICE,
  verdictNotice,
  type AskSession
} from './ask-session'

/**
 * The panel's decisions, on fixed fixtures.
 *
 * These are the three things `ReaderAsk.tsx` must not be trusted to do by
 * inspection: route a stream that has been superseded, turn a verdict into a
 * payload width, and match a section name. The renderer has no DOM harness, so
 * this file is where the panel's behaviour is actually decided.
 */

const SECTION = `Alice was beginning to get very tired of sitting by her sister on the bank, and of having nothing to do: once or twice she had peeped into the book her sister was reading, but it had no pictures or conversations in it.`

/** A session with one question in flight, which is the state most events arrive into. */
function asking(overrides: Partial<AskSession> = {}): AskSession {
  return {
    ...reduceAsk(EMPTY_ASK_SESSION, { type: 'open', requestId: 'q1', question: 'Who is Alice?' }),
    ...overrides
  }
}

describe('reduceAsk — the transcript', () => {
  it('opens a question with the answer still streaming', () => {
    const session = reduceAsk(EMPTY_ASK_SESSION, {
      type: 'open',
      requestId: 'q1',
      question: 'Who is Alice?'
    })
    expect(session.requestId).toBe('q1')
    expect(session.phase).toBe('asking')
    expect(session.turns).toEqual([
      { role: 'user', text: 'Who is Alice?' },
      { role: 'assistant', text: '', streaming: true }
    ])
  })

  it('accumulates deltas in the order they arrive', () => {
    let session = asking()
    for (const delta of ['She is ', 'a girl ', 'in the book.'])
      session = reduceAsk(session, { type: 'chunk', requestId: 'q1', delta })
    expect(session.turns[1].text).toBe('She is a girl in the book.')
  })

  it('ignores a chunk for another request — by identity, not by value', () => {
    const session = asking()
    expect(reduceAsk(session, { type: 'chunk', requestId: 'q0', delta: 'stale' })).toBe(session)
  })

  it('ignores an empty delta by identity', () => {
    const session = asking()
    expect(reduceAsk(session, { type: 'chunk', requestId: 'q1', delta: '' })).toBe(session)
  })

  it('settles the previous answer when a new question takes the stream over', () => {
    let session = reduceAsk(asking(), { type: 'chunk', requestId: 'q1', delta: 'partial' })
    session = reduceAsk(session, { type: 'open', requestId: 'q2', question: 'And the sister?' })
    expect(session.requestId).toBe('q2')
    expect(session.turns).toEqual([
      { role: 'user', text: 'Who is Alice?' },
      { role: 'assistant', text: 'partial' },
      { role: 'user', text: 'And the sister?' },
      { role: 'assistant', text: '', streaming: true }
    ])
  })

  it('lets a superseded stream’s terminal event land nowhere', () => {
    const session = reduceAsk(asking(), { type: 'open', requestId: 'q2', question: 'And?' })
    // The cancelled question's own `done` — the ordinary case (D9)
    expect(reduceAsk(session, { type: 'settle', requestId: 'q1', reason: 'cancelled' })).toBe(
      session
    )
    expect(reduceAsk(session, { type: 'fail', requestId: 'q1', message: 'ECONNREFUSED' })).toBe(
      session
    )
  })

  it('ends the turn on a normal stop', () => {
    let session = reduceAsk(asking(), { type: 'chunk', requestId: 'q1', delta: 'An answer.' })
    session = reduceAsk(session, { type: 'settle', requestId: 'q1', reason: 'stop' })
    expect(session.phase).toBe('idle')
    expect(session.notice).toBeNull()
    expect(session.turns[1]).toEqual({ role: 'assistant', text: 'An answer.' })
  })

  it('keeps a cut-off answer and says so', () => {
    let session = reduceAsk(asking(), { type: 'chunk', requestId: 'q1', delta: 'It was the' })
    session = reduceAsk(session, { type: 'settle', requestId: 'q1', reason: 'length' })
    expect(session.notice).toBe(TRUNCATED_NOTICE)
    expect(session.turns[1].text).toBe('It was the')
  })

  it('treats a timeout as an error, keeping what arrived', () => {
    let session = reduceAsk(asking(), { type: 'chunk', requestId: 'q1', delta: 'It was the' })
    session = reduceAsk(session, { type: 'settle', requestId: 'q1', reason: 'timeout' })
    expect(session.phase).toBe('error')
    expect(session.notice).toBe(TIMEOUT_NOTICE)
    expect(session.turns[1]).toEqual({ role: 'assistant', text: 'It was the' })
  })

  it('leaves no empty answer when a failure arrives before the first token', () => {
    const session = reduceAsk(asking(), {
      type: 'fail',
      requestId: 'q1',
      message: 'Nothing is listening at http://localhost:11434/v1'
    })
    expect(session.phase).toBe('error')
    expect(session.notice).toBe('Nothing is listening at http://localhost:11434/v1')
    expect(session.turns).toEqual([{ role: 'user', text: 'Who is Alice?' }])
  })

  it('ignores a chunk that arrives after the terminal event', () => {
    const session = reduceAsk(asking(), { type: 'settle', requestId: 'q1', reason: 'cancelled' })
    expect(reduceAsk(session, { type: 'chunk', requestId: 'q1', delta: 'late' })).toBe(session)
  })

  it('never mutates the state it was given', () => {
    const session = asking()
    const before = JSON.stringify(session)
    reduceAsk(session, { type: 'chunk', requestId: 'q1', delta: 'x' })
    reduceAsk(session, { type: 'open', requestId: 'q2', question: 'y' })
    reduceAsk(session, { type: 'settle', requestId: 'q1', reason: 'stop' })
    expect(JSON.stringify(session)).toBe(before)
  })
})

describe('askStatusOf — two streams, one status', () => {
  it('reports the question while it streams, probe or not', () => {
    expect(askStatusOf(asking(), true)).toBe('streaming')
    expect(askStatusOf(asking(), false)).toBe('streaming')
  })

  it('reports an error over both', () => {
    const failed = reduceAsk(asking(), { type: 'fail', requestId: 'q1', message: 'nope' })
    expect(askStatusOf(failed, true)).toBe('error')
  })

  it('reports the probe only while nothing else is happening', () => {
    expect(askStatusOf(EMPTY_ASK_SESSION, true)).toBe('probing')
    expect(askStatusOf(EMPTY_ASK_SESSION, false)).toBe('idle')
  })
})

describe('effectiveRung — the override widens, never narrows (D6)', () => {
  it('sends the passage for a weak verdict with the switch off', () => {
    expect(effectiveRung('weak', false)).toBe('passage')
  })

  it('sends the passage when the reader asks for it', () => {
    expect(effectiveRung('strong', true)).toBe('passage')
    expect(effectiveRung('unknown', true)).toBe('passage')
    expect(effectiveRung(null, true)).toBe('passage')
  })

  it('stays at the pointer otherwise', () => {
    expect(effectiveRung('strong', false)).toBe('pointer')
    expect(effectiveRung('unknown', false)).toBe('pointer')
    expect(effectiveRung(null, false)).toBe('pointer')
  })
})

describe('verdictNotice', () => {
  it('says nothing when the bet paid off', () => {
    expect(verdictNotice('strong', true)).toBeNull()
    expect(verdictNotice(null, false)).toBeNull()
  })

  it('names the passage only when there is one', () => {
    expect(verdictNotice('weak', true)).toContain('passage too')
    expect(verdictNotice('weak', false)).toContain('without it')
    expect(verdictNotice('weak', false)).not.toContain('passage too')
  })

  it('marks a reconstructed answer as unverified', () => {
    expect(verdictNotice('unknown', false)).toContain('Unverified')
  })
})

describe('appendProbeDelta — the reply accumulates, never renders', () => {
  it('accumulates in order', () => {
    let probe = appendProbeDelta({ requestId: 'p1', reply: '' }, 'p1', 'RECALL: yes\n')
    probe = appendProbeDelta(probe, 'p1', 'OPENING: Alice was beginning')
    expect(probe?.reply).toBe('RECALL: yes\nOPENING: Alice was beginning')
  })

  it('returns the same object for another request, or an empty delta', () => {
    const probe = { requestId: 'p1', reply: 'RECALL: ' }
    expect(appendProbeDelta(probe, 'p2', 'x')).toBe(probe)
    expect(appendProbeDelta(probe, 'p1', '')).toBe(probe)
    expect(appendProbeDelta(null, 'p1', 'x')).toBeNull()
  })
})

describe('probeVerdict — the reply scored against the section in hand', () => {
  it('scores a verbatim opening strong', () => {
    const reply = `RECALL: yes\nOPENING: Alice was beginning to get very tired of sitting by her sister`
    expect(probeVerdict(reply, SECTION)).toBe('strong')
  })

  it('scores a refusal weak', () => {
    expect(probeVerdict('RECALL: no\nOPENING:', SECTION)).toBe('weak')
  })

  it('scores an invention weak when it claims recall', () => {
    const reply = `RECALL: yes\nOPENING: The morning sun rose over the quiet town of Ashford`
    expect(probeVerdict(reply, SECTION)).toBe('weak')
  })

  it('scores a reply that ignores the contract unknown', () => {
    expect(probeVerdict('I am not sure what you mean.', SECTION)).toBe('unknown')
  })

  it('cannot verify a claim without section text', () => {
    const reply = `RECALL: yes\nOPENING: Alice was beginning to get very tired`
    expect(probeVerdict(reply, null)).toBe('unknown')
  })
})

describe('citationFor — the only jump offered (D7)', () => {
  const TOC = [
    { label: 'Cover', href: 'cover.xhtml' },
    { label: 'Chapter 4', href: 'ch4.xhtml' },
    { label: 'Down the Rabbit Hole', href: 'ch1.xhtml' },
    { label: 'Chapter 40', href: 'ch40.xhtml' },
    { label: 'I', href: 'part1.xhtml' }
  ]

  it('matches the section the answer names', () => {
    expect(citationFor('That is discussed in Down the Rabbit Hole.', TOC)).toEqual({
      label: 'Down the Rabbit Hole',
      href: 'ch1.xhtml'
    })
  })

  it('matches case-insensitively', () => {
    expect(citationFor('you will find it in chapter 4', TOC)?.href).toBe('ch4.xhtml')
  })

  it('will not match a label inside a longer word', () => {
    // 'Chapter 4' is a prefix of 'Chapter 40' — and the answer only name-checks the latter
    expect(citationFor('cf. Chapter 40 for the aftermath', TOC)?.href).toBe('ch40.xhtml')
    expect(citationFor('cf. Chapter 404 for the aftermath', TOC)).toBeNull()
  })

  it('prefers the most specific label when the answer names two', () => {
    expect(citationFor('it comes up in Chapter 4, after Down the Rabbit Hole', TOC)).toEqual({
      label: 'Down the Rabbit Hole',
      href: 'ch1.xhtml'
    })
  })

  it('leaves a one-character label alone', () => {
    expect(citationFor('I think so.', TOC)).toBeNull()
  })

  it('returns null when nothing matches, or nothing is asked of it', () => {
    expect(citationFor('This book has no such section.', TOC)).toBeNull()
    expect(citationFor('', TOC)).toBeNull()
    expect(citationFor(null, TOC)).toBeNull()
    expect(citationFor('anything', [])).toBeNull()
  })

  it('reads through a label’s own line breaks', () => {
    const toc = [{ label: 'The  Fall', href: 'fall.xhtml' }]
    expect(citationFor('see the fall for more', toc)?.href).toBe('fall.xhtml')
  })
})

describe('nextRequestId', () => {
  it('is unique, and short enough for the service to accept', () => {
    const ids = new Set(Array.from({ length: 50 }, () => nextRequestId()))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id.length).toBeLessThan(64)
  })
})
