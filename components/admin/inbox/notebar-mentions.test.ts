import { describe, it, expect } from 'vitest'
import { mentionQueryAt, taggedInText } from './NoteBar'

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

// Who a finished note actually asks. A name typed out rather than picked off
// the menu counts - somebody who writes "@Emma can you look" and presses Return
// has said what they meant - but only where it could be one person and only
// where the written name ends where the name ends.

describe('taggedInText', () => {
  const chris = { id: 'u-chris', name: 'Chris' }
  const emma = { id: 'u-emma', name: 'Emma' }
  const sam = { id: 'u-sam', name: 'Sam' }
  const samSmith = { id: 'u-sam-smith', name: 'Sam Smith' }
  const staff = [chris, emma, sam, samSmith]

  it('asks nobody when nobody is named', () => {
    expect(taggedInText('rang them, no answer', staff)).toEqual([])
    expect(taggedInText('chased sam@example.com about it', staff)).toEqual([])
  })

  it('asks somebody whose name was typed out rather than picked', () => {
    expect(taggedInText('@Emma can you look at this', staff)).toEqual(['u-emma'])
    expect(taggedInText('will ask @Emma tomorrow', staff)).toEqual(['u-emma'])
  })

  it('does not care how it was capitalised', () => {
    expect(taggedInText('@emma can you look', staff)).toEqual(['u-emma'])
  })

  it('takes the longest name it could be, not both', () => {
    expect(taggedInText('@Sam Smith has the file', staff)).toEqual(['u-sam-smith'])
    expect(taggedInText('@Sam has the file', staff)).toEqual(['u-sam'])
  })

  it('will not tag somebody because their name starts a longer word', () => {
    expect(taggedInText('@Samuel took it', staff)).toEqual([])
    expect(taggedInText('@Emmanuel took it', staff)).toEqual([])
  })

  it('leaves two colleagues of the same name to the menu', () => {
    const smyth = { id: 'u-sam-smyth', name: 'Sam Smith' }
    expect(taggedInText('@Sam Smith has it', [samSmith, smyth])).toEqual([])
    // Unless one of them was actually picked, which carries an id rather than a
    // spelling.
    expect(taggedInText('@Sam Smith has it', [samSmith, smyth], [smyth])).toEqual(['u-sam-smyth'])
  })

  it('asks everybody named, once each, in the order they appear', () => {
    expect(taggedInText('@Chris and @Emma - one of you?', staff)).toEqual(['u-chris', 'u-emma'])
    expect(taggedInText('@Emma ... @Emma again', staff)).toEqual(['u-emma'])
  })

  it('drops somebody picked and then deleted back out of the sentence', () => {
    expect(taggedInText('actually never mind', staff, [emma])).toEqual([])
  })

  it('needs the @ to start a word', () => {
    expect(taggedInText('ask.@Emma about it', staff)).toEqual([])
  })
})
