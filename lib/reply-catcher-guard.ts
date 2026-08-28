import { prisma } from '@/lib/db/prisma'
import { existingTables, installedModuleNames } from './installed'
import { listConnections } from './db'

// Two things polling one mailbox.
//
// Reply Catcher does one job well: it watches the contact form owner's real
// mailbox and threads replies back into the contact form's inbox. This hub
// watches mailboxes too. Point them both at the same account and the same
// email is filed twice in two different places, each of them convinced it has
// the whole story - and there is no moment at which anybody is told, because
// both are behaving exactly as designed.
//
// So: if Reply Catcher is set up against the same host and username as one of
// this hub's mail accounts, that account is NOT collected, and the settings
// screen says so in plain English with what to do about it. Refusing to collect
// is the right way round. The other module was there first, it is the one
// filing replies into a screen somebody is already using, and mail left in a
// mailbox is not lost - mail filed twice in two systems is a mess somebody has
// to unpick by hand.
//
// Reads only, by raw SQL, and only when that module is actually installed with
// its tables in place. Nothing here imports a line of its code.

const RC_MODULE = 'contact-form-reply-catcher'
const RC_TABLE = 'rc_mailbox_config'

export type MailboxClash = {
  connectionId: string
  connectionLabel: string
  host: string
  username: string
}

function same(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

async function replyCatcherMailbox(): Promise<{ host: string; username: string } | null> {
  const installed = await installedModuleNames()
  if (!installed.has(RC_MODULE)) return null
  const tables = await existingTables([RC_TABLE])
  if (!tables.has(RC_TABLE)) return null

  const rows = await prisma.$queryRaw<Array<{ provider: string | null; imap_host: string | null; imap_username: string | null }>>`
    SELECT "provider", "imap_host", "imap_username"
      FROM "rc_mailbox_config"
     WHERE "id" = 'singleton'
     LIMIT 1
  `
  const row = rows[0]
  // Only the plain mailbox kind can clash with ours: the other kind reaches a
  // different service entirely, and this hub cannot be pointed at it.
  if (!row || row.provider !== 'imap' || !row.imap_host || !row.imap_username) return null
  return { host: row.imap_host, username: row.imap_username }
}

/**
 * Which of this hub's mail accounts another poller is already watching.
 *
 * Empty is the ordinary answer, and it is the cheap one: two cached questions
 * about whether that module is here at all, and nothing further if it is not.
 */
export async function mailboxClashes(): Promise<MailboxClash[]> {
  let mailbox: { host: string; username: string } | null = null
  try {
    mailbox = await replyCatcherMailbox()
  } catch (err) {
    // A guard that cannot read must not stop the mail: it fails open, and the
    // worst case is the state of affairs that existed before it was written.
    console.error('[unified-inbox] could not check for another mail poller:', err)
    return []
  }
  if (!mailbox) return []

  const connections = await listConnections()
  return connections
    .filter((c) => same(c.imapHost, mailbox!.host) && same(c.imapUsername, mailbox!.username))
    .map((c) => ({
      connectionId: c.id,
      connectionLabel: c.label,
      host: c.imapHost,
      username: c.imapUsername,
    }))
}

/** What the owner is told, in the words somebody who does not build websites
 *  would use. Kept here rather than in the screen so the settings page and the
 *  Check now button say the same thing. */
export function clashMessage(clash: MailboxClash): string {
  return (
    `${clash.connectionLabel} is not being checked, because Reply Catcher is watching the same mailbox ` +
    `(${clash.username}). Two things collecting one mailbox files every email twice, in two different places. ` +
    `Remove Reply Catcher, or point this account at a different mailbox, and checking starts again on its own.`
  )
}
