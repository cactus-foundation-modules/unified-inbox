import { describe, expect, it, vi, beforeEach } from 'vitest'

// Answering a conversation another module owns.
//
// Nothing here sends anything itself: it asks the owning module, so the
// customer gets a real reply on the channel they used rather than an email
// pretending to be one. What it does own is the order of events - ask first,
// record only once it has gone - and turning a refusal into a sentence somebody
// can act on rather than a stack trace.

const getThreadDetail = vi.hoisted(() => vi.fn())
const insertProviderMessage = vi.hoisted(() => vi.fn())
const recountProviderThread = vi.hoisted(() => vi.fn())
const setThreadRead = vi.hoisted(() => vi.fn())
const providerForModule = vi.hoisted(() => vi.fn())

vi.mock('./db', () => ({
  getThreadDetail,
  insertProviderMessage,
  recountProviderThread,
  setThreadRead,
}))
vi.mock('./provider-registry', () => ({ providerForModule }))

const { sendProviderReply } = await import('./provider-send')

const thread = {
  id: 't1',
  inboxId: null,
  channel: 'chat',
  providerModule: 'live-chat',
  externalId: '7',
  subject: 'Chat with Ada',
  subjectNormalised: 'chat with ada',
  status: 'open',
  snoozeUntil: null,
  assigneeUserId: null,
  personId: null,
  unread: true,
  messageCount: 3,
  lastMessageAt: new Date('2026-08-27T15:00:00Z'),
  createdAt: new Date('2026-08-27T14:00:00Z'),
}

function providerWith(send: unknown, over: Record<string, unknown> = {}) {
  return {
    moduleName: 'live-chat',
    id: 'live-chat',
    provider: {
      label: 'Live chat',
      channel: 'chat',
      capabilities: { reply: true, markRead: true, byIdentity: true },
      list: vi.fn(),
      thread: vi.fn(),
      send,
      ...over,
    },
  }
}

const send = vi.fn()

beforeEach(() => {
  getThreadDetail.mockReset().mockResolvedValue(thread)
  insertProviderMessage.mockReset().mockResolvedValue('m1')
  recountProviderThread.mockReset().mockResolvedValue(undefined)
  setThreadRead.mockReset().mockResolvedValue(undefined)
  send.mockReset().mockResolvedValue(undefined)
  providerForModule.mockReset().mockResolvedValue(providerWith(send))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('sendProviderReply', () => {
  it('hands the reply to the module that owns the conversation', async () => {
    const result = await sendProviderReply({
      threadId: 't1',
      text: '  They are, yes.  ',
      authorUserId: 'u1',
      authorName: 'Marcus',
    })

    expect(result).toEqual({ ok: true, messageId: 'm1' })
    expect(send).toHaveBeenCalledWith('7', { text: 'They are, yes.', authorUserId: 'u1' })
  })

  it('records it only once it has genuinely gone', async () => {
    send.mockRejectedValue(new Error('Chatwoot 502'))
    const result = await sendProviderReply({
      threadId: 't1',
      text: 'hello',
      authorUserId: 'u1',
      authorName: 'Marcus',
    })
    expect(result).toEqual({ ok: false, reason: 'Chatwoot 502' })
    expect(insertProviderMessage).not.toHaveBeenCalled()
  })

  it('marks the conversation read, because answering something says you read it', async () => {
    await sendProviderReply({ threadId: 't1', text: 'hi', authorUserId: 'u1', authorName: null })
    expect(setThreadRead).toHaveBeenCalledWith('t1', false)
  })

  it('stamps its own row so the far end’s copy can be told apart later', async () => {
    await sendProviderReply({ threadId: 't1', text: 'hi', authorUserId: 'u1', authorName: 'Marcus' })
    const written = insertProviderMessage.mock.calls[0]![0]
    expect(written.providerMessageId.startsWith('uin-out:')).toBe(true)
    expect(written).toMatchObject({ direction: 'out', channel: 'chat', fromName: 'Marcus' })
  })

  it('passes the owning module’s own words on, because it knows why it refused', async () => {
    send.mockRejectedValue(
      new Error('You have not connected your live chat account yet, so this reply would go out as somebody else.'),
    )
    const result = await sendProviderReply({
      threadId: 't1',
      text: 'hi',
      authorUserId: 'u1',
      authorName: null,
    })
    expect(result).toEqual({
      ok: false,
      reason: 'You have not connected your live chat account yet, so this reply would go out as somebody else.',
    })
  })

  it('says so plainly when that channel is no longer installed (E20)', async () => {
    providerForModule.mockResolvedValue(null)
    const result = await sendProviderReply({
      threadId: 't1',
      text: 'hi',
      authorUserId: 'u1',
      authorName: null,
    })
    expect(result).toMatchObject({ ok: false })
    expect((result as { reason: string }).reason).toContain('no longer installed')
  })

  it('says so when the channel is one that cannot be answered at all', async () => {
    providerForModule.mockResolvedValue(
      providerWith(undefined, { capabilities: { reply: false, markRead: false, byIdentity: false } }),
    )
    const result = await sendProviderReply({
      threadId: 't1',
      text: 'hi',
      authorUserId: 'u1',
      authorName: null,
    })
    expect(result).toEqual({ ok: false, reason: 'Live chat conversations cannot be answered from here.' })
  })

  it('refuses an email conversation, which goes the other road entirely', async () => {
    getThreadDetail.mockResolvedValue({ ...thread, providerModule: null, externalId: null })
    const result = await sendProviderReply({
      threadId: 't1',
      text: 'hi',
      authorUserId: 'u1',
      authorName: null,
    })
    expect(result).toEqual({ ok: false, reason: 'That conversation did not come from another channel.' })
  })

  it('refuses an empty message before it troubles anybody', async () => {
    const result = await sendProviderReply({
      threadId: 't1',
      text: '   ',
      authorUserId: 'u1',
      authorName: null,
    })
    expect(result).toEqual({ ok: false, reason: 'There is nothing to send.' })
    expect(getThreadDetail).not.toHaveBeenCalled()
  })
})
