import { describe, it, expect } from 'vitest'
import { markdownLinksToHtml } from './markdown-links'
import { renderProductText } from './products/render'

const chair = {
  name: 'Oslo Chair', options: 'Black', url: 'https://deskwell.co.uk/oslo', price: '£99.00',
} as Parameters<typeof renderProductText>[0][number]

describe('product text on a channel that writes links', () => {
  it('links the name and leaves the bare address off', () => {
    expect(renderProductText([chair], { markdownLinks: true }))
      .toBe('[Oslo Chair (Black)](https://deskwell.co.uk/oslo) - £99.00')
  })
  it('still prints the address on a channel that does not', () => {
    expect(renderProductText([chair])).toBe('Oslo Chair (Black) - £99.00\nhttps://deskwell.co.uk/oslo')
  })
  it('turns the links into escaped anchors', () => {
    expect(markdownLinksToHtml('<i>[A](https://x.test/a)</i>\nbye')).toBe(
      '&lt;i&gt;<a href="https://x.test/a" target="_blank" rel="noopener noreferrer">A</a>&lt;/i&gt;<br>bye',
    )
    expect(markdownLinksToHtml('plain')).toBeNull()
  })
})
