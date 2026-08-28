import { describe, it, expect } from 'vitest'
import { blockRemoteImages } from './html'
import { remoteImageUrls, restoreRemoteImages } from './remote-images'

describe('remoteImageUrls', () => {
  it('reads back exactly what the sync engine parked, in order', () => {
    const stored = blockRemoteImages(
      '<img src="https://a.example/one.png"><img src="https://b.example/two.png">',
    )
    expect(remoteImageUrls(stored)).toEqual([
      'https://a.example/one.png',
      'https://b.example/two.png',
    ])
  })

  it('decodes an address that carried a quote through the attribute', () => {
    const stored = blockRemoteImages('<img src="https://a.example/x.png?a=1&amp;b=2">')
    expect(remoteImageUrls(stored)[0]).toBe('https://a.example/x.png?a=1&b=2')
  })

  it('finds nothing in a message with no pictures', () => {
    expect(remoteImageUrls('<p>hello</p>')).toEqual([])
    expect(remoteImageUrls(null)).toEqual([])
  })
})

describe('restoreRemoteImages', () => {
  it('points every picture at this site rather than at the sender', () => {
    const stored = blockRemoteImages(
      '<img src="https://a.example/one.png"><img src="https://b.example/two.png">',
    )
    const shown = restoreRemoteImages(stored, (i) => `/proxy/${i}`)
    expect(shown).toContain('src="/proxy/0"')
    expect(shown).toContain('src="/proxy/1"')
    // The sender's own address never reaches the browser.
    expect(shown).not.toContain('a.example')
    expect(shown).not.toContain('data-uin-remote-src')
  })

  it('numbers the pictures the same way remoteImageUrls does, which is the whole contract', () => {
    const stored = blockRemoteImages(
      '<img src="https://a.example/one.png"><img src="cid:embedded"><img src="https://b.example/two.png">',
    )
    const urls = remoteImageUrls(stored)
    const shown = restoreRemoteImages(stored, (i) => `#${i}:${urls[i]}`)
    expect(shown).toContain('#0:https://a.example/one.png')
    expect(shown).toContain('#1:https://b.example/two.png')
  })
})
