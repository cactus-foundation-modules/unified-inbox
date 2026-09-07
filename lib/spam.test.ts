import { describe, it, expect } from 'vitest'
import { spamOwnerFor } from './spam'

// Whose bin it goes into.
//
// The rest of lib/spam.ts is three one-line queries. This is the decision, and
// it is the one with a wrong answer in it: get it backwards and a colleague
// covering somebody's post spends a fortnight filling their own spam folder
// with a stranger's rubbish, while the inbox they were clearing stays exactly
// as full as it was.

const SAM = 'user-sam'
const COVERER = 'user-marcus'

describe('spamOwnerFor', () => {
  it('puts junk from a shared address in the bin of whoever threw it away', () => {
    // sales@ belongs to the team, so there is nobody whose post it is and the
    // opinion is the presser's own. This is the ordinary case on most sites.
    expect(spamOwnerFor({
      pressedByUserId: COVERER,
      inbox: { kind: 'shared', ownerUserId: null },
    })).toBe(COVERER)
  })

  it('puts junk from a colleague’s own address in THEIR bin, not the coverer’s', () => {
    // The whole point. Somebody covering Sam's inbox while Sam is away is
    // working Sam's post on Sam's behalf: what they clear out is out of Sam's
    // bin, and it leaves Sam's lists - which is what covering somebody is for.
    expect(spamOwnerFor({
      pressedByUserId: COVERER,
      inbox: { kind: 'individual', ownerUserId: SAM },
    })).toBe(SAM)
  })

  it('comes to the same person on your own address', () => {
    expect(spamOwnerFor({
      pressedByUserId: SAM,
      inbox: { kind: 'individual', ownerUserId: SAM },
    })).toBe(SAM)
  })

  it('falls back to the presser on an individual address whose owner has gone', () => {
    // A staff account is deleted and the address survives it, holding a null
    // owner. There is nobody whose bin it could be, so it is the presser's -
    // rather than a row pointing at nobody, which the foreign key would refuse
    // and which would fail the press with nothing useful to say about why.
    expect(spamOwnerFor({
      pressedByUserId: COVERER,
      inbox: { kind: 'individual', ownerUserId: null },
    })).toBe(COVERER)
  })

  it('falls back to the presser on a conversation filed nowhere at all', () => {
    // A live chat, a call, an enquiry addressed at no inbox, an unrouted email.
    // No address means no owner.
    expect(spamOwnerFor({ pressedByUserId: COVERER, inbox: null })).toBe(COVERER)
  })

  it('ignores an owner on a shared address rather than trusting the column', () => {
    // owner_user_id is only meaningful on an individual address. A shared one
    // carrying a stray value - a kind changed after the fact, a restored
    // backup - must not quietly start filing the team's junk into one person's
    // bin, so the kind is checked and not just the column.
    expect(spamOwnerFor({
      pressedByUserId: COVERER,
      inbox: { kind: 'shared', ownerUserId: SAM },
    })).toBe(COVERER)
  })
})
