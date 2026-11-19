// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  BLOCK_CLASS, keepOutOfBlocks, openLineAfter, openUpAround, touchingBlockPairs, unnestBlocks,
} from './richtext-blocks'

function box(html: string): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = html
  return el
}

const block = (id = 'p1') =>
  `<div class="uin-product-slot ${BLOCK_CLASS} uin-ps--shop--product--${id}" contenteditable="false">x</div>`

describe('writing round a block', () => {
  it('puts a line above one that starts the box, so there is somewhere to write an introduction', () => {
    const el = box(block())
    openUpAround(el)
    expect(el.firstChild?.nodeName).toBe('BR')
  })

  it('puts no line between two that are shoulder to shoulder', () => {
    const el = box(block('p1') + block('p2'))
    openUpAround(el)
    const kinds = Array.from(el.childNodes).map((node) => node.nodeName)
    expect(kinds).toEqual(['BR', 'DIV', 'DIV', 'BR'])
  })

  it('takes out the stray line the browser left behind a wrapped block that has more after it', () => {
    const el = box(`<div>${block('p1')}<br></div><div>${block('p2')}<br></div><div><br></div><div>Thanks</div>`)
    openUpAround(el)
    expect(el.querySelectorAll('br').length).toBe(2)
    expect(el.innerHTML).toContain('<div><br></div><div>Thanks</div>')
  })

  it('does not bring a deleted gap back', () => {
    const el = box(`<p>Intro</p><div>${block('p1')}</div><div>${block('p2')}</div><p>Outro</p>`)
    openUpAround(el)
    expect(el.querySelectorAll('br').length).toBe(0)
  })

  it('puts a line under the last one, so the message can carry on', () => {
    const el = box(`<p>Here you go.</p>${block()}`)
    openUpAround(el)
    expect(el.lastChild?.nodeName).toBe('BR')
  })

  it('leaves writing that is already there alone', () => {
    const el = box(`<p>Before</p>${block()}<p>After</p>`)
    openUpAround(el)
    expect(el.innerHTML).toBe(`<p>Before</p>${block()}<p>After</p>`)
  })

  it('adds nothing the second time, which is why it can run on every insert', () => {
    const el = box(block('p1') + block('p2'))
    openUpAround(el)
    const once = el.innerHTML
    openUpAround(el)
    expect(el.innerHTML).toBe(once)
  })

  it('does nothing at all to a box with no blocks in it', () => {
    const el = box('<p>Just words.</p>')
    openUpAround(el)
    expect(el.innerHTML).toBe('<p>Just words.</p>')
  })
})

describe('one product under another, never inside it', () => {
  it('moves a caret left inside a block to just after it', () => {
    const el = box(block('a') + 'after')
    const inner = el.querySelector(`.${BLOCK_CLASS}`)!.firstChild!
    const range = document.createRange()
    range.setStart(inner, 1)
    range.collapse(true)
    keepOutOfBlocks(el, range)
    expect(range.startContainer).toBe(el)
    expect(range.startOffset).toBe(1)
  })

  it('leaves a caret in plain writing alone', () => {
    const el = box('words' + block('a'))
    const range = document.createRange()
    range.setStart(el.firstChild!, 2)
    range.collapse(true)
    keepOutOfBlocks(el, range)
    expect(range.startContainer).toBe(el.firstChild)
    expect(range.startOffset).toBe(2)
  })

  it('lifts blocks nested inside one another out, in order', () => {
    const nested = (id: string, inside = '') =>
      `<div class="uin-product-slot ${BLOCK_CLASS} uin-ps--shop--product--${id}" contenteditable="false">x${inside}</div>`
    const el = box(nested('a', nested('b', nested('c')) + nested('d')))
    unnestBlocks(el)
    const ids = Array.from(el.children).map((c) => /product--(\w)/.exec(c.className)?.[1])
    expect(ids).toEqual(['a', 'b', 'c', 'd'])
    expect(el.querySelector(`.${BLOCK_CLASS} .${BLOCK_CLASS}`)).toBeNull()
  })
})

describe('a line between two products that are touching', () => {
  const idOf = (el: Element) => /product--(\w+)/.exec(el.className)?.[1]

  it('finds pairs with nothing between them, even in separate wrappers', () => {
    const el = box(`<div>${block('a')}</div><div>${block('b')}</div>${block('c')}`)
    expect(touchingBlockPairs(el).map(([x, y]) => [idOf(x), idOf(y)]))
      .toEqual([['a', 'b'], ['b', 'c']])
  })

  it('leaves out pairs with words or an empty line between them', () => {
    expect(touchingBlockPairs(box(block('a') + 'cheapest' + block('b')))).toHaveLength(0)
    expect(touchingBlockPairs(box(block('a') + '<div><br></div>' + block('b')))).toHaveLength(0)
  })

  it('opens an empty line after the first, puts the caret in it, and the tidy keeps it', () => {
    const el = box(block('a') + block('b'))
    document.body.appendChild(el)
    el.contentEditable = 'true'
    const first = el.querySelector(`.${BLOCK_CLASS}`)!
    const line = openLineAfter(el, first)
    expect(line?.outerHTML).toBe('<div><br></div>')
    expect(first.nextSibling).toBe(line)
    expect(window.getSelection()?.getRangeAt(0).startContainer).toBe(line)
    openUpAround(el)
    expect(first.nextSibling).toBe(line)
    expect(touchingBlockPairs(el)).toHaveLength(0)
    el.remove()
  })
})
