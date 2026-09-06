import { describe, expect, it } from 'vitest'
import { columnLetter, describeImportFault } from './contacts'
import { sameCategoryIds } from './campaigns/guards'

// The two silent refusals, tested at the level they broke.
//
// Neither of these had a test, and neither could have had one where it lived:
// both were private functions inside a route handler. That is most of why they
// went unnoticed - a route file is only ever exercised by a real request, and
// a real request needs a database, a session and somebody's actual CSV.

describe('columnLetter', () => {
  it('counts the way a spreadsheet does', () => {
    expect(columnLetter(0)).toBe('A')
    expect(columnLetter(7)).toBe('H')
    expect(columnLetter(25)).toBe('Z')
    expect(columnLetter(26)).toBe('AA')
    expect(columnLetter(27)).toBe('AB')
    expect(columnLetter(51)).toBe('AZ')
    expect(columnLetter(52)).toBe('BA')
  })
})

describe('describeImportFault', () => {
  it('names the row and the column when one cell is too long', () => {
    // rows[412][7] - the eighth cell of the four hundred and thirteenth row.
    const said = describeImportFault([{ path: ['rows', 412, 7] }])
    // +2: the heading is row one, and a spreadsheet counts from one.
    expect(said).toContain('row 414')
    expect(said).toContain('column H')
  })

  it('counts from the whole file, not from the chunk that was sent', () => {
    // The same cell, in the third chunk of 250. Without the offset this would
    // say row 14 and send somebody to the wrong end of their spreadsheet.
    const said = describeImportFault([{ path: ['rows', 11, 2] }], 500)
    expect(said).toContain('row 513')
  })

  it('tells a wide row apart from a long cell', () => {
    expect(describeImportFault([{ path: ['rows', 3] }])).toContain('more columns')
    expect(describeImportFault([{ path: ['rows', 3] }])).not.toContain('too long')
  })

  it('has something to say about the other fields, and about nothing at all', () => {
    expect(describeImportFault([{ path: ['columns'] }])).toContain('more columns')
    expect(describeImportFault([{ path: ['updateExisting'] }])).toContain('needs to be a CSV')
    expect(describeImportFault([])).toBe('That file could not be read.')
  })

  // The whole point of the change: the old route answered every one of these
  // with one sentence, so none of them could be acted on.
  it('does not answer two different faults with the same sentence', () => {
    const answers = new Set([
      describeImportFault([{ path: ['rows', 1, 1] }]),
      describeImportFault([{ path: ['rows', 1] }]),
      describeImportFault([{ path: ['columns'] }]),
      describeImportFault([{ path: ['somethingElse'] }]),
    ])
    expect(answers.size).toBe(4)
  })
})

describe('sameCategoryIds', () => {
  // The bug: a started campaign sends its own unchanged labels back on every
  // save, and the route refused because the field was present at all. So a
  // finished campaign could not be saved in ANY respect.
  it('is true for the same set sent back in a different order', () => {
    expect(sameCategoryIds(['a', 'b', 'c'], ['c', 'a', 'b'])).toBe(true)
  })

  it('is true for two empty sets, which is the common case', () => {
    expect(sameCategoryIds([], [])).toBe(true)
  })

  it('is false when one is genuinely added or taken away', () => {
    expect(sameCategoryIds(['a', 'b'], ['a'])).toBe(false)
    expect(sameCategoryIds(['a'], ['a', 'b'])).toBe(false)
    expect(sameCategoryIds(['a'], ['b'])).toBe(false)
  })

  it('does not disturb what it was given', () => {
    const before = ['b', 'a']
    sameCategoryIds(before, ['a', 'b'])
    expect(before).toEqual(['b', 'a'])
  })
})
