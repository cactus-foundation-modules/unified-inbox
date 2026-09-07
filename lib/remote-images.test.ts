import { describe, it, expect } from 'vitest'
import { blockRemoteImages } from './html'
import {
  fetchRemoteImage,
  remoteImageUrls,
  restoreRemoteImages,
  showableRemoteImageUrls,
} from './remote-images'

/** The counter Brevo adds to a message on the way out. It comes back in the
 *  Sent copy, and fetching it files an open against the send. */
const BEACON = 'https://bbibcjie.r.bh.d.sendibt3.com/tr/op/92jAGCf6US6-NZ534I7ez'

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

// ---------------------------------------------------------------------------
// Reading our own Sent post must not tell Brevo the customer read it.
//
// Pictures in a message from ourselves are shown without being asked for, so
// there is no press of a button standing between opening the Sent folder and
// the site fetching every remote address in it - and one of those addresses is
// the counter Brevo added on the way out. Every assertion below is about that
// one request never happening.
// ---------------------------------------------------------------------------

describe('the sending service is never told a message was opened', () => {
  it('leaves the counter parked while showing the pictures around it', () => {
    const stored = blockRemoteImages(
      `<img src="https://a.example/logo.png"><img src="${BEACON}" width="1" height="1">`,
    )
    const shown = restoreRemoteImages(stored, (i) => `/proxy/${i}`)
    expect(shown).toContain('src="/proxy/0"')
    // Nothing points at the beacon, so the frame makes no request for it - and
    // the address it was parked on is not a src, so the browser will not either.
    expect(shown).not.toContain('src="/proxy/1"')
    expect(shown).toContain('data-uin-remote-src')
    expect(shown).toContain('/tr/op/')
  })

  it('keeps the numbering when the counter comes first, which is where it usually is', () => {
    const stored = blockRemoteImages(
      `<img src="${BEACON}"><img src="https://a.example/logo.png">`,
    )
    const urls = remoteImageUrls(stored)
    expect(urls).toHaveLength(2)
    const shown = restoreRemoteImages(stored, (i) => `#${i}:${urls[i]}`)
    // Picture one is still picture one to the route that fetches it, however
    // many beacons were skipped on the way past.
    expect(shown).toContain('#1:https://a.example/logo.png')
    expect(shown).not.toContain('#0:')
  })

  it('does not offer to show pictures when the only one is a counter', () => {
    const stored = blockRemoteImages(`<img src="${BEACON}">`)
    expect(remoteImageUrls(stored)).toHaveLength(1)
    expect(showableRemoteImageUrls(stored)).toHaveLength(0)
  })

  it('refuses to fetch one even when its number is asked for by hand', async () => {
    const result = await fetchRemoteImage(BEACON)
    expect(result.ok).toBe(false)
  })
})
