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
const recordLink = vi.hoisted(() => vi.fn())
const threadHasLink = vi.hoisted(() => vi.fn())
const providerForKey = vi.hoisted(() => vi.fn())
const resolveProducts = vi.hoisted(() => vi.fn())

vi.mock('./db', () => ({
  getThreadDetail,
  insertProviderMessage,
  recountProviderThread,
  setThreadRead,
  recordLink,
  threadHasLink,
}))
vi.mock('./provider-registry', () => ({ providerForKey }))
vi.mock('./products', () => ({ resolveProducts }))

const { replyWords, sendProviderReply } = await import('./provider-send')

/** One product as the shop answers for it, in the shape the renderer wants. */
function chair(over: Record<string, unknown> = {}) {
  return {
    choice: {
      moduleName: 'shop',
      kind: 'product',
      id: 'p1',
      name: 'Ergo Task Chair',
      options: null,
      optionPairs: [],
      price: '£249.00',
      priceFrom: false,
      priceSuffix: '+ VAT',
      imageUrl: null,
      url: 'https://example.com/ergo',
      sku: null,
      variationCount: 0,
      ...over,
    },
    link: {
      moduleName: 'shop',
      recordType: 'product',
      recordId: (over.id as string) ?? 'p1',
      label: 'Ergo Task Chair',
    },
  }
}

/** The markup the writing box produces for one of them. */
function slot(id = 'p1'): string {
  return `<div class="uin-product-slot uin-richtext-block uin-ps--shop--product--${id}" `
    + 'contenteditable="false"><span class="uin-ps-words"><strong>Ergo Task Chair</strong>'
    + '</span><span class="uin-ps-price">£249.00 + VAT</span></div>'
}

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
  providerForKey.mockReset().mockResolvedValue(providerWith(send))
  recordLink.mockReset().mockResolvedValue(undefined)
  threadHasLink.mockReset().mockResolvedValue(false)
  resolveProducts.mockReset().mockResolvedValue([])
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('the words a channel is sent', () => {
  it('is what was written when nothing was quoted', async () => {
    expect(await replyWords('<p>On its way.</p>')).toBe('On its way.')
  })

  it('puts a product where its block was, as the same lines an email carries', async () => {
    resolveProducts.mockResolvedValue([chair()])
    const words = await replyWords(
      `<p>This one:</p>${slot()}<p>Let me know.</p>`,
      [{ moduleName: 'shop', kind: 'product', id: 'p1' }],
    )
    expect(words).toContain('Ergo Task Chair - £249.00 + VAT')
    expect(words).toContain('https://example.com/ergo')
    // The block's own preview markup does not travel; only what the renderer
    // writes does.
    expect(words).not.toContain('uin-ps-price')
    expect(words.indexOf('This one')).toBeLessThan(words.indexOf('Ergo Task Chair'))
    expect(words.indexOf('Ergo Task Chair')).toBeLessThan(words.indexOf('Let me know'))
  })

  it('runs a product with no block onto the end rather than losing it', async () => {
    resolveProducts.mockResolvedValue([chair()])
    const words = await replyWords(
      '<p>As discussed.</p>',
      [{ moduleName: 'shop', kind: 'product', id: 'p1' }],
    )
    expect(words.indexOf('As discussed')).toBeLessThan(words.indexOf('Ergo Task Chair'))
  })

  it('takes out a block whose product has been withdrawn since it was picked', async () => {
    resolveProducts.mockResolvedValue([])
    const words = await replyWords(
      `<p>Here you go.</p>${slot()}`,
      [{ moduleName: 'shop', kind: 'product', id: 'p1' }],
    )
    expect(words).toBe('Here you go.')
  })
})

describe('what the conversation is left carrying', () => {
  it('attaches what was quoted, so the rail says what this is about', async () => {
    resolveProducts.mockResolvedValue([chair()])
    await sendProviderReply({
      threadId: 't1',
      body: { text: 'Ergo Task Chair - £249.00 + VAT' },
      authorUserId: 'u1',
      authorName: 'Marcus',
      products: [{ moduleName: 'shop', kind: 'product', id: 'p1' }],
    })
    expect(recordLink).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 't1',
      moduleName: 'shop',
      recordType: 'product',
      recordId: 'p1',
    }))
  })

  it('does not attach the same chair twice over two messages', async () => {
    resolveProducts.mockResolvedValue([chair()])
    threadHasLink.mockResolvedValue(true)
    await sendProviderReply({
      threadId: 't1',
      body: { text: 'Same again' },
      authorUserId: 'u1',
      authorName: 'Marcus',
      products: [{ moduleName: 'shop', kind: 'product', id: 'p1' }],
    })
    expect(recordLink).not.toHaveBeenCalled()
  })
})

describe('the emphasis a channel carries', () => {
  /** A channel that says how it writes emphasis, the way WhatsApp does. */
  function marking(styles: Record<string, string>) {
    return providerWith(send, {
      capabilities: { reply: true, markRead: false, byIdentity: true, textStyles: styles },
    })
  }

  // THE DEFECT THIS PINS. A reply typed in bold used to arrive with the bold
  // gone: the markup was flattened away and the channel was sent the bare
  // words, even on a channel that has emphasis of its own.
  it('writes bold the way the channel says it writes bold', async () => {
    providerForKey.mockResolvedValue(marking({ bold: '*', italic: '_' }))
    await sendProviderReply({
      threadId: 't1',
      body: { html: '<p>That is <strong>in stock</strong> today.</p>' },
      authorUserId: 'u1',
      authorName: 'Marcus',
    })
    expect(send).toHaveBeenCalledWith('7', {
      text: 'That is *in stock* today.',
      authorUserId: 'u1',
    })
  })

  it('takes a second channel’s markers without being taught them', async () => {
    providerForKey.mockResolvedValue(marking({ bold: '**' }))
    await sendProviderReply({
      threadId: 't1',
      body: { html: '<p><b>Yes</b></p>' },
      authorUserId: 'u1',
      authorName: null,
    })
    expect(send).toHaveBeenCalledWith('7', { text: '**Yes**', authorUserId: 'u1' })
  })

  it('drops what the channel did not claim', async () => {
    providerForKey.mockResolvedValue(marking({ bold: '*' }))
    await sendProviderReply({
      threadId: 't1',
      body: { html: '<p><b>Yes</b> and <em>soon</em></p>' },
      authorUserId: 'u1',
      authorName: null,
    })
    expect(send).toHaveBeenCalledWith('7', { text: '*Yes* and soon', authorUserId: 'u1' })
  })

  it('flattens as it always did on a channel that claims none', async () => {
    await sendProviderReply({
      threadId: 't1',
      body: { html: '<p><b>Yes</b>, we do.</p>' },
      authorUserId: 'u1',
      authorName: null,
    })
    expect(send).toHaveBeenCalledWith('7', { text: 'Yes , we do.', authorUserId: 'u1' })
  })

  it('records against the conversation exactly what was sent', async () => {
    providerForKey.mockResolvedValue(marking({ bold: '*' }))
    await sendProviderReply({
      threadId: 't1',
      body: { html: '<p><b>Yes</b></p>' },
      authorUserId: 'u1',
      authorName: null,
    })
    expect(insertProviderMessage).toHaveBeenCalledWith(
      expect.objectContaining({ bodyText: '*Yes*' }),
    )
  })
})

describe('sendProviderReply', () => {
  it('hands the reply to the module that owns the conversation', async () => {
    const result = await sendProviderReply({
      threadId: 't1',
      body: { text: '  They are, yes.  ' },
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
      body: { text: 'hello' },
      authorUserId: 'u1',
      authorName: 'Marcus',
    })
    expect(result).toEqual({ ok: false, reason: 'Chatwoot 502' })
    expect(insertProviderMessage).not.toHaveBeenCalled()
  })

  it('marks the conversation read, because answering something says you read it', async () => {
    await sendProviderReply({ threadId: 't1', body: { text: 'hi' }, authorUserId: 'u1', authorName: null })
    expect(setThreadRead).toHaveBeenCalledWith('t1', false)
  })

  it('stamps its own row so the far end’s copy can be told apart later', async () => {
    await sendProviderReply({ threadId: 't1', body: { text: 'hi' }, authorUserId: 'u1', authorName: 'Marcus' })
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
      body: { text: 'hi' },
      authorUserId: 'u1',
      authorName: null,
    })
    expect(result).toEqual({
      ok: false,
      reason: 'You have not connected your live chat account yet, so this reply would go out as somebody else.',
    })
  })

  it('refuses plainly when the module behind that channel has gone (E20)', async () => {
    providerForKey.mockResolvedValue(null)
    const result = await sendProviderReply({
      threadId: 't1',
      body: { text: 'hi' },
      authorUserId: 'u1',
      authorName: null,
    })
    expect(result).toEqual({ ok: false, reason: 'That channel cannot be answered from here.' })
  })

  it('says so when the channel is one that cannot be answered at all', async () => {
    providerForKey.mockResolvedValue(
      providerWith(undefined, { capabilities: { reply: false, markRead: false, byIdentity: false } }),
    )
    const result = await sendProviderReply({
      threadId: 't1',
      body: { text: 'hi' },
      authorUserId: 'u1',
      authorName: null,
    })
    expect(result).toEqual({ ok: false, reason: 'Live chat conversations cannot be answered from here.' })
  })

  it('refuses an email conversation, which goes the other road entirely', async () => {
    getThreadDetail.mockResolvedValue({ ...thread, providerModule: null, externalId: null })
    const result = await sendProviderReply({
      threadId: 't1',
      body: { text: 'hi' },
      authorUserId: 'u1',
      authorName: null,
    })
    expect(result).toEqual({ ok: false, reason: 'That conversation did not come from another channel.' })
  })

  it('refuses an empty message before it troubles anybody', async () => {
    const result = await sendProviderReply({
      threadId: 't1',
      body: { text: '   ' },
      authorUserId: 'u1',
      authorName: null,
    })
    expect(result).toEqual({ ok: false, reason: 'There is nothing to send.' })
    expect(getThreadDetail).not.toHaveBeenCalled()
  })
})
