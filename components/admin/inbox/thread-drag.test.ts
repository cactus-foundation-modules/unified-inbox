import { describe, expect, it } from 'vitest'
import { draggedIds, movedMessage, wouldMove } from './thread-drag'

describe('draggedIds', () => {
  it('carries the whole ticked pile when the dragged row is one of them', () => {
    expect(draggedIds('b', ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('carries the row alone when it is not ticked, whatever else is', () => {
    expect(draggedIds('z', ['a', 'b'])).toEqual(['z'])
    expect(draggedIds('z', [])).toEqual(['z'])
  })
})

describe('wouldMove', () => {
  it('refuses the mailbox everything is already in', () => {
    expect(wouldMove({ ids: ['a', 'b'], fromInboxIds: ['sales'] }, 'sales')).toBe(false)
  })

  it('accepts when any of the pile is somewhere else, or nowhere', () => {
    expect(wouldMove({ ids: ['a', 'b'], fromInboxIds: ['sales', 'support'] }, 'sales')).toBe(true)
    expect(wouldMove({ ids: ['a'], fromInboxIds: [null] }, 'sales')).toBe(true)
  })

  it('has nothing to do with nothing in the air', () => {
    expect(wouldMove(null, 'sales')).toBe(false)
    expect(wouldMove({ ids: [], fromInboxIds: [] }, 'sales')).toBe(false)
  })
})

describe('movedMessage', () => {
  it('counts only when there is more than one', () => {
    expect(movedMessage(1, 'Sales')).toBe('Moved to Sales.')
    expect(movedMessage(6, 'Sales')).toBe('6 moved to Sales.')
  })
})
