import { describe, it, expect } from 'vitest'
import {
  canEditDraft,
  canReadDraft,
  canSendDraftForOwner,
  draftHref,
  draftBodyText,
  draftPreview,
  htmlHasWriting,
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
    // A blind copy is somebody deliberately naming a recipient, which is as
    // much of a draft as a recipient in the To line is.
    expect(isWorthSaving({ to: [], cc: [], bcc: ['owner@deskwell.co.uk'], body: '' })).toBe(true)
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

  it('keeps a message that is nothing but two things off the catalogue', () => {
    // Somebody went and found them, which is the work worth not losing.
    expect(isWorthSaving({ body: '', products: [{}, {}] })).toBe(true)
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

describe('draftBodyText', () => {
  // The column holds two different things now - markup from the writing box, or
  // the plain lines every draft written before it holds - and the row says
  // which. Guessing from the content is how "a < b" ends up rendered as broken
  // markup, and how a pasted line of HTML ends up sent as live markup.

  it('leaves a body written as text exactly as it was typed', () => {
    expect(draftBodyText({ body: 'a < b, and 3 > 2', bodyFormat: 'text' })).toBe('a < b, and 3 > 2')
  })

  it('says what a body written as markup actually says', () => {
    expect(draftBodyText({
      body: '<b>Dear Marcus</b>,<br>about the <a href="https://example.com">quote</a>.',
      bodyFormat: 'html',
    })).toBe('Dear Marcus,\nabout the quote.')
  })

  it('gives a list its lines back rather than running it together', () => {
    expect(draftBodyText({
      body: '<ul><li>Chairs</li><li>Desks</li></ul>',
      bodyFormat: 'html',
    })).toBe('Chairs\nDesks')
  })

  it('turns an escaped angle bracket back into one, and not into a tag', () => {
    // The order of the unescaping matters: turning &amp; back first would make
    // "&amp;lt;" into "&lt;" and then into "<", which is a tag somebody never
    // wrote reappearing in a preview.
    expect(draftBodyText({ body: '<p>a &amp;lt; b</p>', bodyFormat: 'html' })).toBe('a &lt; b')
  })

  it('takes a body with no format on it as text, which is the harmless reading', () => {
    expect(draftBodyText({ body: '<not a tag>' })).toBe('<not a tag>')
  })
})

describe('htmlHasWriting', () => {
  // A writing box somebody has cleared out does not hand back an empty string,
  // and "there is nothing to send yet" is the wrong thing to say to somebody
  // who has written something - and the wrong thing NOT to say to somebody who
  // has not.

  it('is false for what an emptied box actually contains', () => {
    expect(htmlHasWriting('')).toBe(false)
    expect(htmlHasWriting('<br>')).toBe(false)
    expect(htmlHasWriting('<div><br></div>')).toBe(false)
    expect(htmlHasWriting('<p>&nbsp;</p>')).toBe(false)
  })

  it('is true the moment there is a word in it', () => {
    expect(htmlHasWriting('<div>Yes</div>')).toBe(true)
    expect(htmlHasWriting('<ul><li>Chairs</li></ul>')).toBe(true)
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

  it('lets the author read their own, filed or not', () => {
    expect(canReadDraft(filed, 'marcus')).toBe(true)
    expect(canReadDraft(loose, 'marcus')).toBe(true)
  })

  it('refuses a colleague who can read the address it is filed on', () => {
    // The whole point. Sharing accounts@ shares what has been sent and what has
    // arrived, and not what somebody is halfway through typing.
    expect(canReadDraft(filed, 'chris')).toBe(false)
  })

  it('refuses a colleague a draft filed on no address at all', () => {
    expect(canReadDraft(loose, 'chris')).toBe(false)
  })
})

describe('canEditDraft', () => {
  const filed = { authorUserId: 'marcus', inboxId: 'accounts' }
  const loose = { authorUserId: 'marcus', inboxId: null }

  it('lets the author finish their own, filed or not', () => {
    expect(canEditDraft(filed, 'marcus')).toBe(true)
    expect(canEditDraft(loose, 'marcus')).toBe(true)
  })

  it('refuses a colleague who may send as the address it is filed on', () => {
    // Being able to post as accounts@ is not being able to finish somebody
    // else's sentence and post it. The price is a draft whose author is on
    // leave waiting for them, which is the price every mail program pays.
    expect(canEditDraft(filed, 'chris')).toBe(false)
    expect(canEditDraft(loose, 'chris')).toBe(false)
  })
})

describe('canSendDraftForOwner', () => {
  const sams = { id: 'sam-inbox', kind: 'individual' as const, ownerUserId: 'sam' }
  const shared = { id: 'accounts', kind: 'shared' as const, ownerUserId: null }
  const samsDraft = { authorUserId: 'sam', inboxId: 'sam-inbox' }

  it("lets somebody who may send from Sam's address post Sam's draft for him", () => {
    // The whole feature: a finished quote sitting on the address of somebody on
    // leave, and a colleague already reading every word of it.
    expect(canSendDraftForOwner(samsDraft, sams, true)).toBe(true)
  })

  it('refuses somebody who may only READ the address', () => {
    // Reading somebody's post is not posting as them (D16), and this is the
    // send half of that same grant rather than a new one.
    expect(canSendDraftForOwner(samsDraft, sams, false)).toBe(false)
  })

  it('refuses a draft filed on a different address', () => {
    expect(canSendDraftForOwner({ authorUserId: 'sam', inboxId: 'accounts' }, sams, true)).toBe(false)
  })

  it('refuses a draft that is not the owner of that address', () => {
    // Somebody else's writing that happens to sit here is not Sam's draft, and
    // the folder under Sam's name is not a way to reach it.
    expect(canSendDraftForOwner({ authorUserId: 'marcus', inboxId: 'sam-inbox' }, sams, true)).toBe(false)
  })

  it('refuses a shared address, which has no owner to send on behalf of', () => {
    expect(canSendDraftForOwner({ authorUserId: 'marcus', inboxId: 'accounts' }, shared, true)).toBe(false)
  })

  it("refuses an individual address whose owner's account has gone", () => {
    const nobodys = { id: 'sam-inbox', kind: 'individual' as const, ownerUserId: null }
    expect(canSendDraftForOwner(samsDraft, nobodys, true)).toBe(false)
  })
})
