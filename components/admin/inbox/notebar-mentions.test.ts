import { describe, it, expect } from 'vitest'
import { mentionQueryAt } from './NoteBar'

// What is being typed after an @ in the note line, if anything.
//
// It decides when the list of colleagues opens and what it narrows on, and it
// is the one part of tagging that is not a click - so the awkward cases are
// worth pinning down: an email address in the middle of a sentence is not
// somebody being tagged, and a name with a space in it is.

describe('mentionQueryAt', () => {
  it('finds nothing in a sentence with no @ in it', () => {
    expect(mentionQueryAt('rang them, no answer', 20)).toBeNull()
  })

  it('opens on the @ itself, before anything has been typed', () => {
    expect(mentionQueryAt('can @', 5)).toEqual({ query: '', from: 4 })
  })

  it('narrows on what follows it', () => {
    expect(mentionQueryAt('can @mar', 8)).toEqual({ query: 'mar', from: 4 })
  })

  it('allows the space in a name', () => {
    expect(mentionQueryAt('@Chris Tay', 10)).toEqual({ query: 'Chris Tay', from: 0 })
  })

  it('gives up after two words, rather than hunting for a colleague called "sam can you look"', () => {
    expect(mentionQueryAt('@sam can you', 12)).toBeNull()
  })

  it('reads from the caret, not the end of the line', () => {
    // Going back to put a name into a sentence already written.
    expect(mentionQueryAt('ask @ma about the desks', 7)).toEqual({ query: 'ma', from: 4 })
  })

  it('is not fooled by an email address', () => {
    // No space in front of the @, so nobody is being tagged.
    expect(mentionQueryAt('chased sam@example.com', 22)).toBeNull()
  })

  it('stops at a second @', () => {
    expect(mentionQueryAt('@Chris @Ma', 10)).toEqual({ query: 'Ma', from: 7 })
  })
})
