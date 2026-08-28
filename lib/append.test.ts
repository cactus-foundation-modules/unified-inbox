import { describe, it, expect, vi, beforeEach } from 'vitest'

const imap = vi.hoisted(() => ({
  openMailbox: vi.fn(),
  credentialsForConnection: vi.fn(),
  listFolders: vi.fn(),
  explainImapError: vi.fn((err: unknown) => (err instanceof Error ? err.message : String(err))),
}))

const db = vi.hoisted(() => ({
  acquireConnectionLock: vi.fn(),
  releaseConnectionLock: vi.fn(),
}))

vi.mock('./imap', () => imap)
vi.mock('./db', () => db)

import { appendToSent, resolveSentFolder } from './append'

const RAW = Buffer.from('From: a@b\r\n\r\nhello')

function client(overrides: Record<string, unknown> = {}) {
  return {
    append: vi.fn().mockResolvedValue({ uid: 7 }),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  db.acquireConnectionLock.mockResolvedValue(true)
  db.releaseConnectionLock.mockResolvedValue(undefined)
  imap.credentialsForConnection.mockResolvedValue({})
  imap.listFolders.mockResolvedValue([
    { path: 'INBOX', name: 'INBOX', specialUse: null, role: 'inbox' },
    { path: 'Sent Messages', name: 'Sent Messages', specialUse: '\\Sent', role: 'sent' },
  ])
})

describe('resolveSentFolder', () => {
  it('an owner who named a folder meant it', async () => {
    const c = client()
    imap.openMailbox.mockResolvedValue(c)
    expect(await resolveSentFolder(c as never, 'My Sent Mail')).toBe('My Sent Mail')
    expect(imap.listFolders).not.toHaveBeenCalled()
  })

  it('otherwise asks the server which folder it considers Sent', async () => {
    const c = client()
    expect(await resolveSentFolder(c as never, null)).toBe('Sent Messages')
  })

  it('answers nothing rather than guessing at a folder that may not exist', async () => {
    imap.listFolders.mockResolvedValue([{ path: 'INBOX', name: 'INBOX', specialUse: null, role: 'inbox' }])
    const c = client()
    expect(await resolveSentFolder(c as never, null)).toBeNull()
  })
})

describe('appendToSent - the only write this module makes to a mailbox', () => {
  it('files the copy and says where it went', async () => {
    const c = client()
    imap.openMailbox.mockResolvedValue(c)

    const result = await appendToSent({
      connectionId: 'conn-1',
      sentFolder: null,
      raw: RAW,
      sentAt: new Date('2026-03-03T14:05:00Z'),
    })

    expect(result).toEqual({ ok: true, folder: 'Sent Messages', uid: 7 })
    expect(c.append).toHaveBeenCalledWith(
      'Sent Messages',
      RAW,
      ['\\Seen'],
      new Date('2026-03-03T14:05:00Z'),
    )
  })

  it('marks the copy read - our own reply showing as unread on a phone is a false alarm', async () => {
    const c = client()
    imap.openMailbox.mockResolvedValue(c)
    await appendToSent({ connectionId: 'conn-1', sentFolder: null, raw: RAW, sentAt: new Date() })
    expect(c.append.mock.calls[0]![2]).toEqual(['\\Seen'])
  })

  it('waits rather than opening a second connection to a busy account (E6)', async () => {
    db.acquireConnectionLock.mockResolvedValue(false)

    const result = await appendToSent({
      connectionId: 'conn-1',
      sentFolder: null,
      raw: RAW,
      sentAt: new Date(),
    })

    expect(result.ok).toBe(false)
    expect(imap.openMailbox).not.toHaveBeenCalled()
  })

  it('never throws, whatever the mail server does', async () => {
    imap.openMailbox.mockRejectedValue(new Error('Invalid credentials'))

    const result = await appendToSent({
      connectionId: 'conn-1',
      sentFolder: null,
      raw: RAW,
      sentAt: new Date(),
    })

    expect(result).toEqual({ ok: false, reason: 'Invalid credentials' })
  })

  it('gives the account back even when the append fails', async () => {
    const c = client({ append: vi.fn().mockRejectedValue(new Error('over quota')) })
    imap.openMailbox.mockResolvedValue(c)

    const result = await appendToSent({
      connectionId: 'conn-1',
      sentFolder: null,
      raw: RAW,
      sentAt: new Date(),
    })

    expect(result.ok).toBe(false)
    expect(db.releaseConnectionLock).toHaveBeenCalledWith('conn-1')
    expect(c.logout).toHaveBeenCalled()
  })

  it('says so plainly when the account has no Sent folder to file into', async () => {
    imap.listFolders.mockResolvedValue([{ path: 'INBOX', name: 'INBOX', specialUse: null, role: 'inbox' }])
    imap.openMailbox.mockResolvedValue(client())

    const result = await appendToSent({
      connectionId: 'conn-1',
      sentFolder: null,
      raw: RAW,
      sentAt: new Date(),
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toContain('Sent folder')
    expect(result.reason).not.toMatch(/IMAP|APPEND|SPECIAL-USE/)
  })

  it('copes with a server that does not say which UID it used', async () => {
    imap.openMailbox.mockResolvedValue(client({ append: vi.fn().mockResolvedValue(undefined) }))

    const result = await appendToSent({
      connectionId: 'conn-1',
      sentFolder: 'Sent',
      raw: RAW,
      sentAt: new Date(),
    })

    expect(result).toEqual({ ok: true, folder: 'Sent', uid: null })
  })
})
