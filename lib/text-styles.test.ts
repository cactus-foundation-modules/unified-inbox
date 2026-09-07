import { describe, it, expect } from 'vitest'
import { applyTextStyles, offeredStyles } from './text-styles'

const WHATSAPP = { bold: '*', italic: '_', strikethrough: '~', monospace: '```' }

describe('applyTextStyles', () => {
  it('leaves markup alone on a channel that carries nothing', () => {
    expect(applyTextStyles('<p><strong>Hi</strong></p>', null)).toBe('<p><strong>Hi</strong></p>')
    expect(applyTextStyles('<p><strong>Hi</strong></p>', {})).toBe('<p><strong>Hi</strong></p>')
  })

  it('writes bold the way the channel writes it', () => {
    expect(applyTextStyles('<p><strong>Hi</strong> there</p>', WHATSAPP)).toBe('<p>*Hi* there</p>')
    expect(applyTextStyles('<p><b>Hi</b></p>', WHATSAPP)).toBe('<p>*Hi*</p>')
  })

  it('writes italic, strikethrough and monospace too', () => {
    expect(applyTextStyles('<em>soon</em>', WHATSAPP)).toBe('_soon_')
    expect(applyTextStyles('<i>soon</i>', WHATSAPP)).toBe('_soon_')
    expect(applyTextStyles('<s>gone</s>', WHATSAPP)).toBe('~gone~')
    expect(applyTextStyles('<del>gone</del>', WHATSAPP)).toBe('~gone~')
    expect(applyTextStyles('<code>SKU-1</code>', WHATSAPP)).toBe('```SKU-1```')
  })

  // The marker has to hug the words. WhatsApp reads "* hello *" as an asterisk,
  // a space and some words, which is exactly what it looks like.
  it('leaves the spaces outside the marker', () => {
    expect(applyTextStyles('a <strong> hello </strong> b', WHATSAPP)).toBe('a  *hello*  b')
  })

  // The tag goes either way - the flattener would have taken it out next -
  // but a marker round nothing would arrive as a stray asterisk.
  it('marks nothing when there is nothing to mark', () => {
    expect(applyTextStyles('<strong>   </strong>', WHATSAPP)).toBe('   ')
    expect(applyTextStyles('<strong></strong>', WHATSAPP)).toBe('')
  })

  it('handles one style inside another', () => {
    expect(applyTextStyles('<strong>very <em>good</em></strong>', WHATSAPP)).toBe('*very _good_*')
  })

  it('does not wrap the same marker round something twice', () => {
    expect(applyTextStyles('<b><b>Hi</b></b>', WHATSAPP)).toBe('*Hi*')
  })

  it('does not mangle a tag of the same name inside itself', () => {
    expect(applyTextStyles('<b>a <b>c</b> d</b>', WHATSAPP)).toBe('*a *c* d*')
  })

  it('only writes the styles the channel declared', () => {
    expect(applyTextStyles('<strong>Hi</strong> <em>soon</em>', { bold: '*' }))
      .toBe('*Hi* <em>soon</em>')
  })

  it('takes a different channel’s markers without being taught them', () => {
    expect(applyTextStyles('<strong>Hi</strong>', { bold: '**' })).toBe('**Hi**')
  })

  it('leaves everything else where it was', () => {
    expect(applyTextStyles('<p>See <a href="https://example.com">this</a></p>', WHATSAPP))
      .toBe('<p>See <a href="https://example.com">this</a></p>')
  })
})

describe('offeredStyles', () => {
  it('is empty for a channel that takes words', () => {
    expect(offeredStyles(null)).toEqual([])
    expect(offeredStyles({})).toEqual([])
  })

  it('names only what was declared', () => {
    expect(offeredStyles({ bold: '*', italic: '_' })).toEqual(['bold', 'italic'])
    expect(offeredStyles(WHATSAPP)).toEqual(['bold', 'italic', 'strikethrough', 'monospace'])
  })
})
