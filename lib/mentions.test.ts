import { describe, it, expect } from 'vitest'
import { whoToTell } from './mentions'

// The pure half of tagging a colleague: which of the named ids are worth going
// to the database about. The interesting part is what it drops, and both of the
// things it drops were real - a picker that can be pressed twice, and somebody
// putting their own name on their own note.

describe('who a note is worth telling', () => {
  it('keeps the names in the order they were chosen', () => {
    expect(whoToTell(['sam', 'emma'], 'marcus')).toEqual(['sam', 'emma'])
  })

  it('asks each person once, however many times they were named', () => {
    // A row per person per conversation is the rule the table enforces; naming
    // somebody twice must not be two writes racing for one row.
    expect(whoToTell(['sam', 'sam', 'emma', 'sam'], 'marcus')).toEqual(['sam', 'emma'])
  })

  it('never asks the person doing the asking', () => {
    // A job on your own list that you are, by definition, already doing.
    expect(whoToTell(['marcus', 'sam'], 'marcus')).toEqual(['sam'])
  })

  it('ignores blanks, which is what a stray comma arrives as', () => {
    expect(whoToTell(['', '  ', 'sam'], 'marcus')).toEqual(['sam'])
  })

  it('trims, so a name with a space round it is the same name', () => {
    expect(whoToTell([' sam ', 'sam'], 'marcus')).toEqual(['sam'])
  })

  it('comes back empty when there is nobody left to tell', () => {
    expect(whoToTell(['marcus'], 'marcus')).toEqual([])
    expect(whoToTell([], 'marcus')).toEqual([])
  })
})
