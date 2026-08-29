import { describe, it, expect } from 'vitest'
import {
  canEditDraft,
  canReadDraft,
  draftHref,
  draftPreview,
  draftRecipientLabel,
  draftSubjectLabel,
  isWorthSaving,
  splitAddresses,
} from './drafts'

describe('splitAddresses', () => {
  it('takes commas, semicolons and whatever spacing somebody used', () => {
    expect(splitAddresses('a@example.com, b@example.com ;c@example.com'))
      .toEqual(['a@example.com', 'b@example.com', 'c@example.com'])
  })

  it('is nothing at all when nothing was typed', () => {
    expect(splitAddresses('')).toEqual([])
    expect(splitAddresses('  ,  ; ')).toEqual([])
  })
})

describe('isWorthSaving', () => {
  it('refuses a composer nobody has touched', () => {
    // Otherwise every conversation somebody merely opened leaves a blank row,
    // and a Drafts list full of blanks is worse than no Drafts list.
    expect(isWorthSaving({ to: [], cc: [], subject: '', body: '   ', attachments: [] })).toBe(false)
  })

  it('keeps anything with words in it', () => {
    expect(isWorthSaving({ body: 'Dear Marcus' })).toBe(true)
  })

  it('keeps a recipient, a subject or a file on their own', () => {
    expect(isWorthSaving({ to: ['a@example.com'], body: '' })).toBe(true)
    expect(isWorthSaving({ cc: ['a@example.com'], body: '' })).toBe(true)
    expect(isWorthSaving({ subject: 'The quote', body: '' })).toBe(true)
    expect(isWorthSaving({ body: '', attachments: [{}] })).toBe(true)
  })
})

describe('draftRecipientLabel', () => {
  it('names the one recipient', () => {
    expect(draftRecipientLabel({ to: ['jane@example.com'], threadId: null }))
      .toBe('jane@example.com')
  })

  it('counts the rest rather than running off the row', () => {
    expect(draftRecipientLabel({ to: ['a@x.com', 'b@x.com'], threadId: null }))
      .toBe('a@x.com and 1 other')
    expect(draftRecipientLabel({ to: ['a@x.com', 'b@x.com', 'c@x.com'], threadId: null }))
      .toBe('a@x.com and 2 others')
  })

  it('says a reply carries its recipients on the conversation', () => {
    expect(draftRecipientLabel({ to: [], threadId: 'thr_1' })).toBe('A reply')
    expect(draftRecipientLabel({ to: [], threadId: null })).toBe('No recipient yet')
  })
})

describe('draftSubjectLabel', () => {
  it('admits to an empty subject rather than showing a gap', () => {
    expect(draftSubjectLabel({ subject: '  ' })).toBe('(no subject)')
    expect(draftSubjectLabel({ subject: 'Quote 1042' })).toBe('Quote 1042')
  })
})

describe('draftPreview', () => {
  it('flattens the newlines a textarea collects', () => {
    expect(draftPreview('Dear Marcus,\n\nAbout the quote')).toBe('Dear Marcus, About the quote')
  })

  it('stops at the limit', () => {
    const preview = draftPreview('x'.repeat(400), 20)
    expect(preview).toHaveLength(20)
    expect(preview.endsWith('…')).toBe(true)
  })
})

describe('draftHref', () => {
  const base = '/cactus-admin/inbox'
  const params = { tab: 'unified-inbox', inbox: 'drafts' }

  it('sends a reply back to its conversation, with Drafts still the open tab', () => {
    const href = draftHref(base, params, { id: 'dft_1', threadId: 'thr_9' })
    expect(href).toContain('id=thr_9')
    expect(href).toContain('inbox=drafts')
    expect(href).not.toContain('compose=1')
    expect(href).not.toContain('draft=')
  })

  it('sends a new message to the compose screen carrying its id', () => {
    const href = draftHref(base, params, { id: 'dft_2', threadId: null })
    expect(href).toContain('compose=1')
    expect(href).toContain('draft=dft_2')
    expect(href).not.toContain('id=')
  })
})

describe('canReadDraft', () => {
  const filed = { authorUserId: 'marcus', inboxId: 'accounts' }
  const loose = { authorUserId: 'marcus', inboxId: null }

  it('lets anybody who can read the address read a draft filed on it', () => {
    expect(canReadDraft(filed, 'chris', ['accounts', 'hi'])).toBe(true)
  })

  it('refuses a draft filed on an address this person cannot read', () => {
    expect(canReadDraft(filed, 'chris', ['hi'])).toBe(false)
  })

  it('refuses even the author once they are off that address', () => {
    // The old rule let an author keep their own draft on an inbox they had been
    // removed from. It is the address that decides now, for everybody.
    expect(canReadDraft(filed, 'marcus', ['hi'])).toBe(false)
  })

  it('keeps a draft with no address to its author', () => {
    expect(canReadDraft(loose, 'marcus', [])).toBe(true)
    expect(canReadDraft(loose, 'chris', ['accounts', 'hi'])).toBe(false)
  })
})

describe('canEditDraft', () => {
  const filed = { authorUserId: 'marcus', inboxId: 'accounts' }
  const loose = { authorUserId: 'marcus', inboxId: null }

  it('lets the author finish their own, whatever they may send from', () => {
    expect(canEditDraft(filed, 'marcus', [])).toBe(true)
  })

  it('lets anybody who may SEND as the address finish a draft filed on it', () => {
    expect(canEditDraft(filed, 'chris', ['accounts', 'hi'])).toBe(true)
  })

  it('refuses somebody who may only read the address', () => {
    // The list handed in is the sendable one. Reading accounts@ and being able
    // to post as it are different rights, and only the second one is here.
    expect(canEditDraft(filed, 'chris', ['hi'])).toBe(false)
  })

  it('keeps a draft with no address to its author, however much they may send as', () => {
    // No inbox means no guest list to grant sending through: it is answering a
    // conversation another module owns.
    expect(canEditDraft(loose, 'chris', ['accounts', 'hi'])).toBe(false)
    expect(canEditDraft(loose, 'marcus', [])).toBe(true)
  })
})
