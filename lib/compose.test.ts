import { describe, it, expect } from 'vitest'
import {
  generateMessageId,
  messageIdHeader,
  buildReferences,
  replySubject,
  forwardSubject,
  replyRecipients,
  quoteForReply,
  quoteForForward,
  assembleBody,
  checkAttachmentBudget,
  outgoingHeaders,
  encodedSize,
  describeSize,
  MAX_SINGLE_ATTACHMENT_BYTES,
} from './compose'

describe('generateMessageId', () => {
  it('is stored without angle brackets so it compares equal to a parsed one', () => {
    const id = generateMessageId('marcus@deskwell.co.uk')
    expect(id.startsWith('<')).toBe(false)
    expect(id.endsWith('>')).toBe(false)
  })

  it('uses the sending address own domain', () => {
    expect(generateMessageId('marcus@deskwell.co.uk')).toMatch(/@deskwell\.co\.uk$/)
    expect(generateMessageId('Marcus <MARCUS@Deskwell.co.uk>')).toMatch(/@deskwell\.co\.uk$/)
  })

  it('does not repeat itself', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateMessageId('hi@example.com')))
    expect(ids.size).toBe(50)
  })

  it('puts the brackets back for the header', () => {
    expect(messageIdHeader('uin.abc@example.com')).toBe('<uin.abc@example.com>')
    expect(messageIdHeader('<uin.abc@example.com>')).toBe('<uin.abc@example.com>')
  })
})

describe('buildReferences', () => {
  it('carries the parent chain and appends the parent itself', () => {
    expect(
      buildReferences({ messageIdHeader: 'c@x', references: ['a@x', 'b@x'] }),
    ).toEqual(['a@x', 'b@x', 'c@x'])
  })

  it('starts a chain when the parent had none', () => {
    expect(buildReferences({ messageIdHeader: 'a@x', references: [] })).toEqual(['a@x'])
  })

  it('drops the brackets and any duplicate', () => {
    expect(
      buildReferences({ messageIdHeader: '<b@x>', references: ['<a@x>', 'b@x', 'a@x'] }),
    ).toEqual(['a@x', 'b@x'])
  })

  it('survives a parent with no Message-ID of its own', () => {
    expect(buildReferences({ messageIdHeader: null, references: ['a@x'] })).toEqual(['a@x'])
  })

  it('keeps the oldest and the newest when a long thread will not fit', () => {
    const refs = Array.from({ length: 60 }, (_, i) => `m${i}@x`)
    const out = buildReferences({ messageIdHeader: 'last@x', references: refs })
    expect(out).toHaveLength(20)
    expect(out[0]).toBe('m0@x')
    expect(out[out.length - 1]).toBe('last@x')
  })
})

describe('subjects', () => {
  it('adds Re: once and never twice', () => {
    expect(replySubject('Chairs')).toBe('Re: Chairs')
    expect(replySubject('Re: Chairs')).toBe('Re: Chairs')
    expect(replySubject('RE: Chairs')).toBe('RE: Chairs')
  })

  it('copes with nothing to answer', () => {
    expect(replySubject(null)).toBe('Re: (no subject)')
    expect(replySubject('   ')).toBe('Re: (no subject)')
  })

  it('adds Fwd: once', () => {
    expect(forwardSubject('Chairs')).toBe('Fwd: Chairs')
    expect(forwardSubject('Fwd: Chairs')).toBe('Fwd: Chairs')
    expect(forwardSubject('Fw: Chairs')).toBe('Fw: Chairs')
  })
})

describe('replyRecipients (E13)', () => {
  const base = {
    fromAddress: 'jane@customer.com',
    replyTo: null,
    toAddresses: ['hi@deskwell.co.uk'],
    ccAddresses: ['bob@customer.com'],
  }

  it('answers the sender', () => {
    expect(replyRecipients(base, 'reply', ['hi@deskwell.co.uk'])).toEqual({
      to: ['jane@customer.com'],
      cc: [],
    })
  })

  it('Reply-To beats From - getting this wrong writes to an address nobody reads', () => {
    const out = replyRecipients(
      { ...base, replyTo: 'sales@customer.com' },
      'reply',
      ['hi@deskwell.co.uk'],
    )
    expect(out.to).toEqual(['sales@customer.com'])
  })

  it('reply-all keeps everybody else and drops us', () => {
    const out = replyRecipients(base, 'reply-all', ['hi@deskwell.co.uk'])
    expect(out.to).toEqual(['jane@customer.com'])
    expect(out.cc).toEqual(['bob@customer.com'])
    expect(out.cc).not.toContain('hi@deskwell.co.uk')
  })

  it('never copies the reply to the address that would loop it back in', () => {
    const out = replyRecipients(
      { ...base, ccAddresses: ['hi@deskwell.co.uk', 'marcus@deskwell.co.uk'] },
      'reply-all',
      ['hi@deskwell.co.uk', 'marcus@deskwell.co.uk'],
    )
    expect(out.cc).toEqual([])
  })

  it('does not put the same person on twice', () => {
    const out = replyRecipients(
      { ...base, toAddresses: ['jane@customer.com'], ccAddresses: ['Jane <JANE@customer.com>'] },
      'reply-all',
      [],
    )
    expect(out.to).toEqual(['jane@customer.com'])
    expect(out.cc).toEqual([])
  })

  it('returns nothing to send to when the original has no usable sender', () => {
    expect(
      replyRecipients({ ...base, fromAddress: null, replyTo: null }, 'reply-all', []),
    ).toEqual({ to: [], cc: [] })
  })
})

describe('quoting', () => {
  const original = {
    sentAt: new Date('2026-03-03T14:05:00Z'),
    fromName: 'Jane Smith',
    fromAddress: 'jane@customer.com',
    toAddresses: ['hi@deskwell.co.uk'],
    subject: 'Chairs',
    bodyText: 'Do you have them in blue?',
    bodyHtml: '<p>Do you have them in blue?</p>',
  }

  it('stamps the attribution line in the site timezone, not the server one', () => {
    // 14:05 UTC on 3 March 2026 is 14:05 in London (still GMT); in summer the
    // same maths is what stopped a reply quoting a customer an hour early.
    expect(quoteForReply(original, 'Europe/London').text).toContain('at 14:05')
    expect(quoteForReply({ ...original, sentAt: new Date('2026-07-03T13:05:00Z') }, 'Europe/London').text)
      .toContain('at 14:05')
    expect(quoteForReply({ ...original, sentAt: new Date('2026-07-03T13:05:00Z') }, 'UTC').text)
      .toContain('at 13:05')
  })

  it('quotes with an attribution line a mail client will fold away', () => {
    const q = quoteForReply(original, 'Europe/London')
    expect(q.html).toContain('Jane Smith')
    expect(q.html).toContain('<blockquote')
    expect(q.text).toContain('> Do you have them in blue?')
  })

  it('strips anything dangerous out of the quoted markup', () => {
    const q = quoteForReply({ ...original, bodyHtml: '<p>hi</p><script>alert(1)</script>' }, 'Europe/London')
    expect(q.html).not.toContain('<script')
  })

  it('falls back to the text part when there is no HTML', () => {
    const q = quoteForReply({ ...original, bodyHtml: null }, 'Europe/London')
    expect(q.html).toContain('Do you have them in blue?')
  })

  it('a forward reproduces the original headers in the body, not in From (E12)', () => {
    const q = quoteForForward(original, 'Europe/London')
    expect(q.html).toContain('Forwarded message')
    expect(q.html).toContain('jane@customer.com')
    expect(q.text).toContain('From: Jane Smith jane@customer.com')
  })
})

describe('assembleBody', () => {
  it('puts what was typed first, then the signature, then the quote', () => {
    const out = assembleBody({
      bodyHtml: '<p>Yes, in blue.</p>',
      signature: { html: '<p>Marcus</p>', text: 'Marcus' },
      quoted: { html: '<blockquote>old</blockquote>', text: '\n\n> old' },
    })
    expect(out.html.indexOf('Yes, in blue.')).toBeLessThan(out.html.indexOf('Marcus'))
    expect(out.html.indexOf('Marcus')).toBeLessThan(out.html.indexOf('blockquote'))
    expect(out.text).toContain('Yes, in blue.')
    expect(out.text).toContain('> old')
  })

  it('takes the plain text half from the signature rather than flattening it again', () => {
    const out = assembleBody({
      bodyHtml: '<p>Yes.</p>',
      // What a rich text signature renders to: the markdown flattens more
      // kindly than its own HTML does.
      signature: { html: '<p>Kind regards,<br>Marcus</p>', text: 'Kind regards,\nMarcus' },
      quoted: null,
    })
    expect(out.text).toContain('Kind regards,\nMarcus')
  })

  it('copes with no signature and no quote', () => {
    const out = assembleBody({ bodyHtml: '<p>Hello</p>', signature: null, quoted: null })
    expect(out.html).toBe('<p>Hello</p>')
    expect(out.text).toBe('Hello')
  })

  it('sanitises what the composer sends, because a composer is still an input', () => {
    const out = assembleBody({
      bodyHtml: '<p>Hi</p><script>alert(1)</script>',
      signature: null,
      quoted: null,
    })
    expect(out.html).not.toContain('<script')
  })
})

describe('checkAttachmentBudget (5.2 - never silently dropped)', () => {
  it('lets a sensible message through', () => {
    const out = checkAttachmentBudget(
      [{ filename: 'quote.pdf', contentType: 'application/pdf', sizeBytes: 200_000 }],
      5_000,
    )
    expect(out.ok).toBe(true)
  })

  it('refuses one file that core would silently drop, and names it', () => {
    const out = checkAttachmentBudget(
      [{ filename: 'catalogue.pdf', contentType: 'application/pdf', sizeBytes: MAX_SINGLE_ATTACHMENT_BYTES + 1 }],
      1_000,
    )
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected a refusal')
    expect(out.reason).toContain('catalogue.pdf')
    expect(out.reason).not.toMatch(/base64|MIME|payload/i)
  })

  it('refuses a pile that only busts the ceiling once encoded', () => {
    // Four 2MB files are 8MB raw and comfortably inside 9MB, but 10.6MB once
    // base64 has had them - which is the size that actually travels.
    const files = Array.from({ length: 4 }, (_, i) => ({
      filename: `photo-${i}.jpg`,
      contentType: 'image/jpeg',
      sizeBytes: 2 * 1024 * 1024,
    }))
    expect(files.reduce((n, f) => n + f.sizeBytes, 0)).toBeLessThan(9 * 1024 * 1024)
    const out = checkAttachmentBudget(files, 2_000)
    expect(out.ok).toBe(false)
  })

  it('says so in English a small-business owner can act on', () => {
    const out = checkAttachmentBudget(
      [{ filename: 'big.pdf', contentType: null, sizeBytes: 20 * 1024 * 1024 }],
      0,
    )
    if (out.ok) throw new Error('expected a refusal')
    expect(out.reason).toMatch(/too big/i)
    expect(out.reason).toMatch(/20\.0MB/)
  })

  it('counts base64 overhead at four bytes for three', () => {
    expect(encodedSize(3)).toBe(4)
    expect(encodedSize(300)).toBe(400)
  })

  it('describes sizes the way a person writes them', () => {
    expect(describeSize(512)).toBe('512 bytes')
    expect(describeSize(2048)).toBe('2KB')
    expect(describeSize(3 * 1024 * 1024)).toBe('3.0MB')
  })
})

describe('outgoingHeaders', () => {
  it('always sets a bracketed Message-ID', () => {
    const h = outgoingHeaders({ messageId: 'uin.a@x.com', inReplyTo: null, references: [] })
    expect(h['Message-ID']).toBe('<uin.a@x.com>')
    expect(h['In-Reply-To']).toBeUndefined()
    expect(h['References']).toBeUndefined()
  })

  it('brackets every id in the chain, space separated, as RFC 5322 wants', () => {
    const h = outgoingHeaders({
      messageId: 'uin.c@x.com',
      inReplyTo: 'b@x.com',
      references: ['a@x.com', 'b@x.com'],
    })
    expect(h['In-Reply-To']).toBe('<b@x.com>')
    expect(h['References']).toBe('<a@x.com> <b@x.com>')
  })

  it('emits nothing else - every header here is one somebody has to account for', () => {
    const h = outgoingHeaders({ messageId: 'uin.a@x.com', inReplyTo: 'b@x', references: ['b@x'] })
    expect(Object.keys(h).sort()).toEqual(['In-Reply-To', 'Message-ID', 'References'])
  })
})
