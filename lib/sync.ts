import type { ImapFlow } from 'imapflow'
import { simpleParser, type ParsedMail } from 'mailparser'
import { upsertAlert, clearAlert } from '@/lib/notifications/alerts'
import { normaliseAddress, parseAddressList, routeSentToInbox, routeToInbox, type RoutableInbox } from './addresses'
import {
  acquireConnectionLock,
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
  recordConnectionSync,
  releaseConnectionLock,
  saveSyncState,
  attachLocation,
  threadsForMessageIds,
  touchThread,
} from './db'
import { prepareInboundHtml, htmlToText } from './html'
import { credentialsForConnection, explainImapError, listFolders, openMailbox } from './imap'
import {
  BATCH_SIZE,
  applyUidValidity,
  backfillFloor,
  backfillRange,
  filterNewUids,
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
  normaliseSubject,
  parseReferences,
  HEURISTIC_WINDOW_DAYS,
} from './threading'
import type { Inbox } from './types'

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
  backfillComplete: boolean
  error?: string
}

export type ConnectionOutcome = {
  connectionId: string
  label: string
  ok: boolean
  /** Why nothing ran, when nothing ran. */
  skipped?: 'locked' | 'no-password' | 'no-inboxes'
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
    })

    const settings = await getSettings()
    const floor = backfillFloor(settings.backfillMonths)
    const routing = routableInboxes(allInboxes, mine)
    const ownAddresses = new Set([
      ...mine.map((i) => normaliseAddress(i.address)),
      normaliseAddress(connection.imapUsername),
    ])

    for (const folder of folders) {
      if (outOfTime(deadline)) break
      const result = await syncFolder({
        client,
        connectionId,
        folder,
        deadline,
        floor,
        routing,
        ownAddresses,
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

type FolderContext = {
  client: ImapFlow
  connectionId: string
  folder: FolderPlan
  deadline: number
  floor: Date
  routing: RoutableInbox[]
  ownAddresses: Set<string>
}

async function syncFolder(ctx: FolderContext): Promise<FolderOutcome> {
  const outcome: FolderOutcome = {
    folder: ctx.folder.path,
    scanned: 0,
    stored: 0,
    duplicates: 0,
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
      const results = await processBatch(ctx, batch)
      outcome.scanned += results.scanned
      outcome.stored += results.stored
      outcome.duplicates += results.duplicates
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

      const results = batch.length > 0 ? await processBatch(ctx, batch) : { scanned: 0, stored: 0, duplicates: 0, oldest: null as Date | null }
      outcome.scanned += results.scanned
      outcome.stored += results.stored
      outcome.duplicates += results.duplicates
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

type BatchResult = { scanned: number; stored: number; duplicates: number; oldest: Date | null }

/**
 * Fetch a bounded batch of whole messages, then file them.
 *
 * The two halves are deliberately separate. ImapFlow cannot run a second
 * command while a fetch's response stream is still open on the same connection -
 * it deadlocks silently, with no error and no timeout - so the stream is drained
 * into memory first and everything else happens afterwards.
 */
async function processBatch(ctx: FolderContext, uids: number[]): Promise<BatchResult> {
  const result: BatchResult = { scanned: 0, stored: 0, duplicates: 0, oldest: null }
  if (uids.length === 0) return result

  const sources: Array<{ uid: number; source: Buffer; size: number | null }> = []
  for await (const message of ctx.client.fetch(uids.join(','), { uid: true, source: true, size: true }, { uid: true })) {
    if (!message.source) continue
    sources.push({ uid: Number(message.uid), source: Buffer.from(message.source), size: message.size ?? null })
  }

  for (const entry of sources) {
    result.scanned++
    try {
      const filed = await fileMessage(ctx, entry)
      if (filed.stored) result.stored++
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

function addressesFrom(parsed: ParsedMail, field: 'to' | 'cc'): string[] {
  const value = parsed[field]
  if (!value) return []
  const list = Array.isArray(value) ? value : [value]
  return list.flatMap((entry) => entry.value.map((v) => normaliseAddress(v.address ?? '')).filter(Boolean))
}

async function fileMessage(
  ctx: FolderContext,
  entry: { uid: number; source: Buffer; size: number | null }
): Promise<{ stored: boolean; sentAt: Date | null }> {
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

  const existing = await findMessageByIdentity(ctx.connectionId, identity)
  if (existing) {
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
  const ours = await findOutboundByMessageId(identity)
  if (ours) {
    await attachLocation(ours.id, { connectionId: ctx.connectionId, folder: ctx.folder.path, uid: entry.uid })
    await markLocationProcessed({
      connectionId: ctx.connectionId,
      folder: ctx.folder.path,
      uid: entry.uid,
      messageIdHeader: identity,
      threadId: ours.threadId,
    })
    return { stored: false, sentAt }
  }

  const to = addressesFrom(parsed, 'to')
  const cc = addressesFrom(parsed, 'cc')
  const deliveredTo = parseAddressList(headerValue(parsed, 'delivered-to') ?? headerValue(parsed, 'x-delivered-to'))
    .concat(parseAddressList(headerValue(parsed, 'envelope-to')))

  // Sent by us, or sitting in the Sent folder: either way it is outbound, and
  // it appears in the thread as something the owner said rather than something
  // the customer did. This is what stops a conversation reading as though
  // nobody ever replied when the reply was written on a phone.
  const direction: 'in' | 'out' = ctx.folder.kind === 'sent' || (fromAddress !== null && ctx.ownAddresses.has(fromAddress))
    ? 'out'
    : 'in'

  const routed = direction === 'out'
    ? routeSentToInbox(fromAddress ? [fromAddress] : [], { deliveredTo, to, cc }, ctx.routing)
    : routeToInbox({ deliveredTo, to, cc }, ctx.routing)

  const automated = classifyAutomated({
    autoSubmitted: headerValue(parsed, 'auto-submitted'),
    precedence: headerValue(parsed, 'precedence'),
    contentType: headerValue(parsed, 'content-type'),
    fromAddress,
    returnPath: headerValue(parsed, 'return-path'),
    listId: headerValue(parsed, 'list-id'),
    subject,
  })

  const inReplyTo = cleanMessageId(headerValue(parsed, 'in-reply-to'))
  const references = parseReferences(headerValue(parsed, 'references'))
  const subjectNormalised = normaliseSubject(subject)
  const byMessageId = await threadsForMessageIds([inReplyTo, ...references].filter((id): id is string => !!id))

  const participants = [fromAddress, ...to, ...cc].filter((a): a is string => !!a)
  const needsHeuristic = !inReplyTo || !byMessageId.has(inReplyTo)
  const candidates = needsHeuristic && subjectNormalised
    ? await candidateThreads(subjectNormalised, new Date(sentAt.getTime() - HEURISTIC_WINDOW_DAYS * 24 * 60 * 60 * 1000))
    : []

  const match = chooseThread({
    inReplyTo,
    references,
    byMessageId,
    subjectNormalised,
    participants,
    sentAt,
    inboxId: routed.inboxId,
    candidates,
  })

  const bodyHtml = prepareInboundHtml(parsed.html || null)
  const bodyText = parsed.text ?? (bodyHtml ? htmlToText(bodyHtml) : null)
  const snippet = buildSnippet(bodyText) || buildSnippet(bodyHtml ? htmlToText(bodyHtml) : null)

  const threadId = match.threadId ?? await createThread({
    inboxId: routed.inboxId,
    subject,
    subjectNormalised,
    preview: snippet || null,
    lastMessageAt: sentAt,
    lastDirection: direction,
    unread: direction === 'in' && !automated,
  })

  const messageId = await insertMessage({
    threadId,
    connectionId: ctx.connectionId,
    direction,
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
    threadMatch: match.matchedOn,
    routedOn: routed.matchedOn,
    autoKind: automated,
  })

  if (!messageId) {
    // Two ticks raced for the same message and the other one won. The unique
    // index did its job; nothing to do but note the location.
    await markLocationProcessed({
      connectionId: ctx.connectionId,
      folder: ctx.folder.path,
      uid: entry.uid,
      messageIdHeader: identity,
      threadId,
    })
    return { stored: false, sentAt }
  }

  // Metadata only. The bytes stay on the mail server until somebody opens one -
  // pulling every attachment on the account through a 25 second cron slice is
  // not a plan, and D17 wants them fetched lazily anyway.
  for (const [index, attachment] of parsed.attachments.entries()) {
    await insertAttachment({
      messageId,
      filename: attachment.filename || `attachment-${index + 1}`,
      contentType: attachment.contentType || null,
      sizeBytes: attachment.size ?? null,
      imapPartId: String(index),
    })
  }

  await touchThread(threadId, {
    sentAt,
    direction,
    preview: snippet || null,
    subject,
    subjectNormalised,
    // An out-of-office or a bounce is the mail system talking, not the person.
    // Marking the conversation unread for it lies about the state of the
    // relationship, which is exactly what E7 is about.
    markUnread: direction === 'in' && !automated,
    inboxId: routed.inboxId,
  })

  await markLocationProcessed({
    connectionId: ctx.connectionId,
    folder: ctx.folder.path,
    uid: entry.uid,
    messageIdHeader: identity,
    threadId,
  })

  return { stored: true, sentAt }
}
