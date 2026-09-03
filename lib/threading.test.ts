import { describe, it, expect } from 'vitest'
import {
  buildSnippet,
  chooseThread,
  classifyAutomated,
  cleanMessageId,
  contentIdentity,
  internalPairKey,
  isSyntheticIdentity,
  normaliseSubject,
  parseReferences,
  type ThreadRef,
} from './threading'

// These cover the two things in the ingest stage that lose or corrupt real
// customer mail rather than merely looking untidy: what counts as the same
// message, and what counts as the same conversation.

describe('cleanMessageId', () => {
  it('strips the angle brackets a header carries', () => {
    expect(cleanMessageId('<abc123@mail.example>')).toBe('abc123@mail.example')
    expect(cleanMessageId('  <abc123@mail.example>  ')).toBe('abc123@mail.example')
  })

  it('leaves an id that arrives bare alone', () => {
    expect(cleanMessageId('abc123@mail.example')).toBe('abc123@mail.example')
  })

  it('treats nothing as nothing', () => {
    expect(cleanMessageId(null)).toBeNull()
    expect(cleanMessageId('   ')).toBeNull()
    expect(cleanMessageId('<>')).toBeNull()
  })
})

describe('parseReferences', () => {
  it('reads every id in the header, oldest first', () => {
    expect(parseReferences('<a@x> <b@x>\r\n <c@x>')).toEqual(['a@x', 'b@x', 'c@x'])
  })

  it('copes with a client that omits the brackets entirely', () => {
    expect(parseReferences('a@x b@x')).toEqual(['a@x', 'b@x'])
  })

  it('drops duplicates rather than threading against the same id twice', () => {
    expect(parseReferences('<a@x> <a@x> <b@x>')).toEqual(['a@x', 'b@x'])
  })
})

describe('normaliseSubject', () => {
  it('strips reply and forward prefixes, however many have piled up', () => {
    expect(normaliseSubject('Re: Fwd: RE: Order 1234')).toBe('order 1234')
  })

  it('handles the prefixes other mail clients use', () => {
    expect(normaliseSubject('AW: Rechnung')).toBe('rechnung')
    expect(normaliseSubject('RE[2]: Quote')).toBe('quote')
  })

  it('drops a mailing list tag', () => {
    expect(normaliseSubject('[cactus-users] Re: Hello')).toBe('hello')
  })

  it('collapses whitespace and case so two spellings of one subject match', () => {
    expect(normaliseSubject('  Order   1234 ')).toBe(normaliseSubject('order 1234'))
  })

  it('is empty for a message with no subject at all', () => {
    expect(normaliseSubject(null)).toBe('')
  })
})

describe('contentIdentity', () => {
  const message = {
    sentAt: new Date('2026-08-01T09:00:00.000Z'),
    fromAddress: 'customer@example.com',
    subject: 'A chair, please',
    sizeBytes: 4096,
  }

  it('gives a message with no Message-ID a stable identity of its own', () => {
    expect(contentIdentity(message)).toBe(contentIdentity({ ...message }))
  })

  it('is the same identity wherever the message is found, because nothing about the location is in it', () => {
    // The whole point: the copy in INBOX and the copy in Archive hash the same.
    const inInbox = contentIdentity(message)
    const inArchive = contentIdentity({ ...message })
    expect(inArchive).toBe(inInbox)
  })

  it('separates two genuinely different messages', () => {
    expect(contentIdentity({ ...message, subject: 'A desk, please' })).not.toBe(contentIdentity(message))
  })

  it('is recognisable as minted rather than read off a header', () => {
    expect(isSyntheticIdentity(contentIdentity(message))).toBe(true)
    expect(isSyntheticIdentity('real@mail.example')).toBe(false)
  })
})

describe('classifyAutomated', () => {
  it('spots an out-of-office', () => {
    expect(classifyAutomated({ autoSubmitted: 'auto-replied' })).toBe('auto-reply')
  })

  it('ignores the header when it says this is a human', () => {
    expect(classifyAutomated({ autoSubmitted: 'no' })).toBeNull()
  })

  it('spots a bounce by its report content type', () => {
    expect(classifyAutomated({ contentType: 'multipart/report; report-type=delivery-status' })).toBe('bounce')
  })

  it('spots a bounce from the daemon that sent it', () => {
    expect(classifyAutomated({ fromAddress: 'MAILER-DAEMON@mail.example' })).toBe('bounce')
  })

  it('spots a bounce with a null return path and a delivery failure subject', () => {
    expect(classifyAutomated({ returnPath: '<>', subject: 'Undelivered Mail Returned to Sender' })).toBe('bounce')
  })

  it('spots bulk and list mail', () => {
    expect(classifyAutomated({ precedence: 'bulk' })).toBe('bulk')
    expect(classifyAutomated({ listId: '<news.example.com>' })).toBe('bulk')
  })

  it('leaves an ordinary message alone', () => {
    expect(classifyAutomated({ fromAddress: 'customer@example.com', subject: 'Re: my order' })).toBeNull()
  })
})

describe('chooseThread', () => {
  const base = {
    inReplyTo: null as string | null,
    references: [] as string[],
    byMessageId: new Map<string, ThreadRef[]>(),
    subjectNormalised: 'order 1234',
    participants: ['customer@example.com'],
    sentAt: new Date('2026-08-20T10:00:00.000Z'),
    inboxId: 'inbox-1',
    candidates: [],
  }

  const candidate = {
    id: 'thread-1',
    inboxId: 'inbox-1',
    subjectNormalised: 'order 1234',
    lastMessageAt: new Date('2026-08-19T10:00:00.000Z'),
    participants: ['customer@example.com'],
  }

  it('threads on In-Reply-To before anything else', () => {
    expect(chooseThread({
      ...base,
      inReplyTo: 'a@x',
      byMessageId: new Map([['a@x', [{ threadId: 'thread-9', inboxId: 'inbox-1' }]]]),
      candidates: [candidate],
    })).toEqual({ threadId: 'thread-9', matchedOn: 'in-reply-to' })
  })

  it('falls back to References, nearest ancestor first', () => {
    expect(chooseThread({
      ...base,
      references: ['old@x', 'newer@x'],
      byMessageId: new Map([
        ['old@x', [{ threadId: 'thread-old', inboxId: 'inbox-1' }]],
        ['newer@x', [{ threadId: 'thread-new', inboxId: 'inbox-1' }]],
      ]),
    })).toEqual({ threadId: 'thread-new', matchedOn: 'references' })
  })

  it('uses subject, participant and time together when the headers say nothing', () => {
    expect(chooseThread({ ...base, candidates: [candidate] })).toEqual({
      threadId: 'thread-1',
      matchedOn: 'heuristic',
    })
  })

  it('will not join a stranger with the same subject', () => {
    expect(chooseThread({
      ...base,
      candidates: [{ ...candidate, participants: ['someone-else@example.com'] }],
    })).toEqual({ threadId: null, matchedOn: 'new' })
  })

  it('will not join a conversation from last year', () => {
    expect(chooseThread({
      ...base,
      candidates: [{ ...candidate, lastMessageAt: new Date('2025-08-19T10:00:00.000Z') }],
    })).toEqual({ threadId: null, matchedOn: 'new' })
  })

  it('will not join a conversation belonging to a different inbox', () => {
    expect(chooseThread({
      ...base,
      candidates: [{ ...candidate, inboxId: 'inbox-2' }],
    })).toEqual({ threadId: null, matchedOn: 'new' })
  })

  it('follows the header into this side\'s own conversation when a message is held on two', () => {
    // Chris's original is filed on Marcus's conversation AND on Chris's. Marcus
    // replies; his reply quotes that one Message-ID. Each side has to land on
    // its own thread, or the answer turns up in a tab its recipient cannot see.
    const byMessageId = new Map([['original@x', [
      { threadId: 'thread-marcus', inboxId: 'inbox-marcus' },
      { threadId: 'thread-chris', inboxId: 'inbox-chris' },
    ]]])

    expect(chooseThread({
      ...base, inReplyTo: 'original@x', byMessageId,
      inboxId: 'inbox-chris', restrictToInbox: true,
    })).toEqual({ threadId: 'thread-chris', matchedOn: 'in-reply-to' })

    expect(chooseThread({
      ...base, inReplyTo: 'original@x', byMessageId,
      inboxId: 'inbox-marcus', restrictToInbox: true,
    })).toEqual({ threadId: 'thread-marcus', matchedOn: 'in-reply-to' })
  })

  it('starts a conversation for a side that has none yet rather than borrowing the other one', () => {
    expect(chooseThread({
      ...base,
      inReplyTo: 'original@x',
      byMessageId: new Map([['original@x', [{ threadId: 'thread-marcus', inboxId: 'inbox-marcus' }]]]),
      inboxId: 'inbox-chris',
      restrictToInbox: true,
      candidates: [],
    })).toEqual({ threadId: null, matchedOn: 'new' })
  })

  it('restricted, will not fall back onto an unfiled conversation', () => {
    expect(chooseThread({
      ...base,
      candidates: [{ ...candidate, inboxId: null }],
      restrictToInbox: true,
    })).toEqual({ threadId: null, matchedOn: 'new' })
  })

  it('unrestricted, still takes the first thread a referenced id sits on', () => {
    expect(chooseThread({
      ...base,
      inReplyTo: 'original@x',
      byMessageId: new Map([['original@x', [
        { threadId: 'thread-marcus', inboxId: 'inbox-marcus' },
        { threadId: 'thread-chris', inboxId: 'inbox-chris' },
      ]]]),
    })).toEqual({ threadId: 'thread-marcus', matchedOn: 'in-reply-to' })
  })

  it('starts a new conversation for a message with no subject', () => {
    expect(chooseThread({ ...base, subjectNormalised: '', candidates: [candidate] }))
      .toEqual({ threadId: null, matchedOn: 'new' })
  })
})

describe('buildSnippet', () => {
  it('drops the quoted history so a reply does not preview as the message it replies to', () => {
    const snippet = buildSnippet('Yes, that is fine.\n\nOn 1 August 2026 at 09:00, Deskwell wrote:\n> Would Tuesday suit?')
    expect(snippet).toBe('Yes, that is fine.')
  })

  it('stops at a signature separator', () => {
    expect(buildSnippet('Thanks very much.\n--\nMarcus\nDeskwell')).toBe('Thanks very much.')
  })

  it('skips quoted lines wherever they are', () => {
    expect(buildSnippet('> old\nnew')).toBe('new')
  })

  it('truncates rather than handing a list view a whole email', () => {
    expect(buildSnippet('x'.repeat(500)).length).toBeLessThanOrEqual(200)
  })
})

describe('internalPairKey', () => {
  const sent = new Date('2026-09-02T23:53:10.000Z')

  it('matches the two copies of one internal email through a rewritten Message-ID', () => {
    // Same email, read twice: once from the sender's Sent folder, once from the
    // recipient's own. The relay rewrote the Message-ID on the way, so the
    // header cannot say they are the same. The size differs too, because
    // headers were added in transit - which is why size is not in the key.
    expect(internalPairKey({ sentAt: sent, fromAddress: 'marcus@deskwell.co.uk', subject: 'Re: Artisan Furniture' }))
      .toBe(internalPairKey({ sentAt: sent, fromAddress: 'Marcus@Deskwell.co.uk', subject: 'RE: Artisan Furniture' }))
  })

  it('does not match two different messages in the same conversation', () => {
    expect(internalPairKey({ sentAt: sent, fromAddress: 'marcus@deskwell.co.uk', subject: 'Re: Artisan Furniture' }))
      .not.toBe(internalPairKey({
        sentAt: new Date('2026-09-02T23:59:00.000Z'),
        fromAddress: 'marcus@deskwell.co.uk',
        subject: 'Re: Artisan Furniture',
      }))
  })

  it('does not match the two people in one conversation', () => {
    expect(internalPairKey({ sentAt: sent, fromAddress: 'marcus@deskwell.co.uk', subject: 'Artisan Furniture' }))
      .not.toBe(internalPairKey({ sentAt: sent, fromAddress: 'chris@deskwell.co.uk', subject: 'Artisan Furniture' }))
  })
})
