import { describe, expect, it } from 'vitest'
import { anchorScrollTop } from './useVirtualRows'

describe('anchorScrollTop', () => {
  const contentTop = 20
  const rowHeight = 300

  it('puts the first row back at the true top, padding included', () => {
    // Row 0 starts `contentTop` into the content; restoring to that offset hid the
    // grid's top padding, so the covers sat flush under the toolbar
    expect(anchorScrollTop(0, 4, rowHeight, contentTop)).toBe(0)
    expect(anchorScrollTop(3, 4, rowHeight, contentTop)).toBe(0)
  })

  it('puts a later row at the top of the viewport', () => {
    expect(anchorScrollTop(4, 4, rowHeight, contentTop)).toBe(contentTop + rowHeight)
    expect(anchorScrollTop(9, 4, rowHeight, contentTop)).toBe(contentTop + 2 * rowHeight)
  })
})
