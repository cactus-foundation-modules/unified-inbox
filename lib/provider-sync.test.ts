import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ConversationProvider, ResolvedConversationProvider } from '@/lib/conversations/types'

// Copying in the channels somebody else owns.
//
// The three things worth holding on to: a settled conversation costs one call
// and not two, a provider that misbehaves costs its own channel and nothing
// else, and a reply typed here does not come back as a second message when the
// far end hands its own copy over.

const providerThreadState = vi.hoisted(() => vi.fn())
const upsertProviderThread = vi.hoisted(() => vi.fn())
const insertProviderMessage = vi.hoisted(() => vi.fn())
const claimLocalOutbound = vi.hoisted(() => vi.fn())
const recountProviderThread = vi.hoisted(() => vi.fn())
const providerWatermarks = vi.hoisted(() => vi.fn())
const allConversationProviders = vi.hoisted(() => vi.fn())
// Already open by default, so the ordinary case writes no timeline entry. The
// tests that care about reopening say so themselves.
const reopenOnReply = vi.hoisted(() => vi.fn(async (): Promise<'snoozed' | 'done' | null> => null))
const recordEvent = vi.hoisted(() => vi.fn())
const markProviderContentRead = vi.hoisted(() => vi.fn())
// Nobody is blocked unless a test says so. Mocked rather than left to reach the
// database, because collecting a channel now asks the site's block list once per
// pass and this suite has no database at all.
const blockedSenderSet = vi.hoisted(() => vi.fn(async (): Promise<Set<string>> => new Set()))

vi.mock('./db', () => ({
  providerThreadState,
  upsertProviderThread,
  insertProviderMessage,
  claimLocalOutbound,
  recountProviderThread,
  providerWatermarks,
  reopenOnReply,
  recordEvent,
  markProviderContentRead,
}))
vi.mock('./provider-registry', () => ({ allConversationProviders }))
vi.mock('./blocked-senders', () => ({ blockedSenderSet }))

const { syncProvider, syncAllProviders } = await import('./provider-sync')

function summary(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'c1',
    channel: 'chat',
    subject: 'Chat with Ada',
    preview: 'hello',
    participant: { name: 'Ada', email: 'ada@example.com', phone: null },
    lastMessageAt: new Date('2026-08-28T10:00:00Z'),
    unread: true,
    status: 'open',
    href: 'inbox?tab=live-chat',
    ...over,
  }
}

function message(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'm1',
    direction: 'in',
    authorName: 'Ada',
    text: 'hello',
    html: null,
    sentAt: new Date('2026-08-28T10:00:00Z'),
    attachments: [],
    ...over,
  }
}

function resolved(provider: Partial<ConversationProvider>): ResolvedConversationProvider {
  return {
    moduleName: 'live-chat',
    id: 'live-chat',
    provider: {
      label: 'Live chat',
      channel: 'chat',
      capabilities: { reply: true, markRead: true, byIdentity: true },
      list: vi.fn(),
      thread: vi.fn(),
      ...provider,
    } as ConversationProvider,
  }
}

beforeEach(() => {
  providerThreadState.mockReset().mockResolvedValue(null)
  upsertProviderThread.mockReset().mockResolvedValue({ id: 't1', created: true })
  insertProviderMessage.mockReset().mockResolvedValue('msg1')
  claimLocalOutbound.mockReset().mockResolvedValue(false)
  recountProviderThread.mockReset().mockResolvedValue(undefined)
  providerWatermarks.mockReset().mockResolvedValue({})
  reopenOnReply.mockReset().mockResolvedValue(null)
  recordEvent.mockReset().mockResolvedValue(undefined)
  markProviderContentRead.mockReset().mockResolvedValue(undefined)
  allConversationProviders.mockReset().mockResolvedValue([])
  blockedSenderSet.mockReset().mockResolvedValue(new Set())
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('syncProvider', () => {
  it('collects nothing at all from a party the site has blocked', async () => {
    // The block covers the channels as well as the post, and it has to: an
    // enquiry form is the obvious way round an email block - the same person,
    // the same address, arriving through a different door into the same inbox.
    // So the conversation is not opened, not filed and not counted. Not opened
    // matters on its own: asking the owning module for the messages is the
    // expensive half, and there is nothing here worth paying for.
    blockedSenderSet.mockResolvedValue(new Set(['ada@example.com']))
    const thread = vi.fn().mockResolvedValue({ summary: summary(), messages: [message()] })

    const outcome = await syncProvider(
      resolved({ list: vi.fn().mockResolvedValue({ items: [summary()] }), thread }),
    )

    expect(thread).not.toHaveBeenCalled()
    expect(upsertProviderThread).not.toHaveBeenCalled()
    expect(insertProviderMessage).not.toHaveBeenCalled()
    expect(outcome.conversations).toBe(0)
    expect(outcome.messages).toBe(0)
    // Refused rather than broken: the pass is still a success, it simply had
    // nothing to bring back.
    expect(outcome.ok).toBe(true)
  })

  it('lets everybody else through, including a party with no address at all', async () => {
    // A live chat with an anonymous visitor and a call from a withheld number
    // have nobody to match against, and refusing on a name would refuse the
    // wrong people.
    blockedSenderSet.mockResolvedValue(new Set(['ada@example.com']))
    const anonymous = summary({ participant: { name: 'Someone', email: null, phone: null } })
    const thread = vi.fn().mockResolvedValue({ summary: anonymous, messages: [message()] })

    await syncProvider(resolved({ list: vi.fn().mockResolvedValue({ items: [anonymous] }), thread }))

    expect(upsertProviderThread).toHaveBeenCalled()
    expect(insertProviderMessage).toHaveBeenCalled()
  })

  it('wakes a sleeping conversation when the party writes on it again', async () => {
    reopenOnReply.mockResolvedValue('snoozed')
    const thread = vi.fn().mockResolvedValue({ summary: summary(), messages: [message()] })

    await syncProvider(resolved({ list: vi.fn().mockResolvedValue({ items: [summary()] }), thread }))

    expect(reopenOnReply).toHaveBeenCalledWith('t1')
    // Nobody did this, so nobody's name goes on it.
    expect(recordEvent).toHaveBeenCalledWith(
      't1', null, 'woken', { was: 'snoozed', providerModule: 'live-chat' },
    )
  })

  it('reopens one somebody had finished with, and records which it was', async () => {
    reopenOnReply.mockResolvedValue('done')
    const thread = vi.fn().mockResolvedValue({ summary: summary(), messages: [message()] })

    await syncProvider(resolved({ list: vi.fn().mockResolvedValue({ items: [summary()] }), thread }))

    expect(recordEvent).toHaveBeenCalledWith(
      't1', null, 'woken', { was: 'done', providerModule: 'live-chat' },
    )
  })

  it('leaves it where it is when the conversation had nothing new in it', async () => {
    // Everything on it is already held - the ordinary answer on a settled
    // channel, and not somebody writing.
    insertProviderMessage.mockResolvedValue(null)
    const thread = vi.fn().mockResolvedValue({ summary: summary(), messages: [message()] })

    await syncProvider(resolved({ list: vi.fn().mockResolvedValue({ items: [summary()] }), thread }))

    expect(reopenOnReply).not.toHaveBeenCalled()
  })

  it('writes no timeline entry when it was open all along', async () => {
    const thread = vi.fn().mockResolvedValue({ summary: summary(), messages: [message()] })

    await syncProvider(resolved({ list: vi.fn().mockResolvedValue({ items: [summary()] }), thread }))

    expect(reopenOnReply).toHaveBeenCalledWith('t1')
    expect(recordEvent).not.toHaveBeenCalled()
  })

  it('files a conversation and its messages', async () => {
    const thread = vi.fn().mockResolvedValue({ summary: summary(), messages: [message()] })
    const outcome = await syncProvider(
      resolved({ list: vi.fn().mockResolvedValue({ items: [summary()] }), thread }),
    )

    expect(outcome).toMatchObject({ ok: true, conversations: 1, messages: 1 })
    expect(upsertProviderThread).toHaveBeenCalledWith(
      expect.objectContaining({ providerModule: 'live-chat', externalId: 'c1', channel: 'chat' }),
    )
    expect(insertProviderMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMessageId: 'm1',
        direction: 'in',
        fromAddress: 'ada@example.com',
        fromPhone: null,
      }),
    )
  })

  it('puts the other party’s number on their message rather than their address', async () => {
    const party = summary({
      channel: 'phone',
      participant: { name: null, email: null, phone: '+441234567890' },
    })
    await syncProvider(
      resolved({
        channel: 'phone',
        list: vi.fn().mockResolvedValue({ items: [party] }),
        thread: vi.fn().mockResolvedValue({ summary: party, messages: [message()] }),
      }),
    )
    expect(insertProviderMessage).toHaveBeenCalledWith(
      expect.objectContaining({ fromAddress: null, fromPhone: '+441234567890' }),
    )
  })

  it('does not open a conversation that has not moved since we last read it', async () => {
    providerThreadState.mockResolvedValue({
      id: 't1',
      lastMessageAt: new Date('2026-08-28T10:00:00Z'),
      messageCount: 3,
      contentAt: new Date('2026-08-28T10:00:00Z'),
    })
    const thread = vi.fn()
    const outcome = await syncProvider(
      resolved({ list: vi.fn().mockResolvedValue({ items: [summary()] }), thread }),
    )
    expect(thread).not.toHaveBeenCalled()
    expect(outcome.messages).toBe(0)
  })

  it('does open one that has something new on it', async () => {
    providerThreadState.mockResolvedValue({
      id: 't1',
      lastMessageAt: new Date('2026-08-28T09:00:00Z'),
      messageCount: 3,
      contentAt: new Date('2026-08-28T09:00:00Z'),
    })
    const thread = vi.fn().mockResolvedValue({ summary: summary(), messages: [message()] })
    await syncProvider(resolved({ list: vi.fn().mockResolvedValue({ items: [summary()] }), thread }))
    expect(thread).toHaveBeenCalledWith('c1')
  })

  // A channel may revise what it has already said - the telephony one types a
  // voicemail up minutes after the message was left. The conversation is no
  // newer for it, so every test above passes and the words would never arrive.
  describe('a conversation that changed without gaining a message', () => {
    const lastMessageAt = new Date('2026-08-28T10:00:00Z')
    const typedUpAt = new Date('2026-08-28T10:04:00Z')

    it('is opened again when the channel says its content moved on', async () => {
      providerThreadState.mockResolvedValue({
        id: 't1',
        lastMessageAt,
        messageCount: 3,
        contentAt: lastMessageAt,
      })
      const revised = summary({ contentAt: typedUpAt })
      const thread = vi.fn().mockResolvedValue({ summary: revised, messages: [message()] })
      await syncProvider(resolved({ list: vi.fn().mockResolvedValue({ items: [revised] }), thread }))
      expect(thread).toHaveBeenCalledWith('c1')
      expect(markProviderContentRead).toHaveBeenCalledWith('live-chat', 'c1', typedUpAt)
    })

    it('settles once that revision has been read', async () => {
      providerThreadState.mockResolvedValue({
        id: 't1',
        lastMessageAt,
        messageCount: 3,
        contentAt: typedUpAt,
      })
      const thread = vi.fn()
      await syncProvider(
        resolved({
          list: vi.fn().mockResolvedValue({ items: [summary({ contentAt: typedUpAt })] }),
          thread,
        }),
      )
      expect(thread).not.toHaveBeenCalled()
    })

    // Every conversation collected before any of this was recorded has no
    // content watermark, and must be read once more rather than assumed current.
    it('reads a conversation that has never had a content watermark', async () => {
      providerThreadState.mockResolvedValue({
        id: 't1',
        lastMessageAt,
        messageCount: 3,
        contentAt: null,
      })
      const thread = vi.fn().mockResolvedValue({ summary: summary(), messages: [message()] })
      await syncProvider(resolved({ list: vi.fn().mockResolvedValue({ items: [summary()] }), thread }))
      expect(thread).toHaveBeenCalledWith('c1')
    })

    // A channel getting it backwards must not be able to convince us we are
    // caught up on something we are not.
    it('never believes a content time earlier than the newest message', async () => {
      providerThreadState.mockResolvedValue({
        id: 't1',
        lastMessageAt: new Date('2026-08-28T09:00:00Z'),
        messageCount: 3,
        contentAt: new Date('2026-08-28T09:00:00Z'),
      })
      const backwards = summary({ contentAt: new Date('2026-01-01T00:00:00Z') })
      const thread = vi.fn().mockResolvedValue({ summary: backwards, messages: [message()] })
      await syncProvider(
        resolved({ list: vi.fn().mockResolvedValue({ items: [backwards] }), thread }),
      )
      expect(markProviderContentRead).toHaveBeenCalledWith('live-chat', 'c1', lastMessageAt)
    })

    // The watermark is a promise that the words were fetched. A pass that gave
    // up before opening the conversation has made no such promise.
    it('does not record a revision it never opened', async () => {
      providerThreadState.mockResolvedValue({
        id: 't1',
        lastMessageAt,
        messageCount: 3,
        contentAt: lastMessageAt,
      })
      const revised = summary({ contentAt: typedUpAt })
      const thread = vi.fn().mockRejectedValue(new Error('the phone company said no'))
      await syncProvider(resolved({ list: vi.fn().mockResolvedValue({ items: [revised] }), thread }))
      expect(markProviderContentRead).not.toHaveBeenCalled()
    })
  })

  it('claims our own reply rather than filing a second copy of it', async () => {
    claimLocalOutbound.mockResolvedValue(true)
    const ours = message({ id: 'far-end-7', direction: 'out', text: 'on its way' })
    await syncProvider(
      resolved({
        list: vi.fn().mockResolvedValue({ items: [summary()] }),
        thread: vi.fn().mockResolvedValue({ summary: summary(), messages: [ours] }),
      }),
    )
    expect(claimLocalOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 't1', bodyText: 'on its way', providerMessageId: 'far-end-7' }),
    )
    expect(insertProviderMessage).not.toHaveBeenCalled()
  })

  it('reports a channel it could not read instead of throwing', async () => {
    const outcome = await syncProvider(
      resolved({ list: vi.fn().mockRejectedValue(new Error('Chatwoot 503')) }),
    )
    expect(outcome).toMatchObject({ ok: false, error: 'Chatwoot 503', conversations: 0 })
  })

  it('skips a conversation whose own module described it badly', async () => {
    const rubbish = [
      summary({ id: '' }),
      summary({ id: 'c2', lastMessageAt: new Date('nonsense') }),
    ]
    const outcome = await syncProvider(
      resolved({ list: vi.fn().mockResolvedValue({ items: rubbish }), thread: vi.fn() }),
    )
    expect(outcome.conversations).toBe(0)
    expect(upsertProviderThread).not.toHaveBeenCalled()
  })

  it('carries on when one conversation will not open', async () => {
    const two = [summary(), summary({ id: 'c2' })]
    const thread = vi
      .fn()
      .mockRejectedValueOnce(new Error('gone'))
      .mockResolvedValueOnce({ summary: summary({ id: 'c2' }), messages: [message({ id: 'm2' })] })
    const outcome = await syncProvider(
      resolved({ list: vi.fn().mockResolvedValue({ items: two }), thread }),
    )
    expect(outcome).toMatchObject({ ok: true, conversations: 2, messages: 1 })
  })
})

describe('syncAllProviders', () => {
  it('asks each channel about what has happened since the newest thing we hold', async () => {
    const list = vi.fn().mockResolvedValue({ items: [] })
    allConversationProviders.mockResolvedValue([resolved({ list, thread: vi.fn() })])
    providerWatermarks.mockResolvedValue({ 'live-chat': new Date('2026-08-28T10:00:00Z') })

    await syncAllProviders()

    const since = list.mock.calls[0]![0]!.since as Date
    // Half an hour of slack. It covers a conversation touched in the same
    // second as the last pass falling down the gap between two ticks, and a
    // channel revising something it already said - a voicemail typed up minutes
    // after it was left, which makes the conversation no newer at all.
    expect(since.toISOString()).toBe('2026-08-28T09:30:00.000Z')
  })

  it('lets one broken channel cost only itself', async () => {
    allConversationProviders.mockResolvedValue([
      resolved({ list: vi.fn().mockRejectedValue(new Error('no credentials')) }),
      {
        ...resolved({
          list: vi.fn().mockResolvedValue({ items: [summary()] }),
          thread: vi.fn().mockResolvedValue({ summary: summary(), messages: [message()] }),
        }),
        moduleName: 'contact-form',
        id: 'contact-form',
      },
    ])

    const outcomes = await syncAllProviders()
    expect(outcomes.map((o) => [o.moduleName, o.ok])).toEqual([
      ['live-chat', false],
      ['contact-form', true],
    ])
  })

  it('does nothing at all on a site with no other channels', async () => {
    expect(await syncAllProviders()).toEqual([])
    expect(providerWatermarks).not.toHaveBeenCalled()
  })
})
