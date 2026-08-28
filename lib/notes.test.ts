import { describe, it, expect } from 'vitest'
import { escapeHtml, noteHtml } from './notes'

describe('noteHtml', () => {
  it('renders a colleague pasting markup as the text they pasted', () => {
    expect(noteHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('keeps the line breaks somebody typed', () => {
    expect(noteHtml('one\ntwo')).toBe('one<br>two')
    expect(noteHtml('one\r\ntwo')).toBe('one<br>two')
  })

  it('escapes the ampersand first, so nothing is escaped twice', () => {
    expect(escapeHtml('Tom & Jerry <ok>')).toBe('Tom &amp; Jerry &lt;ok&gt;')
  })
})
