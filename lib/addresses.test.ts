import { describe, it, expect } from 'vitest'
import {
  addressDomain,
  isValidAddress,
  normaliseAddress,
  parseAddressList,
  placeMessage,
  routeSentToInbox,
  routeToInbox,
  shouldDiscardUnrouted,
} from './addresses'

describe('normaliseAddress', () => {
  it('strips a display name and the angle brackets round the address', () => {
    expect(normaliseAddress('"Brown, Marcus" <Marcus@Deskwell.co.uk>')).toBe('marcus@deskwell.co.uk')
  })

  it('lower-cases a bare address', () => {
    expect(normaliseAddress('  HI@Deskwell.CO.UK ')).toBe('hi@deskwell.co.uk')
  })
})

describe('parseAddressList', () => {
  it('splits several addresses', () => {
    expect(parseAddressList('hi@a.com, Marcus <marcus@b.com>')).toEqual(['hi@a.com', 'marcus@b.com'])
  })

  it('does not split on a comma inside a quoted display name', () => {
    expect(parseAddressList('"Brown, Marcus" <marcus@b.com>, hi@a.com'))
      .toEqual(['marcus@b.com', 'hi@a.com'])
  })

  it('treats nothing as no addresses', () => {
    expect(parseAddressList(null)).toEqual([])
    expect(parseAddressList('')).toEqual([])
  })
})

describe('addressDomain', () => {
  it('reads the domain', () => {
    expect(addressDomain('Marcus@Deskwell.co.uk')).toBe('deskwell.co.uk')
  })

  it('gives nothing back for something that is not an address', () => {
    expect(addressDomain('marcus')).toBeNull()
    expect(addressDomain('@deskwell.co.uk')).toBeNull()
  })
})

describe('isValidAddress', () => {
  it('accepts an ordinary address', () => {
    expect(isValidAddress('hi@deskwell.co.uk')).toBe(true)
  })

  it('rejects the near misses', () => {
    expect(isValidAddress('hi@deskwell')).toBe(false)
    expect(isValidAddress('hi deskwell.co.uk')).toBe(false)
    expect(isValidAddress('@deskwell.co.uk')).toBe(false)
  })
})

describe('routeToInbox', () => {
  const inboxes = [
    { id: 'hi', address: 'hi@deskwell.co.uk', isCatchAll: false },
    { id: 'marcus', address: 'marcus@deskwell.co.uk', isCatchAll: false },
    { id: 'general', address: 'general@deskwell.co.uk', isCatchAll: true },
  ]

  it('prefers the delivered-to address over the To line', () => {
    expect(routeToInbox({
      deliveredTo: ['marcus@deskwell.co.uk'],
      to: ['hi@deskwell.co.uk'],
    }, inboxes)).toEqual({ inboxId: 'marcus', matchedOn: 'delivered-to' })
  })

  it('falls back to To, then Cc', () => {
    expect(routeToInbox({ to: ['hi@deskwell.co.uk'] }, inboxes))
      .toEqual({ inboxId: 'hi', matchedOn: 'to' })
    expect(routeToInbox({ to: ['someone@else.com'], cc: ['marcus@deskwell.co.uk'] }, inboxes))
      .toEqual({ inboxId: 'marcus', matchedOn: 'cc' })
  })

  it('ignores case and display names in the headers', () => {
    expect(routeToInbox({ deliveredTo: ['"Sales" <HI@Deskwell.CO.UK>'] }, inboxes))
      .toEqual({ inboxId: 'hi', matchedOn: 'delivered-to' })
  })

  it('sends anything unmatched to the catch-all', () => {
    expect(routeToInbox({ to: ['nobody@elsewhere.com'] }, inboxes))
      .toEqual({ inboxId: 'general', matchedOn: 'catch-all' })
  })

  it('says so plainly when there is no catch-all to fall back on', () => {
    expect(routeToInbox({ to: ['nobody@elsewhere.com'] }, inboxes.slice(0, 2)))
      .toEqual({ inboxId: null, matchedOn: 'none' })
  })
})

describe('routeSentToInbox', () => {
  const inboxes = [
    { id: 'hi', address: 'hi@deskwell.co.uk', isCatchAll: true },
    { id: 'marcus', address: 'marcus@deskwell.co.uk', isCatchAll: false },
  ]

  it('files our own sent mail under the address it was sent as', () => {
    // The recipient is a customer and matches no inbox at all, so the From line
    // is the only thing that can say which conversation this belongs to.
    expect(routeSentToInbox(['marcus@deskwell.co.uk'], { to: ['customer@example.com'] }, inboxes))
      .toEqual({ inboxId: 'marcus', matchedOn: 'from' })
  })

  it('is not fooled by the case somebody typed', () => {
    expect(routeSentToInbox(['Marcus@Deskwell.co.uk'], { to: ['customer@example.com'] }, inboxes).inboxId)
      .toBe('marcus')
  })

  it('falls back to the ordinary rules when it was sent from an address we do not serve', () => {
    expect(routeSentToInbox(['personal@example.com'], { to: ['marcus@deskwell.co.uk'] }, inboxes))
      .toEqual({ inboxId: 'marcus', matchedOn: 'to' })
  })

  it('lands in the catch-all when nothing else claims it', () => {
    expect(routeSentToInbox(['personal@example.com'], { to: ['nobody@example.com'] }, inboxes))
      .toEqual({ inboxId: 'hi', matchedOn: 'catch-all' })
  })
})

describe('shouldDiscardUnrouted', () => {
  it('keeps everything while the account has not been told otherwise', () => {
    // The default, and the only acceptable one for a setting about somebody's
    // mail: an install updating into this column behaves as it did yesterday.
    expect(shouldDiscardUnrouted({ enabled: false, inboxId: null, threadId: null })).toBe(false)
  })

  it('drops a new conversation addressed to none of our addresses', () => {
    // The case the setting exists for: a personal account whose INBOX carries
    // the owner's bank, doctor and credit agency alongside the shop's mail.
    expect(shouldDiscardUnrouted({ enabled: true, inboxId: null, threadId: null })).toBe(true)
  })

  it('keeps a message that routes nowhere but joins a conversation we hold', () => {
    // A third party brought in halfway, or an address that appears only in a
    // Bcc. Dropping these leaves a thread reading as though somebody stopped
    // replying.
    expect(shouldDiscardUnrouted({ enabled: true, inboxId: null, threadId: 'thread-1' })).toBe(false)
  })

  it('never touches mail that reached one of our addresses', () => {
    expect(shouldDiscardUnrouted({ enabled: true, inboxId: 'marcus', threadId: null })).toBe(false)
  })
})

describe('placeMessage', () => {
  const chris = { id: 'chris', address: 'chris@deskwell.co.uk', isCatchAll: false }
  const emma = { id: 'emma', address: 'emma@deskwell.co.uk', isCatchAll: false }
  const general = { id: 'general', address: 'general@deskwell.co.uk', isCatchAll: true }
  const inboxes = [chris, emma, general]
  const ownAddresses = ['chris@deskwell.co.uk', 'emma@deskwell.co.uk', 'general@deskwell.co.uk']

  it('files one colleague writing to another as post for the colleague', () => {
    // The bug this function exists for. Found in Emma's folder, from an address
    // this site also serves: called outbound, it lands on Chris and Emma never
    // sees the message she was sent, nor can anything reply to it.
    expect(placeMessage({
      inSentFolder: false,
      fromAddress: 'chris@deskwell.co.uk',
      ownAddresses,
      headers: { to: ['emma@deskwell.co.uk'] },
      inboxes,
    })).toEqual({ direction: 'in', routing: { inboxId: 'emma', matchedOn: 'to' } })
  })

  it('leaves the same message outbound when it is the copy in the Sent folder', () => {
    // The mail server is stating the account sent it. Whichever copy of a
    // message is met first is the one that gets stored, so this is also the
    // reason a Sent folder must never be read before the folder mail is
    // delivered into.
    expect(placeMessage({
      inSentFolder: true,
      fromAddress: 'chris@deskwell.co.uk',
      ownAddresses,
      headers: { to: ['emma@deskwell.co.uk'] },
      inboxes,
    })).toEqual({ direction: 'out', routing: { inboxId: 'chris', matchedOn: 'from' } })
  })

  it('keeps our reply to a customer outbound wherever it was found', () => {
    expect(placeMessage({
      inSentFolder: false,
      fromAddress: 'chris@deskwell.co.uk',
      ownAddresses,
      headers: { to: ['customer@example.com'] },
      inboxes,
    })).toEqual({ direction: 'out', routing: { inboxId: 'chris', matchedOn: 'from' } })
  })

  it('does not let the catch-all turn our own outgoing mail into post for somebody', () => {
    // general@ sweeps up anything nobody here was named on. If that counted as
    // a colleague being written to, every reply the shop sent a customer would
    // arrive as unread mail for whoever holds the catch-all.
    const placed = placeMessage({
      inSentFolder: false,
      fromAddress: 'chris@deskwell.co.uk',
      ownAddresses,
      headers: { to: ['customer@example.com'] },
      inboxes,
    })
    expect(placed.direction).toBe('out')
    expect(placed.routing.inboxId).toBe('chris')
  })

  it('treats a note to ourselves as something we sent', () => {
    expect(placeMessage({
      inSentFolder: false,
      fromAddress: 'chris@deskwell.co.uk',
      ownAddresses,
      headers: { to: ['chris@deskwell.co.uk'] },
      inboxes,
    })).toEqual({ direction: 'out', routing: { inboxId: 'chris', matchedOn: 'from' } })
  })

  it('looks past our own address in the recipients to find the colleague', () => {
    // Written to self and copied to Emma. The To line matches first and would
    // settle on the writer, which is how a message addressed to somebody else
    // ends up filed as though it were addressed to nobody.
    expect(placeMessage({
      inSentFolder: false,
      fromAddress: 'chris@deskwell.co.uk',
      ownAddresses,
      headers: { to: ['chris@deskwell.co.uk'], cc: ['emma@deskwell.co.uk'] },
      inboxes,
    })).toEqual({ direction: 'in', routing: { inboxId: 'emma', matchedOn: 'cc' } })
  })

  it('routes a colleague message on Delivered-To ahead of the To line', () => {
    expect(placeMessage({
      inSentFolder: false,
      fromAddress: 'chris@deskwell.co.uk',
      ownAddresses,
      headers: { deliveredTo: ['emma@deskwell.co.uk'], to: ['customer@example.com'] },
      inboxes,
    })).toEqual({ direction: 'in', routing: { inboxId: 'emma', matchedOn: 'delivered-to' } })
  })

  it('counts the mail login itself as one of ours without it being an inbox', () => {
    // The account is christaylor249@me.com and the site's addresses are folders
    // inside it. Mail the owner sent from the login to a colleague is still the
    // colleague's post.
    expect(placeMessage({
      inSentFolder: false,
      fromAddress: 'christaylor249@me.com',
      ownAddresses: [...ownAddresses, 'christaylor249@me.com'],
      headers: { to: ['emma@deskwell.co.uk'] },
      inboxes,
    })).toEqual({ direction: 'in', routing: { inboxId: 'emma', matchedOn: 'to' } })
  })

  it('leaves ordinary customer mail exactly as it was', () => {
    expect(placeMessage({
      inSentFolder: false,
      fromAddress: 'customer@example.com',
      ownAddresses,
      headers: { to: ['emma@deskwell.co.uk'] },
      inboxes,
    })).toEqual({ direction: 'in', routing: { inboxId: 'emma', matchedOn: 'to' } })
  })

  it('files mail from a stranger to nobody here under the catch-all, inbound', () => {
    expect(placeMessage({
      inSentFolder: false,
      fromAddress: 'customer@example.com',
      ownAddresses,
      headers: { to: ['someone@elsewhere.com'] },
      inboxes,
    })).toEqual({ direction: 'in', routing: { inboxId: 'general', matchedOn: 'catch-all' } })
  })

  it('handles a message with no From line at all', () => {
    expect(placeMessage({
      inSentFolder: false,
      fromAddress: null,
      ownAddresses,
      headers: { to: ['emma@deskwell.co.uk'] },
      inboxes,
    })).toEqual({ direction: 'in', routing: { inboxId: 'emma', matchedOn: 'to' } })
  })

  it('ignores case and display names on both sides', () => {
    expect(placeMessage({
      inSentFolder: false,
      fromAddress: '"Chris" <Chris@Deskwell.CO.UK>',
      ownAddresses: ['CHRIS@deskwell.co.uk', 'emma@deskwell.co.uk'],
      headers: { to: ['"Emma Scott" <Emma@Deskwell.co.uk>'] },
      inboxes,
    })).toEqual({ direction: 'in', routing: { inboxId: 'emma', matchedOn: 'to' } })
  })

  // The live regression, 2 September 2026. chris@deskwell.co.uk wrote to
  // emma@deskwell.co.uk while chris@ was not yet an address this site served.
  // An inbox for chris@ was added half an hour later, and the next sync read
  // the same message again, now recognised its sender as one of our own, and
  // rebuilt it as outbound on Chris. It left Emma's inbox and the agent working
  // that inbox never saw it. Adding an address must not move a colleague's post
  // out from under them.
  describe('when an inbox is added after the message was first read', () => {
    const message = {
      inSentFolder: false,
      fromAddress: 'chris@deskwell.co.uk',
      headers: { to: ['emma@deskwell.co.uk'] },
    }

    it('placed it with Emma before chris@ was an address here', () => {
      expect(placeMessage({
        ...message,
        ownAddresses: ['emma@deskwell.co.uk'],
        inboxes: [emma],
      })).toEqual({ direction: 'in', routing: { inboxId: 'emma', matchedOn: 'to' } })
    })

    it('places it with Emma still, once chris@ is an address here', () => {
      expect(placeMessage({
        ...message,
        ownAddresses,
        inboxes: [chris, emma],
      })).toEqual({ direction: 'in', routing: { inboxId: 'emma', matchedOn: 'to' } })
    })
  })
})
