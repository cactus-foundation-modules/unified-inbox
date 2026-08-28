import { describe, it, expect } from 'vitest'
import { compilePattern, compilePatterns, DEFAULT_PATTERNS, extractReferences } from './linking'

const defaults = compilePatterns({ order: null, po: null, quote: null })

describe('compilePattern', () => {
  it('falls back to the default when nothing is configured', () => {
    expect(compilePattern(null, 'order')?.source).toBe(DEFAULT_PATTERNS.order)
  })

  it('treats an empty string as "do not look for this kind"', () => {
    expect(compilePattern('', 'order')).toBeNull()
  })

  it('refuses a pattern that will not compile rather than throwing', () => {
    expect(compilePattern('([unclosed', 'order')).toBeNull()
  })

  it('takes a site pattern that does compile', () => {
    expect(compilePattern('ZZ\\d+', 'order')?.source).toBe('ZZ\\d+')
  })
})

describe('extractReferences', () => {
  it('finds a reference in the subject', () => {
    const found = extractReferences({ subject: 'Question about ORD-000123', body: null }, defaults)
    expect(found.some((f) => f.reference === 'ORD-000123')).toBe(true)
  })

  it('finds one in the body as well', () => {
    const found = extractReferences({ subject: 'Hello', body: 'this is about PO000456 thanks' }, defaults)
    expect(found.some((f) => f.reference === 'PO000456')).toBe(true)
  })

  it('says nothing when there is nothing to say', () => {
    expect(extractReferences({ subject: 'Just checking in', body: 'no numbers here' }, defaults)).toEqual([])
  })

  it('does not repeat the same reference for one kind', () => {
    const found = extractReferences(
      { subject: 'ORD-000123', body: 'ord-000123 and ORD-000123 again' },
      compilePatterns({ order: null, po: '', quote: '' }),
    )
    expect(found).toHaveLength(1)
  })

  it('stops rather than looping on a pattern that matches nothing', () => {
    const found = extractReferences(
      { subject: 'anything at all', body: null },
      compilePatterns({ order: 'x*', po: '', quote: '' }),
    )
    // A pattern that can match the empty string must advance rather than hang.
    expect(Array.isArray(found)).toBe(true)
  })

  it('honours a site pattern in place of the default', () => {
    const found = extractReferences(
      { subject: 'Our ref W/12345 please', body: null },
      compilePatterns({ order: 'W/(\\d+)', po: '', quote: '' }),
    )
    expect(found).toEqual([{ kind: 'order', reference: '12345' }])
  })

  it('caps how many it will hand back for one kind', () => {
    const body = Array.from({ length: 40 }, (_, i) => `AB${1000 + i}`).join(' ')
    const found = extractReferences(
      { subject: null, body },
      compilePatterns({ order: null, po: '', quote: '' }),
    )
    expect(found.length).toBeLessThanOrEqual(10)
  })

  it('reads only the top of a very long message', () => {
    const body = `${'x'.repeat(30_000)} ORD-000999`
    const found = extractReferences({ subject: null, body }, defaults)
    expect(found).toEqual([])
  })
})
