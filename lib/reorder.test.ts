import { describe, it, expect } from 'vitest'
import { moveInOrder } from './list'

// Dragging one address above another. The cases below are the ones a mouse
// makes hard work of proving and a test settles in a line each.

describe('moveInOrder', () => {
  const tabs = ['hi', 'accounts', 'sales', 'orders']

  it('moves an address up', () => {
    expect(moveInOrder(tabs, 2, 0)).toEqual(['sales', 'hi', 'accounts', 'orders'])
  })

  it('moves an address down', () => {
    expect(moveInOrder(tabs, 0, 2)).toEqual(['accounts', 'sales', 'hi', 'orders'])
  })

  it('moves an address to the end', () => {
    expect(moveInOrder(tabs, 0, 3)).toEqual(['accounts', 'sales', 'orders', 'hi'])
  })

  it('leaves the list alone when it is dropped where it already was', () => {
    expect(moveInOrder(tabs, 1, 1)).toEqual(tabs)
  })

  it('leaves the list alone when the move is off the end of it', () => {
    expect(moveInOrder(tabs, 0, 9)).toEqual(tabs)
    expect(moveInOrder(tabs, -1, 0)).toEqual(tabs)
  })

  it('does not modify the list it was given', () => {
    const before = [...tabs]
    moveInOrder(tabs, 3, 0)
    expect(tabs).toEqual(before)
  })
})
