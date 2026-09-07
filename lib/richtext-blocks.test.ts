// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { BLOCK_CLASS, openUpAround } from './richtext-blocks'

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

  it('puts a line between two that are shoulder to shoulder', () => {
    const el = box(block('p1') + block('p2'))
    openUpAround(el)
    const kinds = Array.from(el.childNodes).map((node) => node.nodeName)
    expect(kinds).toEqual(['BR', 'DIV', 'BR', 'DIV', 'BR'])
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
