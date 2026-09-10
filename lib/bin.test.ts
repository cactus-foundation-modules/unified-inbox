import { describe, it, expect } from 'vitest'
import { binOwnerFor } from './bin'
import { spamOwnerFor } from './spam'

// Whose bin it goes into.
//
// The rest of lib/bin.ts is three one-line queries. This is the decision, and
// it is the one with a wrong answer in it: get it backwards and a colleague
// covering somebody's post fills their own bin with a fortnight of somebody
// else's deletions, while the folder the owner would look in stays empty - and
// this is the folder with a button on it that destroys what it holds.
//
// The first test is the important one and it is about identity rather than
// behaviour. The bin and the junk folder answer this question the same way ON
// PURPOSE, and they are the same function so that they cannot stop doing so.
// Two implementations would drift the moment somebody "fixed" one of them, and
// the module would then disagree with itself about which folder a conversation
// went into - which is not an abstract worry on a screen where one of the two
// folders can be emptied.

const SAM = 'user-sam'
const COVERER = 'user-marcus'

describe('binOwnerFor', () => {
  it('is the junk rule, and is the same function so it cannot drift from it', () => {
    expect(binOwnerFor).toBe(spamOwnerFor)
  })

  it('puts something deleted out of a shared address in the bin of whoever deleted it', () => {
    // sales@ belongs to the team, so there is nobody whose post it is and the
    // decision is the presser's own. This is the ordinary case on most sites.
    expect(binOwnerFor({
      pressedByUserId: COVERER,
      inbox: { kind: 'shared', ownerUserId: null },
    })).toBe(COVERER)
  })

  it('puts something deleted out of a colleague’s own address in THEIR bin', () => {
    // The whole point. Somebody covering Sam's inbox while Sam is away is
    // working Sam's post on Sam's behalf: what they throw away goes in Sam's
    // bin, leaves Sam's lists, and can be found again under Sam's name on the
    // rail - which is the only way back from a mis-click while covering.
    expect(binOwnerFor({
      pressedByUserId: COVERER,
      inbox: { kind: 'individual', ownerUserId: SAM },
    })).toBe(SAM)
  })

  it('comes to the same person on your own address', () => {
    expect(binOwnerFor({
      pressedByUserId: SAM,
      inbox: { kind: 'individual', ownerUserId: SAM },
    })).toBe(SAM)
  })

  it('falls back to the presser where there is nobody whose bin it could be', () => {
    // An individual address whose owner's account has gone, and a conversation
    // filed nowhere at all - a live chat, a call, an unrouted email. Both would
    // otherwise write a row pointing at nobody, which the foreign key refuses
    // and which would fail the press with nothing useful to say about why.
    expect(binOwnerFor({
      pressedByUserId: COVERER,
      inbox: { kind: 'individual', ownerUserId: null },
    })).toBe(COVERER)
    expect(binOwnerFor({ pressedByUserId: COVERER, inbox: null })).toBe(COVERER)
  })

  it('ignores an owner on a shared address rather than trusting the column', () => {
    // owner_user_id is only meaningful on an individual address. A shared one
    // carrying a stray value - a kind changed after the fact, a restored
    // backup - must not quietly start filing the team's deletions into one
    // person's bin, so the kind is checked and not just the column.
    expect(binOwnerFor({
      pressedByUserId: COVERER,
      inbox: { kind: 'shared', ownerUserId: SAM },
    })).toBe(COVERER)
  })
})
