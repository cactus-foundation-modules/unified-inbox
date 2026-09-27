import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DraftMode } from './types'

// Standing down what has just been overtaken, and saying so on the right
// conversations. The SQL that picks WHICH drafts is executed against a real
// database in timeline.live.test.ts; this is the part that decides what is
// asked of it and what the timeline is told afterwards.

const holdScheduledDrafts = vi.hoisted(() => vi.fn())
const recordEvent = vi.hoisted(() => vi.fn())
vi.mock('./db', () => ({ holdScheduledDrafts, recordEvent }))

const { standDownScheduled, heldDetail } = await import('./stand-down')

type DraftStub = { id: string; authorUserId: string; threadId: string | null; mode: DraftMode }

function draft(over: Partial<DraftStub> = {}): DraftStub {
  return { id: 'd1', authorUserId: 'chris', threadId: 't1', mode: 'reply', ...over }
}

beforeEach(() => {
  holdScheduledDrafts.mockReset().mockResolvedValue([])
  recordEvent.mockReset().mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('what is asked for', () => {
  it('matches by address and by conversation when they write', async () => {
    await standDownScheduled({ threadId: 't1', messageId: 'm1', direction: 'in', fromAddress: 'ada@example.com', senderUserId: null })
    expect(holdScheduledDrafts).toHaveBeenCalledWith({
      threadId: 't1', address: 'ada@example.com', sameThread: true, exceptAuthorUserId: null,
    })
  })

  it('matches by conversation only, sparing the sender, when a colleague answers', async () => {
    await standDownScheduled({ threadId: 't1', messageId: 'm1', direction: 'out', fromAddress: 'ignored@example.com', senderUserId: 'sam' })
    expect(holdScheduledDrafts).toHaveBeenCalledWith({
      threadId: 't1', address: null, sameThread: true, exceptAuthorUserId: 'sam',
    })
  })
})

describe('what the timeline is told', () => {
  it('says nothing when nothing was waiting', async () => {
    await standDownScheduled({ threadId: 't1', messageId: 'm1', direction: 'in', fromAddress: 'a@b.c', senderUserId: null })
    expect(recordEvent).not.toHaveBeenCalled()
  })

  it('puts the line before the message that did it, unattributed when they wrote', async () => {
    holdScheduledDrafts.mockResolvedValue([draft()])
    await standDownScheduled({ threadId: 't1', messageId: 'm1', direction: 'in', fromAddress: 'a@b.c', senderUserId: null })
    expect(recordEvent).toHaveBeenCalledTimes(1)
    expect(recordEvent).toHaveBeenCalledWith('t1', null, 'held', expect.objectContaining({
      cause: 'they', count: 1, messageId: 'm1', draftIds: ['d1'], authorUserIds: ['chris'], allReplies: true,
    }))
  })

  it('credits the colleague who answered first', async () => {
    holdScheduledDrafts.mockResolvedValue([draft()])
    await standDownScheduled({ threadId: 't1', messageId: 'm9', direction: 'out', fromAddress: null, senderUserId: 'sam' })
    expect(recordEvent).toHaveBeenCalledWith('t1', 'sam', 'held', expect.objectContaining({ cause: 'colleague', messageId: 'm9' }))
  })

  it('tells each other conversation about its own, and the arriving one about all of them', async () => {
    holdScheduledDrafts.mockResolvedValue([
      draft({ id: 'd1', threadId: 't1' }),
      draft({ id: 'd2', threadId: 't2', authorUserId: 'sam' }),
      draft({ id: 'd3', threadId: null, mode: 'new' }),
    ])
    await standDownScheduled({ threadId: 't1', messageId: 'm1', direction: 'in', fromAddress: 'a@b.c', senderUserId: null })
    expect(recordEvent).toHaveBeenCalledTimes(2)
    expect(recordEvent).toHaveBeenCalledWith('t1', null, 'held', expect.objectContaining({
      count: 3, draftIds: ['d1', 'd2', 'd3'], authorUserIds: ['chris', 'sam'], allReplies: false,
    }))
    expect(recordEvent).toHaveBeenCalledWith('t2', null, 'held', expect.objectContaining({
      cause: 'they', count: 1, draftIds: ['d2'], elsewhereThreadId: 't1',
    }))
  })

  it('still reports the hold when the line cannot be written', async () => {
    holdScheduledDrafts.mockResolvedValue([draft()])
    recordEvent.mockRejectedValue(new Error('gone'))
    const held = await standDownScheduled({ threadId: 't1', messageId: 'm1', direction: 'in', fromAddress: null, senderUserId: null })
    expect(held).toHaveLength(1)
  })
})

describe('heldDetail', () => {
  it('leaves the message off a line nothing caused on that conversation', () => {
    const detail = heldDetail([draft()], { cause: 'they', address: null, messageId: null, elsewhereThreadId: 't9' })
    expect(detail).not.toHaveProperty('messageId')
    expect(detail.elsewhereThreadId).toBe('t9')
  })
})
