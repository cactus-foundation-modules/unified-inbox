import { credentialsForConnection, openMailbox, listFolders, explainImapError } from './imap'
import { acquireConnectionLock, releaseConnectionLock } from './db'

// ---------------------------------------------------------------------------
// Copying a sent reply into the real Sent folder (D4).
//
// This is the first and only place this module writes to somebody's mailbox.
// Everything else it does to a mail account is read-only, which is a property
// worth keeping deliberately rather than by accident, so the write lives in its
// own file with its own guard rather than buried in the send path.
//
// The rule that matters: THIS CAN FAIL AND THE SEND STILL SUCCEEDED. By the
// time we get here Brevo has already accepted the message and the customer is
// receiving it. An APPEND that fails means one folder on the owner's phone is
// missing a copy - annoying, worth reporting, and absolutely not something to
// show a person as "your email did not send". Every path out of here returns a
// result; none of them throws.
//
// The other rule: it takes the same per-account lock the sync engine takes
// (E6). iCloud caps how many connections one account may hold open, and an
// APPEND racing an hourly tick is exactly the collision that cap exists for.
// ---------------------------------------------------------------------------

export type AppendResult =
  | { ok: true; folder: string; uid: number | null }
  | { ok: false; reason: string }

/** How long to hold the account for. An APPEND is one round trip; if it has not
 *  finished inside this, something is wrong and the hourly tick should not be
 *  locked out behind it. */
const APPEND_LOCK_MS = 30_000

/**
 * Which folder the copy goes in.
 *
 * The inbox's own setting wins, because an owner who typed a folder name meant
 * it. Otherwise ask the server: SPECIAL-USE tells us which folder it considers
 * Sent, and the name fallback covers the servers that do not answer. Guessing
 * "Sent" and creating it when wrong would litter somebody's mailbox with a
 * folder their mail client does not show.
 */
export async function resolveSentFolder(
  client: Awaited<ReturnType<typeof openMailbox>>,
  configured: string | null,
): Promise<string | null> {
  if (configured?.trim()) return configured.trim()
  const folders = await listFolders(client)
  return folders.find((f) => f.role === 'sent')?.path ?? null
}

/**
 * Puts a copy of a message we have just sent into the account's Sent folder.
 *
 * Never throws. The email has gone; this is housekeeping on top of it.
 */
export async function appendToSent(input: {
  connectionId: string
  sentFolder: string | null
  raw: Buffer
  sentAt: Date
}): Promise<AppendResult> {
  const locked = await acquireConnectionLock(input.connectionId, APPEND_LOCK_MS)
  if (!locked) {
    return {
      ok: false,
      reason: 'The mail account was busy collecting messages, so the copy was not filed in Sent.',
    }
  }

  let client: Awaited<ReturnType<typeof openMailbox>> | null = null
  try {
    client = await openMailbox(await credentialsForConnection(input.connectionId))
    const folder = await resolveSentFolder(client, input.sentFolder)
    if (!folder) {
      return {
        ok: false,
        reason: 'That mail account does not appear to have a Sent folder, so the copy was not filed. Name one in the inbox settings if it is called something unusual.',
      }
    }

    // \Seen because we wrote it - a copy of our own reply showing as unread on
    // the owner's phone is a false alarm every single time.
    const result = await client.append(folder, input.raw, ['\\Seen'], input.sentAt)
    const uid = result && typeof result === 'object' && 'uid' in result ? Number(result.uid) : null

    return { ok: true, folder, uid: Number.isFinite(uid) ? uid : null }
  } catch (err) {
    return { ok: false, reason: explainImapError(err) }
  } finally {
    if (client) await client.logout().catch(() => {})
    await releaseConnectionLock(input.connectionId).catch(() => {})
  }
}
