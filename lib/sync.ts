import type { ImapFlow } from 'imapflow'
import { prisma } from '@/lib/db/prisma'
import { simpleParser, type ParsedMail } from 'mailparser'
import { upsertAlert, clearAlert } from '@/lib/notifications/alerts'
import {
  internalSides,
  normaliseAddress,
  parseAddressList,
  placeMessage,
  shouldDiscardUnrouted,
  type RoutableInbox,
} from './addresses'
import {
  acquireConnectionLock,
  assignThreadIfUnassigned,
  candidateThreads,
  clearAuthFailures,
  createThread,
  findMessageByIdentity,
  findOutboundByMessageId,
  getConnection,
  getProcessedUids,
  getSettings,
  getSyncState,
  insertAttachment,
  insertMessage,
  listConnections,
  listInboxes,
  markLocationProcessed,
  recordAuthFailure,
  recordDeliveryEvent,
  recordConnectionSync,
  releaseConnectionLock,
  saveSyncState,
  attachLocation,
  recordRelayIdentity,
  unlocatedOutboundNear,
  threadsForMessageIds,
  threadsHoldingIdentity,
  touchThread,
  reopenOnReply,
  setThreadBlocked,
  holdScheduledDraftsFor,
  recordEvent,
  type StoredMessageRef,
} from './db'
import { blockedSenderSet, shouldJunkSender } from './blocked-senders'
import { ownPostAssignee, ownPostOwners } from './own-post'
import { prepareInboundHtml, htmlToText } from './html'
import { chooseRelayCopy, RELAY_COPY_WINDOW_MS } from './relay-copy'
import { readReadReceipt } from './receipts'
import { clashMessage, mailboxClashes } from './reply-catcher-guard'
import { credentialsForConnection, explainImapError, listFolders, openMailbox } from './imap'
import {
  BATCH_SIZE,
  applyUidValidity,
  backfillFloor,
  backfillRange,
  filterNewUids,
  folderOwnersFor,
  forwardRange,
  makeDeadline,
  outOfTime,
  planFolders,
  type FolderPlan,
  type SyncCursor,
} from './sync-plan'
import {
  buildSnippet,
  chooseThread,
  classifyAutomated,
  cleanMessageId,
  contentIdentity,
  internalPairKey,
  normaliseSubject,
  parseReferences,
  HEURISTIC_WINDOW_DAYS,
  type AutomatedKind,
  type ThreadMatch,
} from './threading'
import type { Inbox } from './types'
import { queueMessageWebhooks } from './webhooks'

// ---------------------------------------------------------------------------
// The engine. Reads mail, files it, and stops when the clock says so.
//
// Three properties matter more than anything else in here:
//
//   Resumable at any instruction. A bounded batch is fetched, filed and its
//   cursor written before the next one starts. The site's whole cron budget is
//   ONE tick of a shared dispatcher that gives any single job 25 seconds, so a
//   mailbox with years of history is collected over many ticks. Interrupt it
//   anywhere and the next tick carries on; nothing is collected twice and
//   nothing is skipped.
//
//   Message-ID is identity, folder and UID are only location. The same email
//   lives in INBOX and in Archive, the owner moves mail between folders from
//   their phone, and the copy of our own reply that lands in Sent is the reply
//   we already hold. All of that is one message, deduped on the header, with the
//   (connection, folder, uid) ledger doing nothing more than stopping us reading
//   the same spot twice.
//
//   Read only. Not a flag, not a move, not a delete. Writing to a mailbox
//   arrives with the send path, and only there.
// ---------------------------------------------------------------------------

export type FolderOutcome = {
  folder: string
  scanned: number
  stored: number
  duplicates: number
  /** Mail dropped unread rather than filed: post addressed to none of this
   *  site's addresses, on an account set to discard that. Counted apart from
   *  duplicates because it is a decision and a duplicate is housekeeping.
   *  Nothing is deleted - the mail stays on the server exactly where it landed.
   *
   *  Post from a blocked sender is NOT counted here and has not been since
   *  migration 044: it is collected and filed into the Spam folder like
   *  anything else, so it lands in `stored` with the rest of the post. */
  discarded: number
  backfillComplete: boolean
  error?: string
}

export type ConnectionOutcome = {
  connectionId: string
  label: string
  ok: boolean
  /** Why nothing ran, when nothing ran. */
  skipped?: 'locked' | 'no-password' | 'no-inboxes' | 'other-poller'
  folders: FolderOutcome[]
  stored: number
  error?: string
}

/** How long the lock is held for beyond the work itself, so a crashed run
 *  releases itself on the next tick rather than blocking the account for ever. */
const LOCK_SLACK_MS = 60_000

const AUTH_FAILURES_BEFORE_ALERT = 3

function authFailed(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return message.includes('invalid credentials')
    || message.includes('authenticationfailed')
    || message.includes('authentication failed')
    || message.includes('login failed')
    || message.includes('[authenticationfailed]')
}

export async function syncAllConnections(opts: { budgetMs: number }): Promise<ConnectionOutcome[]> {
  const deadline = makeDeadline(opts.budgetMs)
  const connections = await listConnections()
  const outcomes: ConnectionOutcome[] = []
  for (const connection of connections) {
    if (outOfTime(deadline)) break
    outcomes.push(await syncConnection(connection.id, { deadline }))
  }
  return outcomes
}

export async function syncConnection(
  connectionId: string,
  opts: { budgetMs?: number; deadline?: number }
): Promise<ConnectionOutcome> {
  const deadline = opts.deadline ?? makeDeadline(opts.budgetMs ?? 18_000)
  const connection = await getConnection(connectionId)
  if (!connection) {
    return { connectionId, label: 'Unknown', ok: false, folders: [], stored: 0, error: 'That mail account no longer exists.' }
  }
  if (!connection.hasPassword) {
    return { connectionId, label: connection.label, ok: false, skipped: 'no-password', folders: [], stored: 0,
      error: 'No password is saved for this mail account yet.' }
  }

  // Something else is already watching this mailbox. Collecting it as well
  // would file every email twice in two different places, so this account is
  // left alone until somebody resolves it - and is told, rather than left to
  // wonder why one address never collects anything.
  // Deliberately NOT written to the account's own last-checked stamp: that
  // stamp is what the Check now cooldown reads, and marking a blocked account
  // as "just checked" every tick would turn the button away for everybody. The
  // settings screen asks this same question directly and says so there.
  const clash = (await mailboxClashes()).find((c) => c.connectionId === connectionId)
  if (clash) {
    return {
      connectionId,
      label: connection.label,
      ok: false,
      skipped: 'other-poller',
      folders: [],
      stored: 0,
      error: clashMessage(clash),
    }
  }

  const holdMs = Math.max(0, deadline - Date.now()) + LOCK_SLACK_MS
  if (!await acquireConnectionLock(connectionId, holdMs)) {
    return { connectionId, label: connection.label, ok: true, skipped: 'locked', folders: [], stored: 0 }
  }

  const outcome: ConnectionOutcome = {
    connectionId,
    label: connection.label,
    ok: true,
    folders: [],
    stored: 0,
  }

  let client: ImapFlow | null = null
  try {
    try {
      client = await openMailbox(await credentialsForConnection(connectionId))
    } catch (err) {
      if (authFailed(err)) await raiseAuthAlert(connection.id, connection.label)
      throw err
    }
    await clearAuthFailures(connectionId)
    await clearAlert(authAlertKey(connectionId))

    const allInboxes = await listInboxes()
    const mine = allInboxes.filter((i) => i.connectionId === connectionId)
    if (mine.length === 0) {
      outcome.skipped = 'no-inboxes'
      await recordConnectionSync(connectionId, 'ok', null)
      return outcome
    }

    const available = await listFolders(client)
    const folders = planFolders({
      available,
      requested: [
        ...connection.extraFolders,
        ...mine.map((i) => i.imapFolder),
        ...mine.map((i) => i.sentFolder),
      ],
      foldersOnly: connection.foldersOnly,
    })

    const settings = await getSettings()
    const floor = backfillFloor(settings.backfillMonths)
    const routing = routableInboxes(allInboxes, mine)
    const folderOwners = folderOwnersFor(mine)
    const ownAddresses = new Set([
      ...mine.map((i) => normaliseAddress(i.address)),
      normaliseAddress(connection.imapUsername),
    ])
    // What the site itself sends as. Mail from that address arriving in a
    // mailbox is the site talking to its owner - an order confirmation, or the
    // "somebody filled in your contact form" notice - and not a customer (E25).
    const siteConfig = await prisma.siteConfig.findUnique({
      where: { id: 'singleton' },
      select: { emailFromAddress: true },
    })
    const siteSendingAddress = normaliseAddress(siteConfig?.emailFromAddress ?? '')
    // Read once per account rather than per folder or per message. A block
    // added halfway through a run takes effect on the next one, which is the
    // right trade: the alternative is a query for every email on every site,
    // for a list that is empty on nearly all of them.
    const blockedSenders = await blockedSenderSet()
    // Whose own post is whose, read once for the whole account rather than per
    // message - and not read at all on a site that has never made an individual
    // inbox, or has turned the rule off.
    const ownPost = settings.autoAssignOwnPost
      ? await ownPostOwners(allInboxes)
      : new Map<string, string>()

    for (const folder of folders) {
      if (outOfTime(deadline)) break
      const result = await syncFolder({
        client,
        connectionId,
        folder,
        deadline,
        floor,
        routing,
        folderInboxId: folderOwners.get(folder.path.toLowerCase()) ?? null,
        ownAddresses,
        discardUnrouted: connection.discardUnrouted,
        siteSendingAddress,
        blockedSenders,
        ownPostOwners: ownPost,
      })
      outcome.folders.push(result)
      outcome.stored += result.stored
    }

    await recordConnectionSync(connectionId, 'ok', null)
    return outcome
  } catch (err) {
    const message = explainImapError(err)
    outcome.ok = false
    outcome.error = message
    await recordConnectionSync(connectionId, 'error', message)
    return outcome
  } finally {
    if (client) await client.logout().catch(() => {})
    await releaseConnectionLock(connectionId)
  }
}

function authAlertKey(connectionId: string): string {
  return `unified-inbox:auth:${connectionId}`
}

/** A rotated or revoked app password stops collection dead, and settings is not
 *  a screen anybody visits daily. Raise it where the site already puts things
 *  that need attention (E10). */
async function raiseAuthAlert(connectionId: string, label: string): Promise<void> {
  const failures = await recordAuthFailure(connectionId)
  if (failures < AUTH_FAILURES_BEFORE_ALERT) return
  await upsertAlert({
    type: 'message',
    dedupeKey: authAlertKey(connectionId),
    title: `${label} will not let us in - your mail is not being collected`,
    link: '/config?tab=unified-inbox',
    actionLabel: 'Check the mail account',
    reasons: ['The password was not accepted the last few times we tried. If you changed it, or if it was an app password that has been revoked, put the new one in and it will pick up where it left off.'],
  })
}

function routableInboxes(all: Inbox[], mine: Inbox[]): RoutableInbox[] {
  // The catch-all can belong to another account: a site with one catch-all and
  // several mail accounts still wants unroutable mail to land somewhere.
  const catchAlls = all.filter((i) => i.isCatchAll && !mine.some((m) => m.id === i.id))
  return [...mine, ...catchAlls].map((i) => ({ id: i.id, address: i.address, isCatchAll: i.isCatchAll }))
}

/**
 * The site writing to its own owner (E25).
 *
 * A contact form enquiry emails the owner, so the same enquiry arrives twice:
 * once through the channel it came in on, and once as an ordinary email in the
 * inbox. The same is true of every order confirmation and purchase order the
 * site sends to an address it also collects. Left alone, every enquiry a site
 * receives is two unread enquiries and somebody answers the wrong one.
 *
 * Marked rather than dropped. It is still real mail and still belongs in the
 * conversation - it simply must not mark anything unread, and must not mint a
 * person called "your website".
 */
export function ownNotification(
  direction: 'in' | 'out',
  fromAddress: string | null,
  siteSendingAddress: string | null,
): AutomatedKind | null {
  if (direction !== 'in' || !fromAddress || !siteSendingAddress) return null
  return fromAddress === siteSendingAddress ? 'own-notification' : null
}

type FolderContext = {
  client: ImapFlow
  connectionId: string
  folder: FolderPlan
  deadline: number
  floor: Date
  routing: RoutableInbox[]
  /** The inbox that owns everything in this folder, when one has been told it
   *  does. Null for every folder that routes by address alone. */
  folderInboxId: string | null
  ownAddresses: Set<string>
  /** This account is set to drop mail addressed to none of the site's own
   *  addresses, rather than keep it out of the way in Unrouted. */
  discardUnrouted: boolean
  /** The address the site's own automatic mail goes out as, normalised. Empty
   *  when the site has not set one. */
  siteSendingAddress: string | null
  /** Every sender the site refuses, normalised. Read once for the whole run and
   *  asked in memory: a site that has blocked forty spammers is forty strings,
   *  and a query per message would be a query per message. */
  blockedSenders: ReadonlySet<string>
  /** Which address is whose own post, for the addresses that are anybody's:
   *  inbox id to the colleague it belongs to. Empty on a site with no
   *  individual inboxes, and empty when the setting is switched off, so the
   *  rule costs nothing at all where it does not apply. See lib/own-post.ts. */
  ownPostOwners: ReadonlyMap<string, string>
}

async function syncFolder(ctx: FolderContext): Promise<FolderOutcome> {
  const outcome: FolderOutcome = {
    folder: ctx.folder.path,
    scanned: 0,
    stored: 0,
    duplicates: 0,
    discarded: 0,
    backfillComplete: false,
  }

  let lock: { release: () => void } | null = null
  try {
    lock = await ctx.client.getMailboxLock(ctx.folder.path)
    const mailbox = ctx.client.mailbox
    if (!mailbox || typeof mailbox === 'boolean') throw new Error(`Could not open ${ctx.folder.path}.`)

    const stored = await getSyncState(ctx.connectionId, ctx.folder.path)
    const uidNext = Number(mailbox.uidNext ?? 1)
    const exists = Number(mailbox.exists ?? 0)

    let cursor: SyncCursor
    if (!stored) {
      // First sight of a folder. Seed the cursor at the top rather than reading
      // the whole mailbox forwards from UID 1: history is the backfill's job,
      // walking downwards a batch at a time, and it can be interrupted safely.
      // Reading it forwards would blow every tick's budget on the oldest mail
      // in the account while today's went unread.
      const top = Math.max(0, uidNext - 1)
      cursor = { uidvalidity: Number(mailbox.uidValidity ?? 0), lastSeenUid: top, backfillCursorUid: top + 1, backfillComplete: false }
      await saveSyncState(ctx.connectionId, ctx.folder.path, { ...cursor, totalEstimate: exists })
    } else {
      const applied = applyUidValidity(
        {
          uidvalidity: stored.uidvalidity,
          lastSeenUid: stored.lastSeenUid,
          backfillCursorUid: stored.backfillCursorUid,
          backfillComplete: stored.backfillComplete,
        },
        Number(mailbox.uidValidity ?? 0)
      )
      cursor = applied.cursor
      if (applied.reset) {
        // The server has renumbered the folder. Every UID we hold now means a
        // different message, so the cursors are worthless - re-seed and let the
        // Message-ID dedupe stop the re-read turning into duplicates. Loudly,
        // because a fudged UIDVALIDITY is how a mailbox gets filed twice.
        console.warn(`[unified-inbox] UIDVALIDITY changed on ${ctx.folder.path} - cursors reset, re-reading from the top`)
        cursor = { ...cursor, lastSeenUid: Math.max(0, uidNext - 1), backfillCursorUid: uidNext, backfillComplete: false }
      }
      await saveSyncState(ctx.connectionId, ctx.folder.path, { ...cursor, totalEstimate: exists })
    }

    let collected = stored?.collected ?? 0

    // ── forward pass: everything that has arrived since we last looked ──────
    const found = await ctx.client.search({ uid: forwardRange(cursor.lastSeenUid) }, { uid: true })
    const candidateUids = Array.isArray(found) ? found.map(Number) : []
    const alreadyProcessed = await getProcessedUids(ctx.connectionId, ctx.folder.path, candidateUids)
    let pending = filterNewUids(candidateUids, cursor.lastSeenUid, alreadyProcessed)

    while (pending.length > 0 && !outOfTime(ctx.deadline)) {
      const batch = pending.slice(0, BATCH_SIZE)
      pending = pending.slice(BATCH_SIZE)
      const results = await processBatch(ctx, batch, 'forward')
      outcome.scanned += results.scanned
      outcome.stored += results.stored
      outcome.duplicates += results.duplicates
      outcome.discarded += results.discarded
      collected += results.stored
      cursor = { ...cursor, lastSeenUid: Math.max(cursor.lastSeenUid, ...batch) }
      await saveSyncState(ctx.connectionId, ctx.folder.path, {
        lastSeenUid: cursor.lastSeenUid,
        collected,
        lastError: null,
      })
    }

    // ── backfill pass: history, downwards, a batch a tick (D6) ─────────────
    while (!cursor.backfillComplete && !outOfTime(ctx.deadline)) {
      const range = backfillRange(cursor, BATCH_SIZE)
      if (!range) {
        cursor = { ...cursor, backfillComplete: true }
        await saveSyncState(ctx.connectionId, ctx.folder.path, { backfillComplete: true })
        break
      }
      const uids = await ctx.client.search({ uid: `${range.from}:${range.to}` }, { uid: true })
      const list = (Array.isArray(uids) ? uids.map(Number) : []).sort((a, b) => b - a)
      const seen = await getProcessedUids(ctx.connectionId, ctx.folder.path, list)
      const batch = list.filter((uid) => !seen.has(uid))

      const results = batch.length > 0 ? await processBatch(ctx, batch, 'backfill') : { scanned: 0, stored: 0, duplicates: 0, discarded: 0, oldest: null as Date | null }
      outcome.scanned += results.scanned
      outcome.stored += results.stored
      outcome.duplicates += results.duplicates
      outcome.discarded += results.discarded
      collected += results.stored

      // Past the owner's backfill window, or out of mailbox: either way there
      // is nothing older worth having.
      const reachedFloor = results.oldest !== null && results.oldest < ctx.floor
      const complete = range.from <= 1 || reachedFloor
      cursor = { ...cursor, backfillCursorUid: range.from, backfillComplete: complete }
      await saveSyncState(ctx.connectionId, ctx.folder.path, {
        backfillCursorUid: range.from,
        backfillComplete: complete,
        collected,
        lastError: null,
      })
    }

    outcome.backfillComplete = cursor.backfillComplete
    return outcome
  } catch (err) {
    const message = explainImapError(err)
    outcome.error = message
    await saveSyncState(ctx.connectionId, ctx.folder.path, { lastError: message })
    return outcome
  } finally {
    if (lock) lock.release()
  }
}

type BatchResult = { scanned: number; stored: number; duplicates: number; discarded: number; oldest: Date | null }

/**
 * Which half of a sweep a batch belongs to.
 *
 * The forward pass is post that has arrived since we last looked; the backfill
 * is history, walked downwards. Everything else about filing a message is the
 * same either way, and one thing is not: a message on the forward pass whose
 * date sits behind the conversation it joins has genuinely just turned up and
 * has to say so, where the same shape on the backfill is simply the past being
 * read in order. See touchThread and migration 045.
 */
type SyncPass = 'forward' | 'backfill'

/**
 * Fetch a bounded batch of whole messages, then file them.
 *
 * The two halves are deliberately separate. ImapFlow cannot run a second
 * command while a fetch's response stream is still open on the same connection -
 * it deadlocks silently, with no error and no timeout - so the stream is drained
 * into memory first and everything else happens afterwards.
 */
async function processBatch(ctx: FolderContext, uids: number[], pass: SyncPass): Promise<BatchResult> {
  const result: BatchResult = { scanned: 0, stored: 0, duplicates: 0, discarded: 0, oldest: null }
  if (uids.length === 0) return result

  const sources: Array<{ uid: number; source: Buffer; size: number | null }> = []
  for await (const message of ctx.client.fetch(uids.join(','), { uid: true, source: true, size: true }, { uid: true })) {
    if (!message.source) continue
    sources.push({ uid: Number(message.uid), source: Buffer.from(message.source), size: message.size ?? null })
  }

  for (const entry of sources) {
    result.scanned++
    try {
      const filed = await fileMessage(ctx, entry, pass)
      if (filed.stored) result.stored++
      else if (filed.discarded) result.discarded++
      else result.duplicates++
      if (filed.sentAt && (!result.oldest || filed.sentAt < result.oldest)) result.oldest = filed.sentAt
    } catch (err) {
      // One unparseable message must not cost the batch. Record the location so
      // the next tick moves past it rather than jamming on it for ever.
      console.warn(`[unified-inbox] could not file ${ctx.folder.path}:${entry.uid}`, err)
      await markLocationProcessed({
        connectionId: ctx.connectionId,
        folder: ctx.folder.path,
        uid: entry.uid,
        messageIdHeader: null,
        threadId: null,
      })
    }
  }
  return result
}

function headerValue(parsed: ParsedMail, name: string): string | null {
  const value = parsed.headers.get(name)
  if (!value) return null
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(String).join(' ')
  if (typeof value === 'object' && 'value' in value) return String((value as { value: unknown }).value)
  return String(value)
}

/** Every part of an arriving message worth reading as a delivery report: the
 *  human-readable half, and the machine-readable one, which mail parsers hand
 *  back as an attachment because nothing can display it. */
function dispositionParts(parsed: ParsedMail): string[] {
  const parts: string[] = []
  if (parsed.text) parts.push(parsed.text)
  for (const attachment of parsed.attachments) {
    const type = (attachment.contentType || '').toLowerCase()
    if (!type.includes('disposition-notification') && !type.includes('message/')) continue
    // Report parts are tiny by definition. Anything large is somebody attaching
    // an email to an email, and is not what this is looking at.
    if (attachment.size > 64 * 1024) continue
    try {
      parts.push(Buffer.from(attachment.content).toString('utf8'))
    } catch {
      // A part that will not decode is not a receipt.
    }
  }
  return parts
}

function addressesFrom(parsed: ParsedMail, field: 'to' | 'cc'): string[] {
  const value = parsed[field]
  if (!value) return []
  const list = Array.isArray(value) ? value : [value]
  return list.flatMap((entry) => entry.value.map((v) => normaliseAddress(v.address ?? '')).filter(Boolean))
}

/**
 * The outbound row this delivered copy is, when a relay rewrote our Message-ID.
 *
 * Only ever asked about mail sent from one of this account's own addresses, and
 * only after the Message-ID has failed to place it. Claiming a row records the
 * relay's id on it, which both closes the row to any further claim and gives
 * threading the handle the rest of the world will quote back at us.
 */
async function matchRelayCopy(input: {
  fromAddress: string | null
  ownAddresses: Set<string>
  toAddresses: string[]
  ccAddresses: string[]
  subject: string | null
  sentAt: Date
  relayMessageId: string
}): Promise<StoredMessageRef | null> {
  if (!input.fromAddress || !input.ownAddresses.has(input.fromAddress)) return null

  const candidates = await unlocatedOutboundNear({
    fromAddress: input.fromAddress,
    sentAt: input.sentAt,
    windowMs: RELAY_COPY_WINDOW_MS,
  })
  const match = chooseRelayCopy(candidates, {
    toAddresses: input.toAddresses,
    ccAddresses: input.ccAddresses,
    subject: input.subject,
    sentAt: input.sentAt,
  })
  if (!match) return null

  await recordRelayIdentity(match.id, input.relayMessageId)
  return {
    id: match.id,
    threadId: match.threadId,
    messageIdHeader: match.messageIdHeader,
    imapFolder: null,
    imapUid: null,
  }
}

async function fileMessage(
  ctx: FolderContext,
  entry: { uid: number; source: Buffer; size: number | null },
  pass: SyncPass,
): Promise<{ stored: boolean; discarded?: boolean; sentAt: Date | null }> {
  const parsed = await simpleParser(entry.source)

  const fromAddress = parsed.from?.value?.[0]?.address
    ? normaliseAddress(parsed.from.value[0].address)
    : null
  const fromName = parsed.from?.value?.[0]?.name || null
  // Kept because answering From when the sender named a Reply-To writes to an
  // address nobody reads (E13). Stored raw-ish, normalised on the way out.
  const replyToAddress = parsed.replyTo?.value?.[0]?.address
    ? normaliseAddress(parsed.replyTo.value[0].address)
    : null
  const subject = parsed.subject ?? null
  const sentAt = parsed.date ?? new Date()
  const sizeBytes = entry.size ?? entry.source.length

  // Identity first: a message with no Message-ID of its own still needs one, or
  // every poll files it again.
  const identity = cleanMessageId(parsed.messageId)
    ?? contentIdentity({ sentAt, fromAddress, subject, sizeBytes })

  const to = addressesFrom(parsed, 'to')
  const cc = addressesFrom(parsed, 'cc')
  const deliveredTo = parseAddressList(headerValue(parsed, 'delivered-to') ?? headerValue(parsed, 'x-delivered-to'))
    .concat(parseAddressList(headerValue(parsed, 'envelope-to')))

  // Mail from one of our addresses to another is one email and two
  // conversations - the sender's and the recipient's - so that each of them can
  // mark it done, snooze it and answer it without reaching into somebody else's
  // tab. Empty for every ordinary customer email, which is filed once as it
  // always was.
  const sides = internalSides({ fromAddress, headers: { deliveredTo, to, cc }, inboxes: ctx.routing })
  const internal = sides.length > 1
  const internalKey = internal ? internalPairKey({ sentAt, fromAddress, subject }) : null

  const held = internal
    ? await threadsHoldingIdentity(ctx.connectionId, identity, internalKey)
    : null

  const existing = await findMessageByIdentity(ctx.connectionId, identity)
  if (existing && !internal) {
    // Already held - found in another folder, or moved between folders since we
    // last looked. Same message. Record the location so we do not read it again
    // and move on (E2, E3).
    await markLocationProcessed({
      connectionId: ctx.connectionId,
      folder: ctx.folder.path,
      uid: entry.uid,
      messageIdHeader: identity,
      threadId: existing.threadId,
    })
    return { stored: false, sentAt }
  }

  // Our own reply, coming back at us out of the Sent folder because the send
  // path appended it there. It is the message we already hold, not a discovery
  // (E11). Give it a location so its attachments can be fetched, and stop.
  //
  // Internal mail carries on past this rather than stopping: the outbound row
  // is the SENDER's side of it, and the colleague it was addressed to still has
  // no copy on their own conversation. The side already written is skipped
  // below, on the same ledger as every other side.
  const ours = (await findOutboundByMessageId(identity))
    // Or the same reply wearing a relay's Message-ID rather than the one we
    // wrote, which is what comes back whenever the sending service stamps its
    // own id over ours. Matched on who, to whom, about what and when instead.
    ?? (await matchRelayCopy({
      fromAddress,
      ownAddresses: ctx.ownAddresses,
      toAddresses: to,
      ccAddresses: cc,
      subject,
      sentAt,
      relayMessageId: identity,
    }))
  if (ours) {
    await attachLocation(ours.id, { connectionId: ctx.connectionId, folder: ctx.folder.path, uid: entry.uid })
    if (!internal) {
      await markLocationProcessed({
        connectionId: ctx.connectionId,
        folder: ctx.folder.path,
        uid: entry.uid,
        messageIdHeader: identity,
        threadId: ours.threadId,
      })
      return { stored: false, sentAt }
    }
    held?.add(ours.threadId)
  }

  // A read receipt, if that is what this is: the recipient's mail program
  // answering the question the send path asked in a header. It belongs on the
  // message it is about, not in the conversation as a message of its own -
  // "Read: your quote" sitting under our own reply looks for all the world like
  // the customer wrote back, and it says nothing.
  const receipt = readReadReceipt({
    contentType: headerValue(parsed, 'content-type'),
    parts: dispositionParts(parsed),
    inReplyTo: headerValue(parsed, 'in-reply-to'),
    references: parseReferences(headerValue(parsed, 'references')),
  })
  if (receipt) {
    const original = await findOutboundByMessageId(
      cleanMessageId(receipt.originalMessageId) ?? receipt.originalMessageId,
    )
    // Only swallowed when we can actually place it. A receipt for a message
    // this site never sent, or one the retention sweep has since removed, is
    // filed as an ordinary email rather than quietly dropped.
    if (original) {
      await recordDeliveryEvent(original.id, {
        kind: receipt.displayed ? 'receipt' : 'receipt_unread',
        occurredAt: sentAt,
        detail: receipt.detail,
        bounceKind: null,
        source: 'receipt',
      })
      await markLocationProcessed({
        connectionId: ctx.connectionId,
        folder: ctx.folder.path,
        uid: entry.uid,
        messageIdHeader: identity,
        threadId: original.threadId,
      })
      return { stored: false, sentAt }
    }
  }

  // Which way it faces and whose inbox it lands in, decided together because
  // the two answers disagree over colleague post - see placeMessage. A copy
  // found in a Sent folder is still outbound whoever it was addressed to: the
  // mail server is stating this account sent it, and a reply written on a phone
  // has to read as the owner talking or the conversation looks unanswered.
  const { direction, routing: routed } = placeMessage({
    inSentFolder: ctx.folder.kind === 'sent',
    fromAddress,
    ownAddresses: ctx.ownAddresses,
    headers: { deliveredTo, to, cc },
    inboxes: ctx.routing,
    folderInboxId: ctx.folderInboxId,
  })

  // Blocked, so it is filed straight into the bin.
  //
  // Worked out AFTER the outbound copy is claimed above and after placeMessage
  // has said which way this is facing, and both of those orderings matter. A
  // reply a colleague wrote on their phone comes back to us out of the Sent
  // folder of an account whose owner might well be on somebody's block list,
  // and binning that would quietly stop our own writing reaching the
  // conversations it belongs to.
  //
  // It is collected rather than left on the mail server, which is the change
  // migration 044 explains: a block that dropped the post silently left "did
  // they ever actually write?" with no answer anywhere on this site. So it is
  // filed like anything else and then stamped - out of every list, in the Spam
  // folder, marked done and left unread - and the whole of that difference is
  // carried on this one flag through the filing below.
  const junk = shouldJunkSender({ direction, fromAddress, blocked: ctx.blockedSenders })

  const automated = classifyAutomated({
    autoSubmitted: headerValue(parsed, 'auto-submitted'),
    precedence: headerValue(parsed, 'precedence'),
    contentType: headerValue(parsed, 'content-type'),
    fromAddress,
    returnPath: headerValue(parsed, 'return-path'),
    listId: headerValue(parsed, 'list-id'),
    subject,
  }) ?? ownNotification(direction, fromAddress, ctx.siteSendingAddress)

  const inReplyTo = cleanMessageId(headerValue(parsed, 'in-reply-to'))
  const references = parseReferences(headerValue(parsed, 'references'))
  const subjectNormalised = normaliseSubject(subject)
  const byMessageId = await threadsForMessageIds([inReplyTo, ...references].filter((id): id is string => !!id))

  const participants = [fromAddress, ...to, ...cc].filter((a): a is string => !!a)
  // Internal mail always asks for candidates: a header match on one side's
  // conversation says nothing about whether the other side has one yet.
  const needsHeuristic = internal || !inReplyTo || !byMessageId.has(inReplyTo)
  const candidates = needsHeuristic && subjectNormalised
    ? await candidateThreads(subjectNormalised, new Date(sentAt.getTime() - HEURISTIC_WINDOW_DAYS * 24 * 60 * 60 * 1000))
    : []

  const chooseFor = (inboxId: string | null, restrictToInbox: boolean): ThreadMatch => chooseThread({
    inReplyTo,
    references,
    byMessageId,
    subjectNormalised,
    participants,
    sentAt,
    inboxId,
    candidates,
    restrictToInbox,
  })

  const match = chooseFor(routed.inboxId, false)

  // Mail for nobody here, starting a conversation of its own. On an account
  // that carries the owner's own post beside the site's, that is their bank and
  // their doctor, and filing it puts a stranger's private business in the shop
  // database where the whole of the staff can read it.
  //
  // Only ever applied to mail that starts a NEW conversation. A third party
  // brought into a thread already held, or an address that appears in nothing
  // but a Bcc, routes nowhere as well, and dropping those would leave a
  // conversation that reads as though somebody stopped replying halfway
  // through. The location is recorded so the next pass walks past it rather
  // than parsing it again for ever.
  if (shouldDiscardUnrouted({ enabled: ctx.discardUnrouted, inboxId: routed.inboxId, threadId: match.threadId })) {
    await markLocationProcessed({
      connectionId: ctx.connectionId,
      folder: ctx.folder.path,
      uid: entry.uid,
      messageIdHeader: identity,
      threadId: null,
    })
    return { stored: false, discarded: true, sentAt }
  }

  const bodyHtml = prepareInboundHtml(parsed.html || null)
  const bodyText = parsed.text ?? (bodyHtml ? htmlToText(bodyHtml) : null)
  const snippet = buildSnippet(bodyText) || buildSnippet(bodyHtml ? htmlToText(bodyHtml) : null)

  const common = {
    connectionId: ctx.connectionId,
    messageIdHeader: identity,
    inReplyTo,
    references,
    fromName,
    fromAddress,
    replyTo: replyToAddress,
    toAddresses: to,
    ccAddresses: cc,
    subject,
    bodyText,
    bodyHtml,
    snippet: snippet || null,
    sentAt,
    hasAttachments: parsed.attachments.length > 0,
    sizeBytes,
    imapFolder: ctx.folder.path,
    imapUid: entry.uid,
    routedOn: routed.matchedOn,
    autoKind: automated,
  }

  /** Files one side of a message: its conversation, its row, its attachments.
   *  Returns the conversation it landed on, and the row it wrote - null when
   *  another tick won the race for it and the unique index turned this one
   *  away. */
  async function writeSide(input: {
    inboxId: string | null
    direction: 'in' | 'out'
    threadMatch: ThreadMatch
    internalKey: string | null
  }): Promise<{ threadId: string; messageId: string | null }> {
    const thread = input.threadMatch.threadId ?? await createThread({
      inboxId: input.inboxId,
      subject,
      subjectNormalised,
      preview: snippet || null,
      lastMessageAt: sentAt,
      lastDirection: input.direction,
      // Blocked post is unread whatever else it is. Everywhere else in this
      // file an out-of-office or a bounce leaves the flag alone, because the
      // mail system talking is not somebody writing - but the Spam folder's
      // count is how anybody knows the site turned something away at all, and a
      // silent folder is a folder nobody opens.
      unread: junk || (input.direction === 'in' && !automated),
      blocked: junk,
    })

    const written = await insertMessage({
      ...common,
      threadId: thread,
      direction: input.direction,
      threadMatch: input.threadMatch.matchedOn,
      internalKey: input.internalKey,
    })
    if (!written) return { threadId: thread, messageId: null }

    // Metadata only. The bytes stay on the mail server until somebody opens one -
    // pulling every attachment on the account through a 25 second cron slice is
    // not a plan, and D17 wants them fetched lazily anyway.
    for (const [index, attachment] of parsed.attachments.entries()) {
      await insertAttachment({
        messageId: written,
        filename: attachment.filename || `attachment-${index + 1}`,
        contentType: attachment.contentType || null,
        sizeBytes: attachment.size ?? null,
        imapPartId: String(index),
        // What the markup points at a signature logo or a pasted screenshot by.
        // mailparser hands back `cid` with the angle brackets already off it;
        // `contentId` is the raw header and keeps them. Either is matched on the
        // way out, so take the tidier one.
        contentId: attachment.cid || attachment.contentId || null,
      })
    }

    await touchThread(thread, {
      sentAt,
      direction: input.direction,
      preview: snippet || null,
      subject,
      subjectNormalised,
      // An out-of-office or a bounce is the mail system talking, not the person.
      // Marking the conversation unread for it lies about the state of the
      // relationship, which is exactly what E7 is about.
      markUnread: junk || (input.direction === 'in' && !automated),
      inboxId: input.inboxId,
      // Post filed into a watched folder by hand arrives dated behind the
      // conversation it belongs to, and the list would never move for it. The
      // backfill is excluded because there every message is behind by
      // definition - it is history, being read in order.
      arrivedNow: pass === 'forward',
    })

    // The stamp, and everything the stamp settles: in the bin for everybody,
    // done, unread. Here rather than only on createThread above because a
    // blocked sender writing into a conversation that already exists - a reply
    // on an old thread, a second message before the first tick finished - has
    // to land the same way as the first one did. Idempotent: the date is only
    // ever written once, so a nuisance who writes six times is one conversation
    // stamped with the day they first got through.
    if (junk) await setThreadBlocked(thread, true)

    // Somebody has written on it, so it goes back in Open - whether it was
    // asleep until Thursday or marked done a fortnight ago.
    //
    // Both directions count, and the second one is the reason this sits here
    // rather than behind `direction === 'in'`. A reply typed in this hub never
    // reaches this code at all - the send path already holds that row, and the
    // copy coming back out of Sent is turned away by findOutboundByMessageId
    // above. So an OUTBOUND message arriving here is one this hub did not send:
    // a colleague answering the customer from their phone or from Outlook. That
    // conversation is being dealt with by somebody, and hiding it is exactly
    // wrong.
    //
    // The mail system talking to itself is not somebody writing, so a bounce or
    // an out-of-office leaves it where it is - the same line E7 draws for the
    // unread flag, drawn once more. Which matters most on the done half: a
    // mailing list nobody has unsubscribed from should not drag a finished
    // conversation back into Open every week.
    //
    // And never for post the site refused. Waking a conversation the collecting
    // pass has just put in the bin would undo the line above it in the same
    // function, and the two would then race on every message a blocked sender
    // sent.
    if (!automated && !junk) {
      const was = await reopenOnReply(thread)
      if (was) await recordEvent(thread, null, 'woken', { was, direction: input.direction })
    }

    // They wrote first. Anything we had set to go out to this person is stood
    // down before it can ask a question they have just answered - the writing
    // is kept, the departure time is not, and this conversation says so.
    //
    // Inbound and not the mail system talking: an out-of-office is not somebody
    // writing back, and standing a quote down because a supplier is on holiday
    // is the opposite of helpful. An outbound copy found in Sent is us, and
    // holding our own messages against ourselves would stand down every
    // scheduled message the moment a colleague answered on their phone.
    //
    // And not for a blocked sender. Standing down a quote because somebody the
    // site refuses has written in is letting them reach into the business
    // through a door that is supposed to be shut.
    if (!automated && !junk && input.direction === 'in' && fromAddress) {
      const held = await holdScheduledDraftsFor(fromAddress, thread)
      if (held.length > 0) {
        await recordEvent(thread, null, 'held', { count: held.length, address: fromAddress })
      }
    }

    // Post at somebody's own address is theirs, so it arrives on their desk
    // rather than on the unassigned pile only they can see into.
    //
    // Automated mail counts, which is where this parts company with the two
    // blocks above. An out-of-office is not somebody writing back and must not
    // wake a conversation or mark it unread - but the bounce from a message
    // this colleague sent is still, unarguably, their post to deal with.
    //
    // Nobody is ever displaced: the check that the conversation is free happens
    // inside the UPDATE. Recorded against nobody in particular, because nobody
    // in particular did it.
    //
    // Refused post is nobody's to deal with, so it goes on nobody's desk. It is
    // already out of every list and in the bin; putting a colleague's name on it
    // would be the site handing somebody a job it has just decided not to have.
    const ownPost = junk ? null : ownPostAssignee(input.direction, input.inboxId, ctx.ownPostOwners)
    if (ownPost && await assignThreadIfUnassigned(thread, ownPost)) {
      await recordEvent(thread, null, 'assigned', { to: ownPost, automatic: true })
    }

    return { threadId: thread, messageId: written }
  }

  // Mail between two of our own addresses: one conversation per inbox, each
  // reading the way that inbox sees it. A side already filed - by an earlier
  // tick, by the copy in the other folder, or by the send path that wrote the
  // outbound row - is stepped over rather than written twice.
  if (internal) {
    const written: string[] = []
    let primaryThread: string | null = null
    for (const side of sides) {
      const sideMatch = chooseFor(side.inboxId, true)
      if (sideMatch.threadId && held?.has(sideMatch.threadId)) {
        primaryThread ??= sideMatch.threadId
        continue
      }
      const side_ = await writeSide({
        inboxId: side.inboxId,
        direction: side.direction,
        threadMatch: sideMatch,
        internalKey,
      })
      primaryThread ??= side_.threadId
      if (side_.messageId) written.push(side_.messageId)
    }

    await markLocationProcessed({
      connectionId: ctx.connectionId,
      folder: ctx.folder.path,
      uid: entry.uid,
      messageIdHeader: identity,
      threadId: primaryThread,
    })

    // Nothing is told about post the site refused. A webhook is this hub saying
    // "something has arrived that you may want to act on", and the site has
    // just decided the opposite about this one.
    if (!junk) for (const messageId of written) await queueMessageWebhooks(messageId)
    return { stored: written.length > 0, sentAt }
  }

  // Everything else: one address, one conversation, filed exactly as before.
  const { threadId, messageId } = await writeSide({
    inboxId: routed.inboxId,
    direction,
    threadMatch: match,
    internalKey: null,
  })

  await markLocationProcessed({
    connectionId: ctx.connectionId,
    folder: ctx.folder.path,
    uid: entry.uid,
    messageIdHeader: identity,
    threadId,
  })

  // Two ticks raced for the same message and the other one won. The unique
  // index did its job; the location is noted and there is nothing else to do.
  if (!messageId) return { stored: false, sentAt }

  // Last, and only once the message is safely filed and its location recorded:
  // note down anybody who asked to be told. Queueing only - the sending happens
  // on the tick, so a slow endpoint cannot cost this run its remaining slice.
  //
  // Nobody is told about post the site refused. A webhook says "something has
  // arrived that you may want to act on", and the site has just decided the
  // opposite about this one.
  if (!junk) await queueMessageWebhooks(messageId)

  return { stored: true, sentAt }
}
