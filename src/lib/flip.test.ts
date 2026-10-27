import { describe, expect, it } from 'vitest'
import { glideDuration, planFlip, type FlipBox } from './flip'

function boxes(entries: Record<string, FlipBox>): Map<string, FlipBox> {
  return new Map(Object.entries(entries))
}

describe('planFlip', () => {
  it('inverts a tile back to where it was', () => {
    const before = boxes({ a: { x: 300, y: 20, w: 200 } })
    const after = boxes({ a: { x: 100, y: 400, w: 160 } })

    const { moves } = planFlip(before, after)

    expect(moves).toEqual([{ id: 'a', dx: 200, dy: -380, scale: 1.25 }])
  })

  it('leaves a tile that did not move out of the plan', () => {
    const same = { x: 24, y: 20, w: 180 }
    const { moves, entering } = planFlip(boxes({ a: same }), boxes({ a: { ...same, x: 24.4 } }))

    expect(moves).toEqual([])
    expect(entering).toEqual([])
  })

  it('moves a tile that only changed size', () => {
    const { moves } = planFlip(
      boxes({ a: { x: 24, y: 20, w: 200 } }),
      boxes({ a: { x: 24, y: 20, w: 180 } })
    )

    expect(moves).toHaveLength(1)
    expect(moves[0]?.scale).toBeCloseTo(200 / 180)
  })

  it('reports a tile that was not rendered before as entering', () => {
    const { moves, entering } = planFlip(
      boxes({ a: { x: 24, y: 20, w: 180 } }),
      boxes({ a: { x: 24, y: 20, w: 180 }, b: { x: 224, y: 20, w: 180 } })
    )

    expect(moves).toEqual([])
    expect(entering).toEqual(['b'])
  })

  it('ignores a tile that is gone', () => {
    const { moves, entering } = planFlip(boxes({ a: { x: 1, y: 1, w: 1 } }), boxes({}))

    expect(moves).toEqual([])
    expect(entering).toEqual([])
  })
})

describe('glideDuration', () => {
  const plan = (dx: number, dy = 0) => ({ moves: [{ id: 'a', dx, dy, scale: 1 }], entering: [] })

  it('keeps a short slide quick', () => {
    expect(glideDuration(plan(50))).toBe(360)
    expect(glideDuration({ moves: [], entering: [] })).toBe(360)
  })

  it('gives a long trip longer, by its straight-line distance', () => {
    expect(glideDuration(plan(300, 400))).toBe(450) // hypot 500
  })

  it('never takes longer than the ceiling', () => {
    expect(glideDuration(plan(5000))).toBe(640)
  })
})
