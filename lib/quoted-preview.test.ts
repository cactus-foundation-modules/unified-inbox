import { describe, it, expect } from 'vitest'
import { pickQuotedPreview, type QuotedPreview } from './quoted-preview'

// Which message the writing box says it is quoting. It has to be the same one
// the send route actually quotes, or the panel is a confident lie about what
// the customer is going to receive.

function preview(id: string, sentAtMs: number): QuotedPreview {
  return {
    id,
    sentAtMs,
    attribution: `On whenever, somebody wrote (${id}):`,
    forwardHeader: [['From', 'Jane Smith jane@customer.com']],
    hasHtml: false,
    hasRemoteImages: false,
    ownSender: false,
    bodyText: `the body of ${id}`,
  }
}

const FIRST = preview('msg-1', Date.parse('2026-09-01T09:00:00Z'))
const MIDDLE = preview('msg-2', Date.parse('2026-09-02T09:00:00Z'))
const NEWEST = preview('msg-3', Date.parse('2026-09-03T09:00:00Z'))
const ALL = [FIRST, MIDDLE, NEWEST]

describe('pickQuotedPreview', () => {
  it('shows the message somebody pressed Reply on', () => {
    expect(pickQuotedPreview(ALL, 'msg-1')).toBe(FIRST)
  })

  it('shows the newest when the box was opened for the conversation itself', () => {
    expect(pickQuotedPreview(ALL, null)).toBe(NEWEST)
  })

  it('reads the dates rather than the order it was handed', () => {
    expect(pickQuotedPreview([NEWEST, FIRST, MIDDLE], null)).toBe(NEWEST)
  })

  it('falls back to the newest when the named message has gone, as the send does', () => {
    expect(pickQuotedPreview(ALL, 'msg-deleted')).toBe(NEWEST)
  })

  it('offers nothing at all on a conversation with nothing quotable on it', () => {
    // Every message is an internal note, so none of them reaches this list.
    expect(pickQuotedPreview([], null)).toBeNull()
    expect(pickQuotedPreview([], 'msg-1')).toBeNull()
  })
})
