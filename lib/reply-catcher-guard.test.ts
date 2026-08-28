import { describe, expect, it, vi, beforeEach } from 'vitest'

// Two things polling one mailbox files every email twice, in two places, with
// nobody told. The guard's whole job is to notice that and refuse - and, just
// as importantly, to cost nothing and block nothing on the overwhelming
// majority of sites where the other module is not installed at all.

const installedModuleNames = vi.hoisted(() => vi.fn())
const existingTables = vi.hoisted(() => vi.fn())
const listConnections = vi.hoisted(() => vi.fn())
const queryRaw = vi.hoisted(() => vi.fn())

vi.mock('./installed', () => ({ installedModuleNames, existingTables }))
vi.mock('./db', () => ({ listConnections }))
vi.mock('@/lib/db/prisma', () => ({ prisma: { $queryRaw: queryRaw } }))

const { clashMessage, mailboxClashes } = await import('./reply-catcher-guard')

const connection = {
  id: 'conn1',
  label: 'iCloud',
  imapHost: 'imap.mail.me.com',
  imapUsername: 'owner@icloud.com',
}

beforeEach(() => {
  installedModuleNames.mockReset().mockResolvedValue(new Set(['contact-form-reply-catcher']))
  existingTables.mockReset().mockResolvedValue(new Set(['rc_mailbox_config']))
  listConnections.mockReset().mockResolvedValue([connection])
  queryRaw.mockReset().mockResolvedValue([
    { provider: 'imap', imap_host: 'imap.mail.me.com', imap_username: 'owner@icloud.com' },
  ])
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('mailboxClashes', () => {
  it('finds the account both of them are watching', async () => {
    expect(await mailboxClashes()).toEqual([
      {
        connectionId: 'conn1',
        connectionLabel: 'iCloud',
        host: 'imap.mail.me.com',
        username: 'owner@icloud.com',
      },
    ])
  })

  it('does not care how the host and the username were typed', async () => {
    queryRaw.mockResolvedValue([
      { provider: 'imap', imap_host: 'IMAP.Mail.Me.Com', imap_username: ' Owner@iCloud.com ' },
    ])
    expect(await mailboxClashes()).toHaveLength(1)
  })

  it('leaves a different mailbox alone', async () => {
    queryRaw.mockResolvedValue([
      { provider: 'imap', imap_host: 'imap.mail.me.com', imap_username: 'somebody-else@icloud.com' },
    ])
    expect(await mailboxClashes()).toEqual([])
  })

  it('asks nothing further when that module is not installed', async () => {
    installedModuleNames.mockResolvedValue(new Set(['shop']))
    expect(await mailboxClashes()).toEqual([])
    expect(existingTables).not.toHaveBeenCalled()
    expect(queryRaw).not.toHaveBeenCalled()
  })

  it('copes with the module being installed a build before its tables', async () => {
    existingTables.mockResolvedValue(new Set())
    expect(await mailboxClashes()).toEqual([])
    expect(queryRaw).not.toHaveBeenCalled()
  })

  it('ignores the kind of account this hub cannot be pointed at anyway', async () => {
    queryRaw.mockResolvedValue([
      { provider: 'outlook_oauth', imap_host: 'imap.mail.me.com', imap_username: 'owner@icloud.com' },
    ])
    expect(await mailboxClashes()).toEqual([])
  })

  it('fails open when it cannot read', async () => {
    queryRaw.mockRejectedValue(new Error('relation does not exist'))
    expect(await mailboxClashes()).toEqual([])
  })
})

describe('what the owner is told', () => {
  it('names the account, names the mailbox and says what to do', async () => {
    const [clash] = await mailboxClashes()
    const message = clashMessage(clash!)
    expect(message).toContain('iCloud')
    expect(message).toContain('owner@icloud.com')
    expect(message).toContain('Remove Reply Catcher')
    // Plain English for somebody who does not build websites.
    expect(message).not.toMatch(/IMAP|UID|poller|provider/i)
  })
})
