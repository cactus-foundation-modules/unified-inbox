import type {
  ConversationMessage,
  ConversationSummary,
  ResolvedConversationProvider,
} from '@/lib/conversations/types'
import { queueMessageWebhooks } from './webhooks'
import {
  assignThreadIfUnassigned,
  claimLocalOutbound,
  getSettings,
  insertProviderMessage,
  listInboxes,
  markProviderContentRead,
  providerDeletionFloors,
  providerThreadState,
  providerWatermarks,
  recordEvent,
  recountProviderThread,
  reopenOnReply,
  upsertProviderThread,
} from './db'
import { blockedSenderSet } from './blocked-senders'
import { ownPostOwners } from './own-post'
import { allConversationProviders } from './provider-registry'
import { normaliseSubject } from './threading'

// Collecting the channels somebody else owns.
//
// Email is fetched from a mail server and is ours to keep. A chat, an enquiry,
// a call and a text are not: the module that owns them holds them, and this
// keeps a copy so they can be listed, searched, assigned and answered beside
// the email - one screen, one search box, one set of conversations.
//
// The copy is deliberately thin. It carries what a conversation IS - who, when,
// what was said - and nothing about what the owning module does with it. The
// far end stays the source of truth, and nothing in this file writes back to it.
//
// The budget rules are S3's, for S3's reason: this runs inside the site's cron
// dispatcher, which gives any one job about 25 seconds. So it is bounded at
// every level - how many conversations are asked for, how many are opened, how
// long the whole thing may take - and it commits as it goes. Interrupt it at
// any point and the next tick carries on, because the watermark it reads is the
// newest thing already stored rather than a cursor it has to remember.

/** How many conversations one provider is asked for per pass. */
export const PROVIDER_LIST_LIMIT = 40

/** How many of those are then opened to read their messages. Opening one is a
 *  second call into that module, which for the telephony one is a request over
 *  the network, so this is the number that actually costs. */
export const PROVIDER_THREAD_LIMIT = 25

/** How long the whole provider pass may take. Sits inside S3's collection
 *  budget, because mail is the part that must not be squeezed: a conversation
 *  from another module is still safely in that module and can be copied next
 *  tick, whereas an email that was never fetched is gone from the folder
 *  somebody has since tidied. */
export const PROVIDER_BUDGET_MS = 6_000

/** The first pass on a site that has been running for years must not try to
 *  copy the lot in one tick. With no watermark yet, only conversations touched
 *  in this window are collected, and the rest arrive as they are used. */
const FIRST_PASS_DAYS = 90

/**
 * How far back of already-collected ground each pass re-lists.
 *
 * A minute of it used to be enough, and only had to cover one thing: a
 * conversation touched in the same second as the last pass falling down the
 * gap between two ticks. It now has a second job. Some channels revise what
 * they have already said - the telephony one types up a voicemail minutes after
 * it was left - and a revision does not make the conversation newer, so asking
 * only for what has happened since the newest message would never fetch it.
 *
 * Half an hour comfortably covers a transcription. Re-listing is close to free:
 * a conversation that comes back with nothing changed fails no test and is
 * skipped without being opened, which is the expensive half.
 */
const REVISION_GRACE_MS = 30 * 60_000

export type ProviderOutcome = {
  /** The channel's key - the manifest entry id, which is what its conversations
   *  are stored under. Not the module name: one module may publish several
   *  channels, and the telephony one does. */
  channelKey: string
  /** Which module published it, for saying where a failure came from. */
  moduleName: string
  ok: boolean
  conversations: number
  messages: number
  error: string | null
}

const PREVIEW_CHARS = 200

function snippetOf(text: string | null): string | null {
  if (!text) return null
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat
}

/** A provider is another module's code running inside our pass, so anything it
 *  hands back is checked rather than trusted: a date that will not parse, an
 *  empty id or a channel nobody recognises must cost that conversation and not
 *  the tick. */
function usableSummary(summary: ConversationSummary): boolean {
  if (!summary || typeof summary.id !== 'string' || summary.id.trim() === '') return false
  const at = summary.lastMessageAt instanceof Date ? summary.lastMessageAt : new Date(summary.lastMessageAt)
  return !Number.isNaN(at.getTime())
}

const CHANNELS = new Set(['email', 'chat', 'form', 'phone', 'sms', 'whatsapp'])

function channelOf(value: string | undefined, fallback: string): string {
  return value && CHANNELS.has(value) ? value : CHANNELS.has(fallback) ? fallback : 'form'
}

function whenOf(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

/** Whether a conversation's own party is reachable by address or by number.
 *  Both are stored; which one is filled decides how the people layer will
 *  recognise them later. */
function partyOf(summary: ConversationSummary): { name: string | null; email: string | null; phone: string | null } {
  const p = summary.participant ?? { name: null, email: null, phone: null }
  return {
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : null,
    email: typeof p.email === 'string' && p.email.trim() ? p.email.trim().toLowerCase() : null,
    phone: typeof p.phone === 'string' && p.phone.trim() ? p.phone.trim() : null,
  }
}

function messageDirection(message: ConversationMessage): 'in' | 'out' | 'note' {
  return message.direction === 'out' || message.direction === 'note' ? message.direction : 'in'
}

/** When a conversation last changed, as its channel tells it. Another module's
 *  value, so an absent, unparseable or backwards one falls back to the newest
 *  message rather than being believed. */
function contentAtOf(summary: ConversationSummary, lastMessageAt: Date): Date {
  if (summary.contentAt === undefined || summary.contentAt === null) return lastMessageAt
  const at = whenOf(summary.contentAt)
  if (Number.isNaN(at.getTime())) return lastMessageAt
  return at.getTime() > lastMessageAt.getTime() ? at : lastMessageAt
}

/** What on the site a conversation came from, when its channel says. Trimmed
 *  and capped, because it is drawn on one line beside the subject and it is
 *  another module's string. */
const SOURCE_LABEL_CHARS = 80

function sourceLabelOf(summary: ConversationSummary): string | null {
  const label = typeof summary.sourceLabel === 'string' ? summary.sourceLabel.trim() : ''
  if (!label) return null
  return label.length > SOURCE_LABEL_CHARS ? `${label.slice(0, SOURCE_LABEL_CHARS - 1)}…` : label
}

/**
 * Which of our inboxes a conversation was addressed at, if any.
 *
 * The id comes back through core's message-destination seam, which is to say
 * from a page somebody edited weeks ago, and it is only OURS if it is still one
 * of this site's inboxes: another module may publish destinations of its own,
 * an inbox gets deleted, a backup gets restored. Anything we do not recognise
 * is treated as "addressed at nothing", which lands the conversation on its
 * channel exactly as it did before any of this existed.
 */
function addressedInbox(summary: ConversationSummary, ourInboxIds: Set<string>): string | null {
  const wanted = typeof summary.destinationId === 'string' ? summary.destinationId.trim() : ''
  if (!wanted) return null
  return ourInboxIds.has(wanted) ? wanted : null
}

/**
 * Copy across what one provider has, up to its share of the budget.
 *
 * Conversations are listed newest first and only opened when what they say has
 * happened is newer than what we already hold, so a quiet channel costs one
 * call and nothing else.
 */
export async function syncProvider(
  resolved: ResolvedConversationProvider,
  opts: { since?: Date; deadline?: number } = {},
): Promise<ProviderOutcome> {
  const { moduleName, id: channelKey, provider } = resolved
  const outcome: ProviderOutcome = {
    channelKey,
    moduleName,
    ok: true,
    conversations: 0,
    messages: 0,
    error: null,
  }
  const outOfTime = () => opts.deadline !== undefined && Date.now() >= opts.deadline

  let page
  try {
    page = await provider.list({ since: opts.since, limit: PROVIDER_LIST_LIMIT })
  } catch (err) {
    outcome.ok = false
    outcome.error = err instanceof Error ? err.message : 'That channel could not be read.'
    console.error(`[unified-inbox] could not read conversations from ${channelKey}:`, err)
    return outcome
  }

  const summaries = (page?.items ?? []).filter(usableSummary)
  let opened = 0

  // The site's front door, applied to the channels as well as to the post.
  //
  // An enquiry form is the obvious way round an email block: the same person,
  // the same address, arriving through a different door into the same inboxes.
  // "Blocked" has to mean blocked, so a conversation whose party writes from a
  // refused address is not collected at all - not opened, not filed, and not
  // counted. Nothing already here is touched; this only decides what comes in
  // from now on.
  //
  // Only where the channel actually knows an address. A live chat with an
  // anonymous visitor and a call from a withheld number have nobody to match
  // against, and refusing on a name would refuse the wrong people.
  //
  // Read once per channel per pass, for the same reason the mail side reads it
  // once per account: it is a handful of strings, and this is the hot loop.
  const blocked = await blockedSenderSet()

  // What this site has already thrown away on this channel.
  //
  // The owning module is the source of truth and never hears about a deletion
  // made in here - quite rightly, since emptying a bin on this site is a fact
  // about this site - so it offers the conversation again on the very next
  // pass, and without this it was copied straight back in. See migration 053.
  //
  // One read for the whole pass, for the ids actually on offer rather than the
  // table whole: the table only ever grows and a channel hands back forty
  // conversations at a time.
  const buried = await providerDeletionFloors(channelKey, summaries.map((summary) => summary.id))

  // One read for the whole pass, and only when a channel has actually addressed
  // something: on every site that has never pointed a form at an inbox this
  // costs nothing at all.
  const addressed = summaries.some((summary) => summary.destinationId)
  const ourInboxes = addressed ? await listInboxes() : []
  const ourInboxIds = new Set(ourInboxes.map((inbox) => inbox.id))
  // A channel pointed at one colleague's own address is that colleague's post,
  // exactly as an email addressed to it would be - so it is handed over the
  // same way. Nothing is read on a channel that addresses nothing, which is
  // every channel on a site that has not routed one.
  const ownPost = addressed && (await getSettings()).autoAssignOwnPost
    ? await ownPostOwners(ourInboxes)
    : new Map<string, string>()

  for (const summary of summaries) {
    if (outOfTime() || opened >= PROVIDER_THREAD_LIMIT) break

    const lastMessageAt = whenOf(summary.lastMessageAt)
    // When the conversation last CHANGED, which a channel that revises what it
    // has already said reports separately. Never earlier than its newest
    // message: a channel getting that backwards must not be able to convince us
    // we are caught up on something we are not.
    const contentAt = contentAtOf(summary, lastMessageAt)
    const channel = channelOf(summary.channel, provider.channel)
    const subject = typeof summary.subject === 'string' && summary.subject.trim() ? summary.subject.trim() : null

    // partyOf lower-cases and trims, which is the same normalisation the block
    // list is stored under - so this is a straight comparison rather than a
    // guess.
    const party = partyOf(summary)
    if (party.email && blocked.has(party.email)) continue

    // Thrown away here, and nothing has happened on it since. Not opened, not
    // filed, not counted - the bin's promise is that deleted stays deleted, and
    // a collection that quietly undoes it is the module lying to somebody about
    // their own screen.
    //
    // Strictly above the line lets it back, which is deliberate and is the
    // other half of the same decision: the far end never closed this
    // conversation, so a customer can carry on typing into a chat this site has
    // stopped listening to, and that failure is both worse and invisible from
    // in here. When they do write again the conversation comes back carrying
    // what they said and NOT the history that was destroyed - see the floor
    // applied to the messages below.
    const floor = buried.get(summary.id) ?? null
    if (floor && lastMessageAt.getTime() <= floor.getTime()) continue

    const existing = await providerThreadState(channelKey, summary.id)
    const inboxId = addressedInbox(summary, ourInboxIds)

    const { id: threadId } = await upsertProviderThread({
      providerModule: channelKey,
      externalId: summary.id,
      channel,
      subject,
      subjectNormalised: normaliseSubject(subject ?? ''),
      preview: snippetOf(summary.preview ?? null),
      lastMessageAt,
      lastDirection: 'in',
      unread: summary.unread === true,
      inboxId,
      sourceLabel: sourceLabelOf(summary),
    })
    outcome.conversations += 1

    // Only on the pass that first copies it across. A conversation this hub has
    // seen before has already been offered to its owner, and asking again every
    // quarter of an hour would be an UPDATE per conversation per tick for an
    // answer that cannot have changed.
    const owner = existing === null && inboxId ? ownPost.get(inboxId) : undefined
    if (owner && await assignThreadIfUnassigned(threadId, owner)) {
      await recordEvent(threadId, null, 'assigned', { to: owner, automatic: true })
    }

    // Opening a conversation is the expensive half - a second call into that
    // module, over the network for the telephony one. Skip it when we already
    // hold messages and nothing has happened since, which on a settled channel
    // is every conversation on the list.
    //
    // The second half is what catches a revision. A voicemail typed up after it
    // was filed has the same newest-message time it always had, so the first
    // three tests all pass and the words would never be fetched. A conversation
    // collected before any of this was recorded has no content watermark at
    // all, which counts as not caught up: it is read once more and then settles.
    const settled =
      existing !== null &&
      existing.messageCount > 0 &&
      existing.lastMessageAt !== null &&
      existing.lastMessageAt.getTime() >= lastMessageAt.getTime() &&
      existing.contentAt !== null &&
      existing.contentAt.getTime() >= contentAt.getTime()
    if (settled) continue

    const messages = await messagesFor(provider, summary.id, channelKey)
    if (messages === null) continue
    opened += 1

    // Recorded only now, and only because the messages are in hand. A pass that
    // gave up before opening this conversation must not leave behind a note
    // saying it had caught up with a revision it never read.
    await markProviderContentRead(channelKey, summary.id, contentAt)

    let stored = 0
    for (const message of messages) {
      if (!message || typeof message.id !== 'string' || message.id.trim() === '') continue
      const sentAt = whenOf(message.sentAt)
      if (Number.isNaN(sentAt.getTime())) continue
      // Below the line somebody drew when they threw this conversation away.
      // The channel still holds every word of it and hands the lot over on
      // request; filing them again would undo an emptied bin, and undo a
      // retention sweep months after it ran, on the first message a customer
      // happens to send.
      if (floor && sentAt.getTime() <= floor.getTime()) continue
      const direction = messageDirection(message)
      const text = typeof message.text === 'string' ? message.text : null

      // A reply somebody typed here went out through the owning module and was
      // written down at the time, carrying a placeholder id. This is that same
      // message coming back with the module's own id on it - one message, not
      // two, so the row we already have takes the real id and nothing is filed.
      if (
        direction === 'out' &&
        text &&
        (await claimLocalOutbound({
          threadId,
          bodyText: text,
          sentAt,
          providerMessageId: message.id,
        }))
      ) {
        continue
      }

      const id = await insertProviderMessage({
        threadId,
        providerModule: channelKey,
        providerMessageId: message.id,
        direction,
        channel,
        // The party's own details go on their messages, not on ours: the list
        // and the people layer both read the newest INBOUND message to find out
        // who a conversation is with.
        fromName: direction === 'in' ? (message.authorName ?? party.name) : (message.authorName ?? null),
        fromAddress: direction === 'in' ? party.email : null,
        fromPhone: direction === 'in' ? party.phone : null,
        subject,
        bodyText: text,
        bodyHtml: typeof message.html === 'string' && message.html.trim() ? message.html : null,
        snippet: snippetOf(text),
        sentAt,
        attachments: message.attachments?.map((att) => ({
          filename: att.filename,
          url: att.url,
          contentType: att.contentType ?? null,
        })),
      })
      if (id) {
        stored += 1
        await queueMessageWebhooks(id)
      }
    }

    if (stored > 0) {
      outcome.messages += stored
      await recountProviderThread(threadId)
      // Somebody has written on it since it was put away, so it comes back out.
      // A reply typed in this hub is claimed above and never counted here, so
      // anything left is the party, or a colleague answering them in the module
      // that owns the channel - either way the conversation is live again and
      // belongs in Open, whether it was snoozed or marked done.
      const was = await reopenOnReply(threadId)
      if (was) await recordEvent(threadId, null, 'woken', { was, providerModule: channelKey })
    }
  }

  return outcome
}

async function messagesFor(
  provider: ResolvedConversationProvider['provider'],
  id: string,
  channelKey: string,
): Promise<ConversationMessage[] | null> {
  try {
    const thread = await provider.thread(id)
    return thread?.messages ?? []
  } catch (err) {
    console.error(`[unified-inbox] could not read a conversation from ${channelKey}:`, err)
    return null
  }
}

/**
 * Every channel on the site, one pass each.
 *
 * One provider failing costs that channel and nothing else: a telephony account
 * with expired credentials must not stop the chat conversations arriving.
 */
export async function syncAllProviders(opts: { deadline?: number } = {}): Promise<ProviderOutcome[]> {
  const providers = await allConversationProviders()
  if (providers.length === 0) return []

  const watermarks = await providerWatermarks()
  const firstPassSince = new Date(Date.now() - FIRST_PASS_DAYS * 86_400_000)

  const outcomes: ProviderOutcome[] = []
  for (const resolved of providers) {
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) break
    outcomes.push(
      await syncProvider(resolved, {
        // The newest thing we hold from them, less the grace window - see
        // REVISION_GRACE_MS for what that is covering and why it is cheap.
        since: watermarks[resolved.id]
          ? new Date(watermarks[resolved.id]!.getTime() - REVISION_GRACE_MS)
          : firstPassSince,
        deadline: opts.deadline,
      }),
    )
  }
  return outcomes
}
