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
// Asleep by default, so the ordinary case writes no timeline entry. The tests
// that care about waking say so themselves.
const wakeSnoozedThread = vi.hoisted(() => vi.fn(async () => false))
const recordEvent = vi.hoisted(() => vi.fn())

vi.mock('./db', () => ({
  providerThreadState,
  upsertProviderThread,
  insertProviderMessage,
  claimLocalOutbound,
  recountProviderThread,
  providerWatermarks,
  wakeSnoozedThread,
  recordEvent,
}))
vi.mock('./provider-registry', () => ({ allConversationProviders }))

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
  wakeSnoozedThread.mockReset().mockResolvedValue(false)
  recordEvent.mockReset().mockResolvedValue(undefined)
  allConversationProviders.mockReset().mockResolvedValue([])
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('syncProvider', () => {
  it('wakes a sleeping conversation when the party writes on it again', async () => {
    wakeSnoozedThread.mockResolvedValue(true)
    const thread = vi.fn().mockResolvedValue({ summary: summary(), messages: [message()] })

    await syncProvider(resolved({ list: vi.fn().mockResolvedValue({ items: [summary()] }), thread }))

    expect(wakeSnoozedThread).toHaveBeenCalledWith('t1')
    // Nobody did this, so nobody's name goes on it.
    expect(recordEvent).toHaveBeenCalledWith('t1', null, 'woken', { providerModule: 'live-chat' })
  })

  it('leaves the snooze alone when the conversation had nothing new in it', async () => {
    // Everything on it is already held - the ordinary answer on a settled
    // channel, and not somebody writing.
    insertProviderMessage.mockResolvedValue(null)
    const thread = vi.fn().mockResolvedValue({ summary: summary(), messages: [message()] })

    await syncProvider(resolved({ list: vi.fn().mockResolvedValue({ items: [summary()] }), thread }))

    expect(wakeSnoozedThread).not.toHaveBeenCalled()
  })

  it('writes no timeline entry when it was not asleep to begin with', async () => {
    const thread = vi.fn().mockResolvedValue({ summary: summary(), messages: [message()] })

    await syncProvider(resolved({ list: vi.fn().mockResolvedValue({ items: [summary()] }), thread }))

    expect(wakeSnoozedThread).toHaveBeenCalledWith('t1')
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
    })
    const thread = vi.fn().mockResolvedValue({ summary: summary(), messages: [message()] })
    await syncProvider(resolved({ list: vi.fn().mockResolvedValue({ items: [summary()] }), thread }))
    expect(thread).toHaveBeenCalledWith('c1')
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
    // A minute of slack, so a conversation touched in the same second as the
    // last pass does not fall down the gap between two ticks.
    expect(since.toISOString()).toBe('2026-08-28T09:59:00.000Z')
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
