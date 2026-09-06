import { describe, expect, it } from 'vitest'
import { needsUnicodeSegments, segmentsFor } from './sms-segments'

describe('needsUnicodeSegments', () => {
  it('leaves an ordinary message on the long segment', () => {
    expect(needsUnicodeSegments("Your order is ready. Call us on 01234 567890.")).toBe(false)
  })

  it('catches the curly apostrophe an editor puts in without being asked', () => {
    expect(needsUnicodeSegments('We don’t have it in stock')).toBe(true)
  })

  it('catches an emoji', () => {
    expect(needsUnicodeSegments('On its way 🚚')).toBe(true)
  })

  it('treats a newline as ordinary', () => {
    expect(needsUnicodeSegments('Line one\nLine two')).toBe(false)
  })
})

describe('segmentsFor', () => {
  it('counts nothing as no texts, not as one', () => {
    expect(segmentsFor('')).toEqual({ segments: 0, perSegment: 160 })
  })

  it('fits 160 plain characters in one', () => {
    expect(segmentsFor('a'.repeat(160)).segments).toBe(1)
  })

  it('spills to two at 161', () => {
    expect(segmentsFor('a'.repeat(161)).segments).toBe(2)
  })

  // The whole point of the warning: one character changes the price of the
  // other 150.
  it('drops the whole message to 70-character segments for one curly quote', () => {
    const plain = 'a'.repeat(150)
    expect(segmentsFor(plain).segments).toBe(1)
    expect(segmentsFor(`${plain}’`).segments).toBe(3)
  })
})
