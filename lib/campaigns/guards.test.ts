import { describe, expect, it } from 'vitest'
import { BOUNCE_GUARD_MINIMUM, bounceVerdict, dayIsFull, isCampaignWideFailure } from './guards'
import { isBounceNotice, isPermanentBounce, isRealReply, looksLikeOutOfOffice } from './replies'

// The guards that stop a campaign on their own, and the rules that decide
// whether somebody actually replied. Nobody watches a screen for a fortnight,
// so all of this has to be right without supervision.

describe('the bounce guard', () => {
  it('says nothing until enough have gone to mean anything', () => {
    // Three out of four is a coincidence.
    expect(bounceVerdict(4, 3).pause).toBe(false)
    expect(bounceVerdict(BOUNCE_GUARD_MINIMUM - 1, 40).pause).toBe(false)
  })

  it('lets an ordinary bounce rate through', () => {
    expect(bounceVerdict(200, 4).pause).toBe(false)
  })

  it('stops at five per cent, and says so in numbers a person can act on', () => {
    const verdict = bounceVerdict(100, 9)
    expect(verdict.pause).toBe(true)
    if (verdict.pause) {
      expect(verdict.reason).toContain('9 of the first 100')
      expect(verdict.reason).toContain('9 per cent')
      expect(verdict.reason).toContain('Tidy the list')
    }
  })

  it('does not stop exactly at the threshold', () => {
    expect(bounceVerdict(100, 5).pause).toBe(false)
    expect(bounceVerdict(100, 6).pause).toBe(true)
  })
})

describe('the daily allowance', () => {
  it('never fills when there is no ceiling', () => {
    expect(dayIsFull(10_000, null)).toBe(false)
  })

  it('fills at the ceiling', () => {
    expect(dayIsFull(49, 50)).toBe(false)
    expect(dayIsFull(50, 50)).toBe(true)
    expect(dayIsFull(51, 50)).toBe(true)
  })
})

describe('telling one bad address from a broken campaign', () => {
  it('stops everything for a problem the next message would hit too', () => {
    expect(isCampaignWideFailure('Brevo will not send from that address yet. Whoever looks after the site...')).toBe(true)
    expect(isCampaignWideFailure('This site has no email account set up yet, so nothing can be sent.')).toBe(true)
    expect(isCampaignWideFailure('The email account details were not accepted.')).toBe(true)
    expect(isCampaignWideFailure('The email service is asking us to slow down.')).toBe(true)
  })

  it('marks one recipient and carries on for a problem with that recipient', () => {
    expect(isCampaignWideFailure('That address was rejected by the receiving server.')).toBe(false)
  })
})

describe('what counts as a reply', () => {
  it('counts a person typing something', () => {
    expect(isRealReply({ autoKind: null, subject: 'Re: your email' })).toBe(true)
  })

  it('does not count anything the collector already knew was machinery', () => {
    expect(isRealReply({ autoKind: 'bounce', subject: 'Undeliverable' })).toBe(false)
    expect(isRealReply({ autoKind: 'auto-reply', subject: 'Re: your email' })).toBe(false)
    expect(isRealReply({ autoKind: 'bulk', subject: 'Newsletter' })).toBe(false)
  })

  it('does not count an out-of-office whose headers said nothing', () => {
    // The case the headers miss: older Exchange servers and phones send these
    // with no Auto-Submitted header at all, and a fortnight's holiday would
    // otherwise cancel the chase.
    expect(isRealReply({ autoKind: null, subject: 'Out of Office: your email' })).toBe(false)
    expect(isRealReply({ autoKind: null, subject: 'Automatic reply: your email' })).toBe(false)
    expect(isRealReply({ autoKind: null, subject: 'Re: Automatic reply' })).toBe(false)
  })

  it('still counts a person writing about their broken auto-reply', () => {
    expect(looksLikeOutOfOffice('our automatic reply system is down')).toBe(false)
    expect(isRealReply({ autoKind: null, subject: 'our automatic reply system is down' })).toBe(true)
  })

  it('recognises the holiday phrases people actually get', () => {
    for (const subject of [
      'Out of office',
      'OUT OF THE OFFICE until Monday',
      'Autoreply: away',
      'Away from my desk',
      'On annual leave',
      'Automatic response',
    ]) {
      expect(looksLikeOutOfOffice(subject)).toBe(true)
    }
  })

  it('does not mistake an empty subject for machinery', () => {
    expect(looksLikeOutOfOffice(null)).toBe(false)
    expect(looksLikeOutOfOffice('')).toBe(false)
    expect(isRealReply({ autoKind: null, subject: null })).toBe(true)
  })
})

describe('which bounces mean never write again', () => {
  it('is only the permanent ones', () => {
    expect(isPermanentBounce('hard')).toBe(true)
    expect(isPermanentBounce('invalid')).toBe(true)
    expect(isPermanentBounce('blocked')).toBe(true)
  })

  it('is not a full mailbox on a Tuesday', () => {
    // Suppressing on one of these loses a customer permanently over a
    // temporary problem, which is the more expensive mistake of the two.
    expect(isPermanentBounce('soft')).toBe(false)
    expect(isPermanentBounce('deferred')).toBe(false)
    expect(isPermanentBounce('error')).toBe(false)
    expect(isPermanentBounce(null)).toBe(false)
    expect(isPermanentBounce(undefined)).toBe(false)
  })

  it('knows a delivery report when the collector has already labelled one', () => {
    expect(isBounceNotice({ autoKind: 'bounce' })).toBe(true)
    expect(isBounceNotice({ autoKind: null })).toBe(false)
  })
})
