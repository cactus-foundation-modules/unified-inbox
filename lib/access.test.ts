import { describe, it, expect } from 'vitest'
import { audienceForSave, decideInboxAccess, threadAccessKind } from './access'

// The rule these cover is D16, and getting it backwards is a privacy defect
// rather than a bug: an inbox with a guest list must be closed to everybody not
// on it, and an inbox without one must stay open to the whole team.

const VIEWER = { canView: true, canReply: false, canManage: false }
const REPLIER = { canView: true, canReply: true, canManage: false }
const MANAGER = { canView: false, canReply: false, canManage: true }
const OUTSIDER = { canView: false, canReply: false, canManage: false }

/** A shared address: the guest list decides, as it always has. */
const SHARED = { kind: 'shared' as const, ownerUserId: null }
/** One person's own post. The guest list is not consulted at all. */
const own = (userId: string | null) => ({ kind: 'individual' as const, ownerUserId: userId })

describe('decideInboxAccess', () => {
  it('opens an inbox with no guest list to anybody who can view the hub', () => {
    expect(decideInboxAccess(SHARED, [], 'u1', VIEWER)).toEqual({ view: true, reply: false })
    expect(decideInboxAccess(SHARED, [], 'u1', REPLIER)).toEqual({ view: true, reply: true })
  })

  it('closes an inbox with a guest list to everybody not on it', () => {
    const rows = [{ userId: 'u2', canReply: true }]
    expect(decideInboxAccess(SHARED, rows, 'u1', REPLIER)).toEqual({ view: false, reply: false })
    expect(decideInboxAccess(SHARED, rows, 'u2', REPLIER)).toEqual({ view: true, reply: true })
  })

  it('lets somebody read an inbox they may not reply to', () => {
    const rows = [{ userId: 'u1', canReply: false }]
    expect(decideInboxAccess(SHARED, rows, 'u1', REPLIER)).toEqual({ view: true, reply: false })
  })

  it('still needs the reply permission, whatever the guest list says', () => {
    const rows = [{ userId: 'u1', canReply: true }]
    expect(decideInboxAccess(SHARED, rows, 'u1', VIEWER)).toEqual({ view: true, reply: false })
  })

  it('gives nothing to somebody without permission to view the hub at all', () => {
    expect(decideInboxAccess(SHARED, [], 'u1', OUTSIDER)).toEqual({ view: false, reply: false })
    expect(decideInboxAccess(SHARED, [{ userId: 'u1', canReply: true }], 'u1', OUTSIDER))
      .toEqual({ view: false, reply: false })
  })

  it('lets whoever edits the guest lists past them', () => {
    expect(decideInboxAccess(SHARED, [{ userId: 'u2', canReply: true }], 'u1', MANAGER))
      .toEqual({ view: true, reply: true })
  })
})

// An individual inbox is the one place in this module where `manage` is not a
// way past a list. Getting THAT backwards is the privacy defect the whole
// distinction exists to prevent, so it gets its own block.
describe('decideInboxAccess, on somebody\u2019s own inbox', () => {
  it('gives it to its owner', () => {
    expect(decideInboxAccess(own('u1'), [], 'u1', REPLIER)).toEqual({ view: true, reply: true })
    expect(decideInboxAccess(own('u1'), [], 'u1', VIEWER)).toEqual({ view: true, reply: false })
  })

  it('keeps it from a colleague, whatever the guest list happens to say', () => {
    const rows = [{ userId: 'u2', canReply: true }]
    expect(decideInboxAccess(own('u1'), rows, 'u2', REPLIER)).toEqual({ view: false, reply: false })
  })

  it('keeps it from an administrator too', () => {
    expect(decideInboxAccess(own('u1'), [], 'u2', MANAGER)).toEqual({ view: false, reply: false })
    expect(decideInboxAccess(own('u1'), [], 'u2', { canView: true, canReply: true, canManage: true }))
      .toEqual({ view: false, reply: false })
  })

  it('still needs its owner to be allowed in the hub at all', () => {
    expect(decideInboxAccess(own('u1'), [], 'u1', OUTSIDER)).toEqual({ view: false, reply: false })
  })

  it('leaves an inbox whose owner has gone to an administrator rather than to nobody', () => {
    expect(decideInboxAccess(own(null), [], 'u1', MANAGER)).toEqual({ view: true, reply: true })
    expect(decideInboxAccess(own(null), [], 'u1', REPLIER)).toEqual({ view: false, reply: false })
  })
})

describe('audienceForSave', () => {
  it('leaves a shared inbox exactly as the form sent it', () => {
    const entries = [{ userId: 'u1', canReply: true }, { userId: 'u2', canReply: false }]
    expect(audienceForSave(SHARED, entries, ['u1'])).toEqual({ entries, defaultUserIds: ['u1'] })
  })

  it('writes the owner, and only the owner, on a personal one', () => {
    expect(audienceForSave(own('u1'), [{ userId: 'u2', canReply: true }], ['u2'])).toEqual({
      entries: [{ userId: 'u1', canReply: true }],
      defaultUserIds: ['u1'],
    })
  })

  it('writes nobody at all when there is no owner left to write', () => {
    expect(audienceForSave(own(null), [{ userId: 'u2', canReply: true }], ['u2']))
      .toEqual({ entries: [], defaultUserIds: [] })
  })
})

// A conversation that arrived through another module's channel has no address,
// so it has no inbox - and reading that as "nobody could place this" is what
// locks a colleague out of the chats and enquiries on their own screen. These
// three cases are the whole distinction.
describe('threadAccessKind', () => {
  it('sends a channel conversation to the module that owns it, inbox or not', () => {
    expect(threadAccessKind({ inboxId: null, providerModule: 'live-chat' })).toBe('channel')
    expect(threadAccessKind({ inboxId: 'in1', providerModule: 'contact-form' })).toBe('channel')
  })

  it('sends a filed email to its inbox guest list', () => {
    expect(threadAccessKind({ inboxId: 'in1', providerModule: null })).toBe('filed')
  })

  it('leaves only genuinely unplaceable email to an administrator', () => {
    expect(threadAccessKind({ inboxId: null, providerModule: null })).toBe('unfiled')
  })
})
