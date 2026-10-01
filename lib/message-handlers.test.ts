import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { HandlerNote, InboundMessageEvent } from './types'

// `unified-inbox.message-received`: gathering, the allowance, and the promise
// that one listener having a bad day costs the others nothing. The SQL behind
// it is exercised against a real database in message-handlers.live.test.ts.

const registry = vi.hoisted(() => ({ value: {} as Record<string, Record<string, unknown>> }))
const manifests = vi.hoisted(() => ({ read: vi.fn(async () => [] as { manifest: unknown }[]) }))
const store = vi.hoisted(() => ({
  loadOfferableMessage: vi.fn(),
  recordOffer: vi.fn(async (..._args: unknown[]) => {}),
  claimOffer: vi.fn(async (..._args: unknown[]) => true),
  releaseClaim: vi.fn(async () => {}),
  recordHandlerLink: vi.fn(async () => true),
  settleUnofferable: vi.fn(async () => 0),
  storedAttachmentBytes: vi.fn(async () => 0),
  unofferedMessageIds: vi.fn(async () => [] as string[]),
  inboxMessageIdsToReoffer: vi.fn(async () => [] as string[]),
  unstoredAttachments: vi.fn(async (_id: string) => [] as Array<{ id: string; contentType: string | null; sizeBytes: number | null }>),
}))
const settings = vi.hoisted(() => ({ getSettings: vi.fn(async () => ({ attachmentFetch: 'lazy' })) }))
const files = vi.hoisted(() => ({
  loadAttachmentBytes: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: false })),
  cacheAttachment: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ key: 'k', url: 'u', mediaId: 'media-1' })),
}))

vi.mock('@/lib/modules/extension-points.server', () => ({
  moduleServerExtensionPointComponents: registry.value,
}))
vi.mock('@/lib/modules/live-status', () => ({ getInstalledManifests: manifests.read }))
vi.mock('./message-handlers-db', () => store)
vi.mock('./db', () => settings)
vi.mock('./attachments', () => files)

const {
  CATCH_UP_BUDGET_MS,
  FETCH_BUDGET_MS,
  HANDLER_BUDGET_MS,
  MESSAGE_RECEIVED_POINT,
  catchUpMessageHandlers,
  gatherMessageHandlers,
  mergeNotes,
  offerMessage,
  reofferInbox,
  runHandlers,
  storableTypesFor,
  tidyNote,
} = await import('./message-handlers')

type Entry = Awaited<ReturnType<typeof gatherMessageHandlers>>[number]

const EVENT: InboundMessageEvent = {
  messageId: 'msg-1',
  threadId: 'thread-1',
  fromAddress: 'accounts@supplier.example',
  toAddresses: ['purchasing@shop.example'],
  ccAddresses: ['orders@shop.example'],
  subject: 'Proforma for your order',
  bodyText: 'Please find attached.',
  sentAt: '2026-09-30T09:00:00.000Z',
  attachments: [],
}

function entry(id: string, handle: Entry['handle'], moduleName = 'listener', attachmentTypes: string[] = []): Entry {
  return { moduleName, id, source: `${moduleName}:${id}`, handle, attachmentTypes }
}

function register(entries: Array<{ module: string; id: string; fn: unknown }>) {
  registry.value[MESSAGE_RECEIVED_POINT] = Object.fromEntries(entries.map((e) => [e.id, e.fn]))
  manifests.read.mockResolvedValue(
    [...new Set(entries.map((e) => e.module))].map((name) => ({
      manifest: {
        name,
        extensionPoints: entries
          .filter((e) => e.module === name)
          .map((e) => ({ point: MESSAGE_RECEIVED_POINT, id: e.id })),
      },
    })),
  )
}

beforeEach(() => {
  for (const key of Object.keys(registry.value)) delete registry.value[key]
  manifests.read.mockReset()
  manifests.read.mockResolvedValue([])
  for (const fn of Object.values(store)) fn.mockClear()
  store.claimOffer.mockResolvedValue(true)
  store.unstoredAttachments.mockResolvedValue([])
  files.loadAttachmentBytes.mockReset()
  files.loadAttachmentBytes.mockResolvedValue({ ok: false })
  files.cacheAttachment.mockReset()
  files.cacheAttachment.mockResolvedValue({ key: 'k', url: 'u', mediaId: 'media-1' })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('gatherMessageHandlers', () => {
  it('does no work at all when nothing is registered against the point', async () => {
    expect(await gatherMessageHandlers()).toEqual([])
    // Not even the manifest read: an empty registry settles it.
    expect(manifests.read).not.toHaveBeenCalled()
  })

  it('gathers in manifest order, attributed to the module that registered it', async () => {
    const a = async () => {}
    const b = async () => {}
    register([
      { module: 'purchase-orders', id: 'po-filing', fn: a },
      { module: 'bookkeeping', id: 'bills', fn: b },
    ])
    const gathered = await gatherMessageHandlers()
    expect(gathered.map((h) => h.source)).toEqual(['purchase-orders:po-filing', 'bookkeeping:bills'])
    expect(gathered[0]!.handle).toBe(a)
  })

  it('reads the object form, keeping only the kinds of file that may ever be stored', async () => {
    const handle = async () => {}
    register([{
      module: 'purchase-orders',
      id: 'po-filing',
      fn: { handle, attachmentTypes: ['Application/PDF', 'text/html', 'image/svg+xml', 'application/x-msdownload', 7] },
    }])
    const [gathered] = await gatherMessageHandlers()
    expect(gathered!.handle).toBe(handle)
    expect(gathered!.attachmentTypes).toEqual(['application/pdf'])
  })

  it('asks for no files for a handler registered as a bare function', async () => {
    register([{ module: 'm', id: 'plain', fn: async () => {} }])
    const handlers = await gatherMessageHandlers()
    expect(handlers[0]!.attachmentTypes).toEqual([])
    expect(storableTypesFor(handlers, 'lazy').size).toBe(0)
  })

  it('stores nothing eagerly when the site says attachments are never fetched', () => {
    const handlers = [entry('a', async () => {}, 'm', ['application/pdf'])]
    expect([...storableTypesFor(handlers, 'lazy')]).toEqual(['application/pdf'])
    expect(storableTypesFor(handlers, 'never').size).toBe(0)
  })

  it('skips a module that is not installed, and an entry that is not a function', async () => {
    register([{ module: 'purchase-orders', id: 'po-filing', fn: 'not a function' }])
    registry.value[MESSAGE_RECEIVED_POINT]!['stranger'] = async () => {}
    expect(await gatherMessageHandlers()).toEqual([])
  })
})

describe('runHandlers', () => {
  it('runs the next handler when one throws', async () => {
    const second = vi.fn(async () => ({ note: 'Seen it' }))
    const { runs, complete } = await runHandlers(EVENT, [
      entry('broken', async () => { throw new Error('the handler fell over') }),
      entry('fine', second),
    ])
    expect(complete).toBe(true)
    expect(runs.map((r) => r.status)).toEqual(['threw', 'ok'])
    expect(second).toHaveBeenCalledTimes(1)
    expect(runs[1]!.outcome).toEqual({ note: 'Seen it' })
  })

  it('gives a handler its allowance and no more, aborting its signal, then runs the next', async () => {
    let signal: AbortSignal | null = null
    const slow = entry('slow', (_event, ctx) => {
      signal = ctx.signal
      return new Promise(() => {})
    })
    const next = vi.fn(async () => undefined)
    const started = Date.now()
    const { runs } = await runHandlers(EVENT, [slow, entry('next', next)], { budgetMs: 30 })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(runs.map((r) => r.status)).toEqual(['timed-out', 'ok'])
    expect(signal!.aborted).toBe(true)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('does not let a handler that fails after its time is up surface as an unhandled rejection', async () => {
    const late = entry('late', () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 40)))
    const { runs } = await runHandlers(EVENT, [late], { budgetMs: 10 })
    expect(runs[0]!.status).toBe('timed-out')
    // vitest fails the file on an unhandled rejection; give it the chance to.
    await new Promise((resolve) => setTimeout(resolve, 60))
  })

  it('ignores an answer in the wrong shape', async () => {
    const { runs } = await runHandlers(EVENT, [entry('odd', async () => ({ links: 'PO-1' }) as never)])
    expect(runs[0]).toMatchObject({ status: 'invalid', outcome: null })
  })

  it('tells each handler who was copied in', async () => {
    const seen: string[][] = []
    await runHandlers(EVENT, [entry('reader', async (event) => { seen.push(event.ccAddresses) })])
    expect(seen).toEqual([['orders@shop.example']])
  })

  it('hands each handler its own copy, so one cannot change what the next is told', async () => {
    const seen: string[] = []
    await runHandlers(EVENT, [
      entry('meddler', async (event) => { event.subject = 'changed' }),
      entry('reader', async (event) => { seen.push(event.subject) }),
    ])
    expect(seen).toEqual(['Proforma for your order'])
  })

  it('stops before a handler the deadline would not leave its full allowance', async () => {
    const never = vi.fn(async () => undefined)
    const { runs, complete } = await runHandlers(EVENT, [entry('x', never)], {
      budgetMs: 5_000,
      deadline: Date.now() + 1_000,
    })
    expect(complete).toBe(false)
    expect(runs).toEqual([])
    expect(never).not.toHaveBeenCalled()
  })
})

describe('notes', () => {
  it('folds a note to one line and cuts a long one', () => {
    expect(tidyNote('  Filed on\nPO-01234  ')).toBe('Filed on PO-01234')
    expect(tidyNote('   ')).toBeNull()
    expect(tidyNote(undefined)).toBeNull()
    expect(tidyNote('x'.repeat(500))!.length).toBe(200)
  })

  it('replaces a handler’s own line, keeps it when it says nothing, and leaves others alone', () => {
    const existing: HandlerNote[] = [
      { source: 'a:1', moduleName: 'a', note: 'old from a', at: '2026-09-01T00:00:00.000Z' },
      { source: 'b:1', moduleName: 'b', note: 'from b', at: '2026-09-01T00:00:00.000Z' },
    ]
    const merged = mergeNotes(existing, [
      { entry: entry('1', async () => {}, 'a'), status: 'ok', outcome: { note: 'new from a' } },
      { entry: entry('1', async () => {}, 'b'), status: 'ok', outcome: null },
    ], new Date('2026-09-30T00:00:00.000Z'))
    expect(merged.map((n) => `${n.source}=${n.note}`)).toEqual(['b:1=from b', 'a:1=new from a'])
  })
})

describe('offerMessage', () => {
  it('touches no row on a site where nothing listens', async () => {
    expect(await offerMessage('msg-1')).toBe('no-handlers')
    expect(store.loadOfferableMessage).not.toHaveBeenCalled()
    expect(store.recordOffer).not.toHaveBeenCalled()
  })

  it('keeps the links and the note, and stamps the message once everybody had a turn', async () => {
    store.loadOfferableMessage.mockResolvedValue({ event: EVENT, handledAt: null, notes: [] })
    const handlers = [
      entry('broken', async () => { throw new Error('no') }),
      entry('filing', async () => ({
        links: [{ moduleName: 'purchase-orders', recordType: 'purchase-order', recordId: 'po-9', label: 'PO-01234' }],
        note: 'Filed on PO-01234 as the proforma',
      }), 'purchase-orders'),
    ]
    expect(await offerMessage('msg-1', { handlers })).toBe('offered')
    expect(store.recordHandlerLink).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1', recordId: 'po-9', label: 'PO-01234',
    }))
    expect(store.recordOffer).toHaveBeenCalledWith('msg-1', {
      notes: [expect.objectContaining({ source: 'purchase-orders:filing', note: 'Filed on PO-01234 as the proforma' })],
      stamp: true,
    })
  })

  it('leaves a message offered before alone unless told to offer it again', async () => {
    store.loadOfferableMessage.mockResolvedValue({ event: EVENT, handledAt: new Date(), notes: [] })
    const handle = vi.fn(async () => undefined)
    expect(await offerMessage('msg-1', { handlers: [entry('x', handle)] })).toBe('already-offered')
    expect(handle).not.toHaveBeenCalled()
    expect(await offerMessage('msg-1', { handlers: [entry('x', handle)], force: true })).toBe('offered')
    expect(handle).toHaveBeenCalledTimes(1)
  })

  it('leaves a message somebody else is offering alone', async () => {
    store.loadOfferableMessage.mockResolvedValue({ event: EVENT, handledAt: null, notes: [] })
    store.claimOffer.mockResolvedValue(false)
    const handle = vi.fn(async () => undefined)
    expect(await offerMessage('msg-1', { handlers: [entry('x', handle)] })).toBe('in-progress')
    expect(handle).not.toHaveBeenCalled()
    expect(store.recordOffer).not.toHaveBeenCalled()
  })

  it('lets go of the claim when the offer itself fails', async () => {
    store.loadOfferableMessage.mockResolvedValue({ event: EVENT, handledAt: null, notes: [] })
    store.recordOffer.mockRejectedValueOnce(new Error('the database went away'))
    expect(await offerMessage('msg-1', { handlers: [entry('x', async () => undefined)] })).toBe('failed')
    expect(store.releaseClaim).toHaveBeenCalledWith('msg-1')
  })

  it('offers the message without a file the mail server is too slow to hand over', async () => {
    store.loadOfferableMessage.mockResolvedValue({ event: EVENT, handledAt: null, notes: [] })
    store.unstoredAttachments.mockResolvedValue([
      { id: 'att-1', contentType: 'application/pdf', sizeBytes: 100 },
      { id: 'att-2', contentType: 'application/pdf', sizeBytes: 100 },
    ])
    files.loadAttachmentBytes.mockImplementation(() => new Promise(() => {}))
    const handle = vi.fn(async () => undefined)
    const result = await offerMessage('msg-1', {
      handlers: [entry('x', handle, 'm', ['application/pdf'])],
      fetchTypes: new Set(['application/pdf']),
      fetchBudgetMs: 20,
    })
    expect(result).toBe('offered')
    expect(handle).toHaveBeenCalledTimes(1)
    expect(files.cacheAttachment).not.toHaveBeenCalled()
    // The first fetch was given up on and is still out there talking to the
    // mail server, so no second one is started alongside it.
    expect(files.loadAttachmentBytes).toHaveBeenCalledTimes(1)
  })

  it('fetches nothing for a message with no sender to file it under', async () => {
    store.loadOfferableMessage.mockResolvedValue({ event: { ...EVENT, fromAddress: '' }, handledAt: null, notes: [] })
    store.unstoredAttachments.mockResolvedValue([{ id: 'att-1', contentType: 'application/pdf', sizeBytes: 100 }])
    const handle = vi.fn(async () => undefined)
    expect(await offerMessage('msg-1', {
      handlers: [entry('x', handle, 'm', ['application/pdf'])],
      fetchTypes: new Set(['application/pdf']),
    })).toBe('offered')
    expect(files.loadAttachmentBytes).not.toHaveBeenCalled()
    expect(handle).toHaveBeenCalledTimes(1)
  })

  it('stores a fetched file only when its bytes prove it is a kind asked for', async () => {
    store.loadOfferableMessage.mockResolvedValue({ event: EVENT, handledAt: null, notes: [] })
    store.unstoredAttachments.mockResolvedValue([
      { id: 'real', contentType: 'application/pdf', sizeBytes: 9 },
      { id: 'fake', contentType: 'application/pdf', sizeBytes: 20 },
      { id: 'page', contentType: 'text/html', sizeBytes: 20 },
    ])
    files.loadAttachmentBytes.mockImplementation(async (id: unknown) => ({
      ok: true,
      filename: `${String(id)}.pdf`,
      contentType: 'application/pdf',
      buffer: Buffer.from(id === 'real' ? '%PDF-1.7\n' : '<html><script>'),
    }))
    await offerMessage('msg-1', {
      handlers: [entry('x', async () => undefined, 'm', ['application/pdf'])],
      fetchTypes: new Set(['application/pdf']),
    })
    // The page labelled text/html is never even fetched.
    expect(files.loadAttachmentBytes.mock.calls.map((c) => c[0])).toEqual(['real', 'fake'])
    expect(files.cacheAttachment).toHaveBeenCalledTimes(1)
    expect(files.cacheAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'real' }), expect.anything(), 'application/pdf',
    )
  })

  it('offers nothing it is not allowed to offer', async () => {
    store.loadOfferableMessage.mockResolvedValue(null)
    const handle = vi.fn(async () => undefined)
    expect(await offerMessage('msg-1', { handlers: [entry('x', handle)] })).toBe('not-offerable')
    expect(handle).not.toHaveBeenCalled()
  })

  it('does not stamp a message the deadline cut short', async () => {
    store.loadOfferableMessage.mockResolvedValue({ event: EVENT, handledAt: null, notes: [] })
    expect(await offerMessage('msg-1', {
      handlers: [entry('x', async () => undefined)],
      deadline: Date.now() + 1_000,
    })).toBe('deferred')
    expect(store.recordOffer).not.toHaveBeenCalled()
  })
})

describe('the catch-up and the button', () => {
  it('does nothing at all when the tick leaves it less than a handler\u2019s turn', async () => {
    register([{ module: 'purchase-orders', id: 'filing', fn: async () => undefined }])
    expect(await catchUpMessageHandlers({ deadline: Date.now() + 3_000 })).toEqual({ offered: 0, settled: 0 })
    expect(store.settleUnofferable).not.toHaveBeenCalled()
    expect(store.unofferedMessageIds).not.toHaveBeenCalled()
  })

  it('gives the catch-up room for a file fetch and a handler\u2019s turn, with some to spare', () => {
    expect(CATCH_UP_BUDGET_MS).toBeGreaterThanOrEqual(HANDLER_BUDGET_MS + FETCH_BUDGET_MS + 2_000)
  })

  it('the catch-up, on its real slice and the real fetch allowance, fetches a file that was asked for', async () => {
    register([{
      module: 'purchase-orders',
      id: 'po-filing',
      fn: { attachmentTypes: ['application/pdf'], handle: async () => undefined },
    }])
    store.unofferedMessageIds.mockResolvedValue(['msg-1'])
    store.loadOfferableMessage.mockResolvedValue({ event: EVENT, handledAt: null, notes: [] })
    store.unstoredAttachments.mockResolvedValue([{ id: 'att-1', contentType: 'application/pdf', sizeBytes: 12 }])
    files.loadAttachmentBytes.mockResolvedValue({
      ok: true, filename: 'proforma.pdf', contentType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n%%EOF'),
    })
    const result = await catchUpMessageHandlers({ deadline: Date.now() + CATCH_UP_BUDGET_MS })
    expect(result.offered).toBe(1)
    expect(files.loadAttachmentBytes).toHaveBeenCalledWith('att-1', { cache: false })
    expect(files.cacheAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'att-1' }), expect.anything(), 'application/pdf',
    )
  })

  it('the catch-up reads nothing on a site where nothing listens', async () => {
    expect(await catchUpMessageHandlers({ deadline: Date.now() + 60_000 })).toEqual({ offered: 0, settled: 0 })
    expect(store.unofferedMessageIds).not.toHaveBeenCalled()
    expect(store.settleUnofferable).not.toHaveBeenCalled()
  })

  it('the catch-up offers what was never offered', async () => {
    register([{ module: 'purchase-orders', id: 'po-filing', fn: async () => undefined }])
    store.unofferedMessageIds.mockResolvedValue(['msg-1', 'msg-2'])
    store.loadOfferableMessage.mockResolvedValue({ event: EVENT, handledAt: null, notes: [] })
    expect(await catchUpMessageHandlers({ deadline: Date.now() + 60_000 })).toEqual({ offered: 2, settled: 0 })
    expect(store.settleUnofferable).toHaveBeenCalledTimes(1)
  })

  it('the button walks the pages and says when it is done', async () => {
    register([{ module: 'purchase-orders', id: 'po-filing', fn: async () => undefined }])
    store.inboxMessageIdsToReoffer
      .mockResolvedValueOnce(['msg-1', 'msg-2'])
      .mockResolvedValueOnce([])
    store.loadOfferableMessage.mockResolvedValue({ event: EVENT, handledAt: new Date(), notes: [] })
    const result = await reofferInbox('inbox-1', { after: null, deadline: Date.now() + 60_000 })
    // Offered regardless of the stamp: that is what the button is for.
    expect(result).toEqual({ handlers: 1, offered: 2, next: null, done: true })
    expect(store.inboxMessageIdsToReoffer).toHaveBeenLastCalledWith('inbox-1', 'msg-2', 25)
  })

  it('the button hands back a cursor when its slice runs out', async () => {
    register([{ module: 'purchase-orders', id: 'po-filing', fn: async () => undefined }])
    store.inboxMessageIdsToReoffer.mockResolvedValueOnce(['msg-1'])
    const result = await reofferInbox('inbox-1', { after: 'msg-0', deadline: Date.now() + 1_000 })
    expect(result).toEqual({ handlers: 1, offered: 0, next: 'msg-0', done: false })
  })
})

describe('running out of time is not the same as a slow server', () => {
  const PDF = Buffer.from('%PDF-1.7\n%%EOF')
  const WANT = new Set(['application/pdf'])
  const pdfHandler = (handle: Entry['handle']) => entry('filing', handle, 'purchase-orders', ['application/pdf'])

  // Only the clock is faked, never the timers: each fetch below "takes" two
  // seconds by moving Date forward, so what the offer thinks is left is exact.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'))
    store.loadOfferableMessage.mockResolvedValue({ event: EVENT, handledAt: null, notes: [] })
  })
  afterEach(() => { vi.useRealTimers() })

  function fetchesTaking(ms: number, ok = true) {
    files.loadAttachmentBytes.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + ms)
      return ok
        ? { ok: true, filename: 'doc.pdf', contentType: 'application/pdf', buffer: PDF }
        : { ok: false, reason: 'the server said no', status: 502 }
    })
  }

  it('hands back a message whose wanted file there is no time to fetch, untouched', async () => {
    store.unstoredAttachments.mockResolvedValue([{ id: 'att-1', contentType: 'application/pdf', sizeBytes: 12 }])
    const handle = vi.fn(async () => undefined)
    // Room for a handler (5s) but not a fetch as well (13s).
    const result = await offerMessage('msg-1', {
      handlers: [pdfHandler(handle)], fetchTypes: WANT, deadline: Date.now() + 10_000,
    })
    expect(result).toBe('deferred')
    expect(handle).not.toHaveBeenCalled()
    // Not claimed, so its attempt count is untouched, and not stamped.
    expect(store.claimOffer).not.toHaveBeenCalled()
    expect(store.recordOffer).not.toHaveBeenCalled()
    expect(files.loadAttachmentBytes).not.toHaveBeenCalled()
  })

  it('the catch-up on ten seconds leaves that message for next hour, and offers one with nothing to fetch', async () => {
    register([{ module: 'purchase-orders', id: 'filing', fn: { attachmentTypes: ['application/pdf'], handle: async () => undefined } }])
    store.unofferedMessageIds.mockResolvedValue(['needs-file', 'plain'])
    store.unstoredAttachments.mockImplementation(async (id: string) =>
      id === 'needs-file' ? [{ id: 'att-1', contentType: 'application/pdf', sizeBytes: 12 }] : [])
    store.loadOfferableMessage.mockImplementation(async (id: string) =>
      ({ event: { ...EVENT, messageId: id }, handledAt: null, notes: [] }))

    const result = await catchUpMessageHandlers({ deadline: Date.now() + 10_000 })

    // The one needing a file is handed back - even at the head of the run,
    // because it never had room to try - and the one needing none is offered.
    expect(result.offered).toBe(1)
    expect(store.claimOffer.mock.calls.map((c) => c[0])).toEqual(['plain'])
    expect(store.recordOffer.mock.calls.map((c) => c[0])).toEqual(['plain'])
    expect(files.loadAttachmentBytes).not.toHaveBeenCalled()
  })

  it('hands back a message the clock runs out on between two files, keeping the one it stored', async () => {
    store.unstoredAttachments.mockResolvedValue([
      { id: 'att-1', contentType: 'application/pdf', sizeBytes: 12 },
      { id: 'att-2', contentType: 'application/pdf', sizeBytes: 12 },
    ])
    fetchesTaking(2_000)
    const handle = vi.fn(async () => undefined)
    // 14s: room for the first fetch and a handler (13s), then 12s left.
    const result = await offerMessage('msg-1', {
      handlers: [pdfHandler(handle)], fetchTypes: WANT, deadline: Date.now() + 14_000,
    })
    expect(result).toBe('deferred')
    expect(handle).not.toHaveBeenCalled()
    expect(files.cacheAttachment).toHaveBeenCalledTimes(1)
    // The claim is let go, its attempt refunded, and nothing is stamped.
    expect(store.releaseClaim).toHaveBeenCalledWith('msg-1', { refund: true })
    expect(store.recordOffer).not.toHaveBeenCalled()
  })

  it('at the head of a run, hands back only when that makes progress', async () => {
    store.unstoredAttachments.mockResolvedValue([
      { id: 'att-1', contentType: 'application/pdf', sizeBytes: 12 },
      { id: 'att-2', contentType: 'application/pdf', sizeBytes: 12 },
    ])
    const handle = vi.fn(async () => undefined)

    // Stored one: handed back, the next run has one fewer to fetch.
    fetchesTaking(2_000)
    expect(await offerMessage('msg-1', {
      handlers: [pdfHandler(handle)], fetchTypes: WANT, deadline: Date.now() + 14_000, headOfRun: true,
    })).toBe('deferred')
    expect(handle).not.toHaveBeenCalled()

    // Tried and got nothing - the files keep failing - so handing it back would
    // repeat for ever. Offered with what there is.
    fetchesTaking(2_000, false)
    expect(await offerMessage('msg-1', {
      handlers: [pdfHandler(handle)], fetchTypes: WANT, deadline: Date.now() + 14_000, headOfRun: true,
    })).toBe('offered')
    expect(handle).toHaveBeenCalledTimes(1)
  })

  it('does not count bytes that never became a library item as progress', async () => {
    store.unstoredAttachments.mockResolvedValue([
      { id: 'att-1', contentType: 'application/pdf', sizeBytes: 12 },
      { id: 'att-2', contentType: 'application/pdf', sizeBytes: 12 },
    ])
    // Stored, but no folder resolved: no library row, still unstored as far as
    // the next run can tell. Handing the head back on that would fetch and
    // upload the same file every hour until it aged out.
    files.cacheAttachment.mockResolvedValue({ key: 'k', url: 'u', mediaId: null })
    fetchesTaking(2_000)
    const handle = vi.fn(async () => undefined)
    expect(await offerMessage('msg-1', {
      handlers: [pdfHandler(handle)], fetchTypes: WANT, deadline: Date.now() + 14_000, headOfRun: true,
    })).toBe('offered')
    expect(handle).toHaveBeenCalledTimes(1)
  })

  it('the first request of the walk, handing its first message back, does not read as finished', async () => {
    register([{ module: 'purchase-orders', id: 'filing', fn: { attachmentTypes: ['application/pdf'], handle: async () => undefined } }])
    store.inboxMessageIdsToReoffer.mockResolvedValueOnce(['msg-1', 'msg-2'])
    store.unstoredAttachments.mockResolvedValue([
      { id: 'att-1', contentType: 'application/pdf', sizeBytes: 12 },
      { id: 'att-2', contentType: 'application/pdf', sizeBytes: 12 },
    ])
    fetchesTaking(2_000)
    const result = await reofferInbox('inbox-1', { after: null, deadline: Date.now() + 14_000 })
    // Nothing finished, so there is no cursor to hand back - and it is not done.
    expect(result).toEqual({ handlers: 1, offered: 0, next: null, done: false })
  })

  it('the button starts its next request from a message it handed back', async () => {
    register([{ module: 'purchase-orders', id: 'filing', fn: { attachmentTypes: ['application/pdf'], handle: async () => undefined } }])
    store.inboxMessageIdsToReoffer.mockResolvedValueOnce(['msg-1', 'msg-2'])
    store.unstoredAttachments.mockResolvedValue([
      { id: 'att-1', contentType: 'application/pdf', sizeBytes: 12 },
      { id: 'att-2', contentType: 'application/pdf', sizeBytes: 12 },
    ])
    fetchesTaking(2_000)
    const result = await reofferInbox('inbox-1', { after: 'msg-0', deadline: Date.now() + 14_000 })
    expect(result).toEqual({ handlers: 1, offered: 0, next: 'msg-0', done: false })
  })
})
