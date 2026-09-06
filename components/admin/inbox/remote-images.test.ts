import { describe, it, expect } from 'vitest'
import { SHOWN_LIMIT, addShownId, parseShownIds } from './remote-images'

describe('parseShownIds', () => {
  it('reads a list of ids back', () => {
    expect(parseShownIds('["a","b"]')).toEqual(['a', 'b'])
  })

  it('treats nothing stored as nothing shown', () => {
    expect(parseShownIds(null)).toEqual([])
    expect(parseShownIds('')).toEqual([])
  })

  it('treats an unreadable value as nothing shown', () => {
    expect(parseShownIds('{')).toEqual([])
    expect(parseShownIds('"a"')).toEqual([])
    expect(parseShownIds('{"a":1}')).toEqual([])
  })

  it('drops anything in the list that is not an id', () => {
    expect(parseShownIds('["a",1,null,"",{"b":2},"c"]')).toEqual(['a', 'c'])
  })

  it('holds a hand-grown list to the limit', () => {
    const raw = JSON.stringify(Array.from({ length: SHOWN_LIMIT + 10 }, (_, i) => `m${i}`))
    expect(parseShownIds(raw)).toHaveLength(SHOWN_LIMIT)
  })
})

describe('addShownId', () => {
  it('puts the newest at the front', () => {
    expect(addShownId(['a', 'b'], 'c')).toEqual(['c', 'a', 'b'])
  })

  it('holds an id once, however many times it is shown', () => {
    expect(addShownId(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
  })

  it('drops the oldest once the list is full', () => {
    const full = Array.from({ length: SHOWN_LIMIT }, (_, i) => `m${i}`)
    const next = addShownId(full, 'new')
    expect(next).toHaveLength(SHOWN_LIMIT)
    expect(next[0]).toBe('new')
    expect(next).not.toContain(`m${SHOWN_LIMIT - 1}`)
  })
})
