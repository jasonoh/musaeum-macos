import { describe, expect, it } from 'vitest'
import { parsePositionBody } from './position'

/**
 * The position body's grammar, decided without a socket (D6, R3).
 *
 * `services/shelves.ts`'s `isPlacement` already answers a very similar question
 * for the Mac's own drag, and it is **wider**: `{ before: id }` and
 * `{ after: id }` are shapes it accepts and `moveBooks` performs. The wire
 * takes neither. So the anchor rows below are not pedantry — they are the only
 * cases in this file that would fail if the parser merely delegated to the
 * service's validator, which is precisely why the parser exists (R3).
 *
 * Nothing here needs a server, a database or a body reader: a JSON value in, a
 * decision out, like `query.test.ts` beside it.
 */

describe('parsePositionBody — the one body the route accepts', () => {
  it('accepts `top` and `bottom`, unchanged', () => {
    expect(parsePositionBody({ to: 'top' })).toEqual({ ok: true, to: 'top' })
    expect(parsePositionBody({ to: 'bottom' })).toEqual({ ok: true, to: 'bottom' })
  })

  it.each([
    ['a second member beside `to`', { to: 'top', extra: 1 }],
    ['a `before` anchor — the Mac’s drag shape', { before: 'x' }],
    ['an `after` anchor — the Mac’s drag shape', { after: 'x' }],
    ['a capitalised `top`', { to: 'Top' }],
    ['a third place', { to: 'middle' }],
    ['a numeric `to`', { to: 1 }],
    ['a null `to`', { to: null }],
    ['an empty object', {}],
    ['an empty array', []],
    ['an array of one value', ['top']],
    ['a bare string', 'top'],
    ['null', null],
    ['undefined', undefined],
    ['a bare number', 42]
    // Each is a 400 at the route, and never a coercion: 'Top' is not 'top', 1
    // is not a number to be mapped, and a second member is not "the member I
    // know plus noise" — D6 states one key, so one key it is.
  ])('refuses %s', (_label, body) => {
    expect(parsePositionBody(body)).toEqual({ ok: false })
  })

  it('refuses the Mac’s anchors, which isPlacement accepts (R3)', () => {
    // The decider for the separate-parser decision, in one place: these two
    // bodies are well-formed to `services/shelves.ts` and are what the Mac's
    // own drop sends. The wire's body is narrower, so a delegation here would
    // silently widen the contract while every other case stayed green.
    expect(parsePositionBody({ before: 'a1' })).toEqual({ ok: false })
    expect(parsePositionBody({ after: 'a1' })).toEqual({ ok: false })
  })

  it('counts own keys, so an inherited `to` is not a member', () => {
    // `Object.keys` lists own enumerable keys only — the reason there is no
    // `in` test in the parser. A body whose `to` lives on the prototype is an
    // empty body, and is refused as one.
    const inherited: unknown = Object.create({ to: 'top' })
    expect(parsePositionBody(inherited)).toEqual({ ok: false })

    // …while an own `to` beside an inherited key is exactly one own key, and
    // is read normally: inherited members are not counted against the body.
    const own: { to?: unknown } = Object.create({ extra: 1 })
    own.to = 'top'
    expect(parsePositionBody(own)).toEqual({ ok: true, to: 'top' })
  })
})
