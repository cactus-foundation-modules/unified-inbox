import { describe, it, expect } from 'vitest'
import { decideInboxAccess, threadAccessKind } from './access'

// The rule these cover is D16, and getting it backwards is a privacy defect
// rather than a bug: an inbox with a guest list must be closed to everybody not
// on it, and an inbox without one must stay open to the whole team.

const VIEWER = { canView: true, canReply: false, canManage: false }
const REPLIER = { canView: true, canReply: true, canManage: false }
const MANAGER = { canView: false, canReply: false, canManage: true }
const OUTSIDER = { canView: false, canReply: false, canManage: false }

describe('decideInboxAccess', () => {
  it('opens an inbox with no guest list to anybody who can view the hub', () => {
    expect(decideInboxAccess([], 'u1', VIEWER)).toEqual({ view: true, reply: false })
    expect(decideInboxAccess([], 'u1', REPLIER)).toEqual({ view: true, reply: true })
  })

  it('closes an inbox with a guest list to everybody not on it', () => {
    const rows = [{ userId: 'u2', canReply: true }]
    expect(decideInboxAccess(rows, 'u1', REPLIER)).toEqual({ view: false, reply: false })
    expect(decideInboxAccess(rows, 'u2', REPLIER)).toEqual({ view: true, reply: true })
  })

  it('lets somebody read an inbox they may not reply to', () => {
    const rows = [{ userId: 'u1', canReply: false }]
    expect(decideInboxAccess(rows, 'u1', REPLIER)).toEqual({ view: true, reply: false })
  })

  it('still needs the reply permission, whatever the guest list says', () => {
    const rows = [{ userId: 'u1', canReply: true }]
    expect(decideInboxAccess(rows, 'u1', VIEWER)).toEqual({ view: true, reply: false })
  })

  it('gives nothing to somebody without permission to view the hub at all', () => {
    expect(decideInboxAccess([], 'u1', OUTSIDER)).toEqual({ view: false, reply: false })
    expect(decideInboxAccess([{ userId: 'u1', canReply: true }], 'u1', OUTSIDER))
      .toEqual({ view: false, reply: false })
  })

  it('lets whoever edits the guest lists past them', () => {
    expect(decideInboxAccess([{ userId: 'u2', canReply: true }], 'u1', MANAGER))
      .toEqual({ view: true, reply: true })
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
