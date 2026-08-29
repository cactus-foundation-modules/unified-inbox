import { describe, it, expect } from 'vitest'
import { moveInOrder } from './list'

// Dragging one address above another. The cases below are the ones a mouse
// makes hard work of proving and a test settles in a line each.

describe('moveInOrder', () => {
  const rail = ['hi', 'accounts', 'sales', 'orders']

  it('moves an address up', () => {
    expect(moveInOrder(rail, 2, 0)).toEqual(['sales', 'hi', 'accounts', 'orders'])
  })

  it('moves an address down', () => {
    expect(moveInOrder(rail, 0, 2)).toEqual(['accounts', 'sales', 'hi', 'orders'])
  })

  it('moves an address to the end', () => {
    expect(moveInOrder(rail, 0, 3)).toEqual(['accounts', 'sales', 'orders', 'hi'])
  })

  it('leaves the list alone when it is dropped where it already was', () => {
    expect(moveInOrder(rail, 1, 1)).toEqual(rail)
  })

  it('leaves the list alone when the move is off the end of it', () => {
    expect(moveInOrder(rail, 0, 9)).toEqual(rail)
    expect(moveInOrder(rail, -1, 0)).toEqual(rail)
  })

  it('does not modify the list it was given', () => {
    const before = [...rail]
    moveInOrder(rail, 3, 0)
    expect(rail).toEqual(before)
  })
})
