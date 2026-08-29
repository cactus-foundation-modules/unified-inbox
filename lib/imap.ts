import { ImapFlow } from 'imapflow'
import { decryptSecret } from '@/lib/crypto/secrets'
import { getConnection, getConnectionSecret } from './db'

// ---------------------------------------------------------------------------
// Opening a mailbox, and nothing else. The sync engine is S3's; this file
// exists so the settings screen can answer the only question an owner has while
// setting up: "did that work, and what are my folders called?"
//
// Nothing here ever writes to a mailbox. Not a flag, not a move, not a delete.
// ---------------------------------------------------------------------------

export type MailFolder = {
  /** The name to store: what IMAP calls it, delimiters and all. */
  path: string
  /** What it looks like in a mail app. */
  name: string
  /** '\\Sent', '\\Archive', '\\Junk' and friends, where the server says. */
  specialUse: string | null
  /** Our guess at what it is for, used to fill the folder boxes in. */
  role: 'inbox' | 'sent' | 'archive' | 'junk' | 'trash' | 'drafts' | null
}

const NAME_FALLBACKS: Array<[MailFolder['role'], string[]]> = [
  ['sent', ['Sent', 'Sent Items', 'Sent Mail', 'Sent Messages']],
  ['archive', ['Archive', 'All Mail', 'Archived']],
  ['junk', ['Junk', 'Spam', 'Bulk Mail']],
  ['trash', ['Trash', 'Deleted Items', 'Deleted Messages', 'Bin']],
  ['drafts', ['Drafts']],
]

const SPECIAL_USE_ROLES: Record<string, MailFolder['role']> = {
  '\\Sent': 'sent',
  '\\Archive': 'archive',
  '\\Junk': 'junk',
  '\\Trash': 'trash',
  '\\Drafts': 'drafts',
}

function roleFor(path: string, name: string, specialUse: string | null): MailFolder['role'] {
  if (path.toUpperCase() === 'INBOX') return 'inbox'
  if (specialUse && SPECIAL_USE_ROLES[specialUse]) return SPECIAL_USE_ROLES[specialUse]!
  for (const [role, names] of NAME_FALLBACKS) {
    if (names.some((n) => n.toLowerCase() === name.toLowerCase())) return role
  }
  return null
}

export type ImapCredentials = {
  host: string
  port: number
  username: string
  password: string
  tls: boolean
}

export async function openMailbox(credentials: ImapCredentials): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: credentials.host,
    port: credentials.port,
    secure: credentials.tls,
    auth: { user: credentials.username, pass: credentials.password },
    logger: false,
  })
  await client.connect()
  return client
}

/** The stored credentials for a saved connection, decrypted. Server only. */
export async function credentialsForConnection(connectionId: string): Promise<ImapCredentials> {
  const connection = await getConnection(connectionId)
  if (!connection) throw new Error('That mail account no longer exists.')
  const encrypted = await getConnectionSecret(connectionId)
  if (!encrypted) throw new Error('That mail account has no password saved yet.')
  return {
    host: connection.imapHost,
    port: connection.imapPort,
    username: connection.imapUsername,
    password: decryptSecret(encrypted),
    tls: connection.imapTls,
  }
}

/**
 * Folder discovery. Asks the server what it has, and works out which folder is
 * which from SPECIAL-USE where the server supports it and from the folder's own
 * name where it does not. iCloud answers with SPECIAL-USE; plenty of smaller
 * hosts do not, hence the fallback list.
 */
export async function listFolders(client: ImapFlow): Promise<MailFolder[]> {
  const list = await client.list()
  return list
    .filter((m) => !m.flags?.has('\\Noselect'))
    .map((m) => {
      const specialUse = m.specialUse ?? null
      return {
        path: m.path,
        name: m.name,
        specialUse,
        role: roleFor(m.path, m.name, specialUse),
      }
    })
}

/**
 * What the Test connection button runs. Never throws: an owner setting a
 * mailbox up wants a sentence about what went wrong, not a stack trace, and the
 * raw IMAP errors are unreadable ("Invalid credentials (Failure)").
 */
export async function testConnection(connectionId: string): Promise<
  { ok: true; folders: MailFolder[] } | { ok: false; error: string }
> {
  let client: ImapFlow | null = null
  try {
    client = await openMailbox(await credentialsForConnection(connectionId))
    const folders = await listFolders(client)
    return { ok: true, folders }
  } catch (err) {
    return { ok: false, error: explainImapError(err) }
  } finally {
    if (client) await client.logout().catch(() => {})
  }
}

/** Plain English for the handful of failures that actually happen. */
export function explainImapError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const lower = raw.toLowerCase()
  if (lower.includes('invalid credentials') || lower.includes('authenticationfailed') || lower.includes('login failed')) {
    return 'The username or password was not accepted. If this is an iCloud, Google or Outlook account you need an app-specific password rather than the one you log in with.'
  }
  if (lower.includes('enotfound') || lower.includes('eai_again') || lower.includes('getaddrinfo')) {
    return 'That server address could not be found. Check the host name for typos.'
  }
  if (lower.includes('econnrefused')) {
    return 'The server refused the connection. Check the port - it is almost always 993.'
  }
  if (lower.includes('timeout') || lower.includes('etimedout')) {
    return 'The server did not answer in time. It may be busy, or the host and port may not be right.'
  }
  if (lower.includes('certificate') || lower.includes('ssl') || lower.includes('tls')) {
    return 'The secure connection could not be established. Check the port and that the server supports SSL on it.'
  }
  // Everything else. Whatever the server actually said goes to the log, where
  // somebody who can act on it will see it, and never to the page: it is written
  // for whoever runs the mail server, and the person setting this up is not them.
  console.error('[unified-inbox] a mail server failure with no plain-English form:', raw)
  return 'Something went wrong talking to the mail server, and what it said back will not help you. Check the server address, the port, the username and the password, then try again.'
}
