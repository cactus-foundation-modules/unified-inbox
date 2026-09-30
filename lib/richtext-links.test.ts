// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { linkAtCaret, linkifyEditable, openableHref } from './richtext-links'

// The box as a person uses it: words typed, a caret somewhere in them, and an
// address that should become a link at the moment it is finished and not before.

function box(html: string): HTMLDivElement {
  document.body.innerHTML = ''
  const el = document.createElement('div')
  el.contentEditable = 'true'
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

function caretAt(node: Node, offset: number) {
  const selection = document.getSelection()!
  selection.removeAllRanges()
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  selection.addRange(range)
}

describe('linking addresses in the writing box', () => {
  it('links every address when nobody is mid-word', () => {
    const el = box('Here https://deskwell.co.uk/hq/inbox?tab=unified-inbox&amp;id=a456 and www.b.example')
    expect(linkifyEditable(el, 'all')).toBe(true)
    expect(el.innerHTML).toBe(
      'Here <a href="https://deskwell.co.uk/hq/inbox?tab=unified-inbox&amp;id=a456">'
      + 'https://deskwell.co.uk/hq/inbox?tab=unified-inbox&amp;id=a456</a>'
      + ' and <a href="https://www.b.example">www.b.example</a>',
    )
  })

  it('waits for the space before linking the address being typed', () => {
    const el = box('go to https://deskwell.co')
    caretAt(el.firstChild!, 'go to https://deskwell.co'.length)
    expect(linkifyEditable(el, 'typing')).toBe(false)
    expect(el.querySelector('a')).toBeNull()
  })

  it('links it once a space goes in behind it, and keeps the caret after the space', () => {
    const el = box('go to https://deskwell.co.uk now')
    caretAt(el.firstChild!, 'go to https://deskwell.co.uk '.length)
    expect(linkifyEditable(el, 'typing')).toBe(true)
    expect(el.innerHTML).toBe('go to <a href="https://deskwell.co.uk">https://deskwell.co.uk</a> now')
    const selection = document.getSelection()!
    expect(selection.anchorNode?.textContent).toBe(' now')
    expect(selection.anchorOffset).toBe(1)
    expect(selection.anchorNode?.parentElement?.closest('a')).toBeNull()
  })

  it('leaves text already linked, and anything inside a block', () => {
    const html = '<a href="https://x.example">https://x.example</a>'
      + '<div contenteditable="false">https://y.example</div>'
    const el = box(html)
    expect(linkifyEditable(el, 'all')).toBe(false)
    expect(el.innerHTML).toBe(html)
  })

  it('never rewrites words under a selection somebody is about to link by hand', () => {
    const el = box('https://a.example')
    const range = document.createRange()
    range.selectNodeContents(el.firstChild!)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
    expect(linkifyEditable(el, 'all')).toBe(false)
    expect(el.querySelector('a')).toBeNull()
  })

  it('says where the link the caret is in goes', () => {
    const el = box('see <a href="https://a.example">here</a>')
    caretAt(el.querySelector('a')!.firstChild!, 2)
    expect(linkAtCaret(el)).toBe('https://a.example')
    caretAt(el.firstChild!, 1)
    expect(linkAtCaret(el)).toBeNull()
  })

  it('offers only the web, email and phone as a way out', () => {
    expect(openableHref('https://a.example')).toBe('https://a.example')
    expect(openableHref('mailto:a@b.example')).toBe('mailto:a@b.example')
    expect(openableHref('javascript:alert(1)')).toBeNull()
    expect(openableHref(null)).toBeNull()
  })
})
