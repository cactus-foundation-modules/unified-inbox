import { describe, it, expect } from 'vitest'
import { shouldRefuseSender } from './blocked-senders'

// The door, tested at the one point where it can be wrong.
//
// Everything else in blocked-senders.ts is a query. This is the decision, it
// runs on every message the site ever collects, and both of the ways it can go
// wrong are silent: refuse too much and a colleague's own replies stop reaching
// their conversations, refuse too little and the block does nothing while
// looking like it worked.

const blocked = new Set(['spam@example.com', 'nuisance@example.net'])

describe('shouldRefuseSender', () => {
  it('turns away inbound mail from somebody on the list', () => {
    expect(shouldRefuseSender({
      direction: 'in', fromAddress: 'spam@example.com', blocked,
    })).toBe(true)
  })

  it('lets everybody else in', () => {
    expect(shouldRefuseSender({
      direction: 'in', fromAddress: 'customer@example.com', blocked,
    })).toBe(false)
  })

  it('never refuses our own writing coming back out of Sent', () => {
    // The copy of a reply a colleague typed on their phone arrives here as an
    // OUTBOUND message. If the account's owner is themselves on somebody's
    // block list - a shared mailbox two sites both collect, an address blocked
    // by mistake - refusing this would quietly stop their replies ever reaching
    // the conversations they belong to, and nothing on any screen would say so.
    expect(shouldRefuseSender({
      direction: 'out', fromAddress: 'spam@example.com', blocked,
    })).toBe(false)
  })

  it('does not refuse mail that has no sender at all', () => {
    // Unusual, and not by itself a reason to think it is from anybody in
    // particular. It goes through and is filed like anything else.
    expect(shouldRefuseSender({ direction: 'in', fromAddress: null, blocked })).toBe(false)
  })

  it('matches on the whole address, never on part of it', () => {
    // A block on spam@example.com is not a block on example.com, and it is
    // certainly not a block on notspam@example.com. Blocking a domain is a
    // different feature with a much bigger blast radius, and it is not this one.
    expect(shouldRefuseSender({
      direction: 'in', fromAddress: 'notspam@example.com', blocked,
    })).toBe(false)
    expect(shouldRefuseSender({
      direction: 'in', fromAddress: 'example.com', blocked,
    })).toBe(false)
  })

  it('lets everybody in when nobody is blocked, which is most sites', () => {
    expect(shouldRefuseSender({
      direction: 'in', fromAddress: 'spam@example.com', blocked: new Set(),
    })).toBe(false)
  })

  it('compares what it is given, so the caller has to have normalised it', () => {
    // The set holds normalised addresses (lib/addresses.ts: trimmed, lower
    // case, angle brackets off) and so must the address handed in. Asserted
    // rather than papered over inside the function: normalising here as well
    // would hide a caller that had not, and the one caller that matters runs on
    // every message of every collection.
    expect(shouldRefuseSender({
      direction: 'in', fromAddress: 'Spam@Example.com', blocked,
    })).toBe(false)
  })
})
