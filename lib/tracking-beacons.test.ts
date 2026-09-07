import { describe, it, expect } from 'vitest'
import { isOpenBeacon, isClickWrapper } from './tracking-beacons'

// The addresses below are the real shapes, taken off messages sitting in a
// live Sent folder. Both halves of Brevo appear in one inbox - a quote goes out
// transactionally and a mailshot goes out through the marketing side - so both
// spellings have to be recognised, and the account subdomain in front of the
// host is different on every account.

describe('isOpenBeacon', () => {
  it('knows the counter Brevo puts in a message it sends', () => {
    expect(isOpenBeacon('https://bbibcjie.r.bh.d.sendibt3.com/tr/op/92jAGCf6US6-NZ534I7ez')).toBe(true)
    expect(isOpenBeacon('https://bbibcjie.r.af.d.sendibt2.com/tr/op/LGAYVafqljIAO4KAawxh')).toBe(true)
    expect(isOpenBeacon('https://x.r.sp1-brevo.net/mk/op/sh/abcdef/ghijkl')).toBe(true)
  })

  it('leaves an ordinary picture alone, including one hosted by the same service', () => {
    // /im/ is where a picture actually put in the message is served from, and
    // it carries no token naming a recipient. Refusing it would be a hole in
    // every mailshot we have ever sent.
    expect(isOpenBeacon('https://bbibcjie.r.bh.d.sendibt3.com/im/11812984')).toBe(false)
    expect(isOpenBeacon('https://deskwell.co.uk/media/chair.jpg')).toBe(false)
    expect(isOpenBeacon('https://example.com/tropical/opening-times.png')).toBe(false)
  })

  it('is not talked round by something that is not a web address at all', () => {
    expect(isOpenBeacon('')).toBe(false)
    expect(isOpenBeacon('   ')).toBe(false)
    expect(isOpenBeacon('cid:image001@01D9')).toBe(false)
    expect(isOpenBeacon('javascript:alert(1)//tr/op/x')).toBe(false)
    expect(isOpenBeacon('not an address')).toBe(false)
  })

  it('reads a scheme-relative address the way a browser would', () => {
    expect(isOpenBeacon('//bbibcjie.r.bh.d.sendibt3.com/tr/op/token')).toBe(true)
  })
})

describe('isClickWrapper', () => {
  it('knows a rewritten link from the real one', () => {
    expect(isClickWrapper('https://bbibcjie.r.af.d.sendibt2.com/tr/cl/LGAYVafqlj')).toBe(true)
    expect(isClickWrapper('https://x.r.sp1-brevo.net/mk/cl/f/sh/abcdef')).toBe(true)
    expect(isClickWrapper('https://deskwell.co.uk/shop/chairs')).toBe(false)
    expect(isClickWrapper('mailto:sales@deskwell.co.uk')).toBe(false)
  })

  it('does not confuse the two counters, which mean different things', () => {
    const open = 'https://bbibcjie.r.bh.d.sendibt3.com/tr/op/token'
    const click = 'https://bbibcjie.r.bh.d.sendibt3.com/tr/cl/token'
    expect([isOpenBeacon(open), isClickWrapper(open)]).toEqual([true, false])
    expect([isOpenBeacon(click), isClickWrapper(click)]).toEqual([false, true])
  })
})
