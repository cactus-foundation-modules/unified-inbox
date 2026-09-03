import { describe, expect, it } from 'vitest'
import { chooseRelayCopy, RELAY_COPY_WINDOW_MS, type OutboundCandidate } from './relay-copy'

const sent = new Date('2026-09-03T02:17:07.461Z')

function candidate(overrides: Partial<OutboundCandidate> = {}): OutboundCandidate {
  return {
    id: 'row-1',
    threadId: 'thread-1',
    messageIdHeader: 'uin.abc@deskwell.co.uk',
    toAddresses: ['chris@deskwell.co.uk'],
    ccAddresses: [],
    subject: 'Re: Artisan Furniture',
    sentAt: sent,
    ...overrides,
  }
}

const delivered = {
  toAddresses: ['chris@deskwell.co.uk'],
  ccAddresses: [],
  subject: 'Re: Artisan Furniture',
  // The delivered copy carries the relay's clock, to the second.
  sentAt: new Date('2026-09-03T02:17:07.000Z'),
}

describe('chooseRelayCopy', () => {
  it('claims the reply we sent seconds earlier', () => {
    expect(chooseRelayCopy([candidate()], delivered)?.id).toBe('row-1')
  })

  it('ignores capitalisation and order in the recipients', () => {
    const match = chooseRelayCopy(
      [candidate({ toAddresses: ['Emma@Deskwell.co.uk', 'CHRIS@deskwell.co.uk'] })],
      { ...delivered, toAddresses: ['chris@deskwell.co.uk', 'emma@deskwell.co.uk'] },
    )
    expect(match?.id).toBe('row-1')
  })

  it('treats Re: and the bare subject as the same conversation', () => {
    expect(chooseRelayCopy([candidate({ subject: 'Artisan Furniture' })], delivered)?.id).toBe('row-1')
  })

  it('will not claim a message sent to somebody else', () => {
    expect(chooseRelayCopy([candidate({ toAddresses: ['someone@example.com'] })], delivered)).toBeNull()
  })

  it('will not claim a message about something else', () => {
    expect(chooseRelayCopy([candidate({ subject: 'Re: Invoice 12' })], delivered)).toBeNull()
  })

  it('will not claim a message with an extra recipient', () => {
    expect(
      chooseRelayCopy([candidate({ ccAddresses: ['emma@deskwell.co.uk'] })], delivered),
    ).toBeNull()
  })

  it('will not reach past the window', () => {
    const old = candidate({ sentAt: new Date(delivered.sentAt.getTime() - RELAY_COPY_WINDOW_MS - 1) })
    expect(chooseRelayCopy([old], delivered)).toBeNull()
  })

  it('pairs two replies a minute apart with the nearer one', () => {
    const first = candidate({ id: 'row-1', sentAt: new Date(delivered.sentAt.getTime() - 60_000) })
    const second = candidate({ id: 'row-2', sentAt: new Date(delivered.sentAt.getTime() + 400) })
    expect(chooseRelayCopy([first, second], delivered)?.id).toBe('row-2')
  })

  it('has nothing to say about a message from a customer', () => {
    expect(chooseRelayCopy([], delivered)).toBeNull()
  })
})
