import { describe, it, expect } from 'vitest'
import {
  DEFAULT_WIDTHS,
  WIDTH_LIMITS,
  clampWidth,
  parseStoredWidths,
  roomForColumns,
  settleWidths,
} from './column-widths'

describe('clampWidth', () => {
  it('holds each column inside its own limits', () => {
    expect(clampWidth('rail', 10)).toBe(WIDTH_LIMITS.rail.min)
    expect(clampWidth('rail', 9999)).toBe(WIDTH_LIMITS.rail.max)
    expect(clampWidth('list', 400.4)).toBe(400)
  })
})

describe('roomForColumns', () => {
  it('leaves the conversation its room, and the context panel its column', () => {
    expect(roomForColumns(1600, false)).toBe(1240)
    expect(roomForColumns(1600, true)).toBe(984)
  })
})

describe('settleWidths', () => {
  const start = { ...DEFAULT_WIDTHS }

  it('moves the edge that was dragged', () => {
    expect(settleWidths(1200, start, 'list', 500)).toEqual({ rail: 240, list: 500 })
  })

  it('never moves the edge that was not', () => {
    // The rail is dragged wide enough that the pair no longer fits; the list it
    // is pushing against must come back untouched, or a drag somebody makes on
    // one edge silently resizes the other and cannot be undone.
    const out = settleWidths(700, start, 'rail', 420)
    expect(out.list).toBe(start.list)
    expect(out.rail).toBe(700 - start.list)
  })

  it('gives the conversation its room back by giving way on the dragged edge', () => {
    const room = 600
    const out = settleWidths(room, start, 'list', 680)
    expect(out.rail + out.list).toBeLessThanOrEqual(room)
  })

  it('will not shrink a column past its own minimum to make room', () => {
    // A frame too narrow for both columns at their minimums cannot be settled by
    // arithmetic, and the answer is the minimum rather than a sliver of a rail.
    const out = settleWidths(100, start, 'rail', 400)
    expect(out.rail).toBe(WIDTH_LIMITS.rail.min)
  })
})

describe('parseStoredWidths', () => {
  it('reads a stored pair', () => {
    expect(parseStoredWidths('{"rail":200,"list":420}')).toEqual({ rail: 200, list: 420 })
  })

  it('clamps a stored value that is out of range', () => {
    expect(parseStoredWidths('{"rail":4000}')).toEqual({ rail: WIDTH_LIMITS.rail.max })
  })

  it('ignores anything that is not two sane numbers', () => {
    expect(parseStoredWidths(null)).toEqual({})
    expect(parseStoredWidths('not json')).toEqual({})
    expect(parseStoredWidths('[1,2]')).toEqual({})
    expect(parseStoredWidths('{"rail":"240"}')).toEqual({})
    expect(parseStoredWidths('{"list":null}')).toEqual({})
    // JSON has no Infinity of its own, but 1e999 parses to one, and a width of
    // Infinity is a frame with nothing in it but a rail.
    expect(parseStoredWidths('{"list":1e999}')).toEqual({})
  })
})
