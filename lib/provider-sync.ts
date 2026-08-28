import type {
  ConversationMessage,
  ConversationSummary,
  ResolvedConversationProvider,
} from '@/lib/conversations/types'
import {
  claimLocalOutbound,
  insertProviderMessage,
  providerThreadState,
  providerWatermarks,
  recountProviderThread,
  upsertProviderThread,
} from './db'
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

export type ProviderOutcome = {
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

const CHANNELS = new Set(['email', 'chat', 'form', 'phone', 'sms'])

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
  const { moduleName, provider } = resolved
  const outcome: ProviderOutcome = {
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
    console.error(`[unified-inbox] could not read conversations from ${moduleName}:`, err)
    return outcome
  }

  const summaries = (page?.items ?? []).filter(usableSummary)
  let opened = 0

  for (const summary of summaries) {
    if (outOfTime() || opened >= PROVIDER_THREAD_LIMIT) break

    const lastMessageAt = whenOf(summary.lastMessageAt)
    const channel = channelOf(summary.channel, provider.channel)
    const subject = typeof summary.subject === 'string' && summary.subject.trim() ? summary.subject.trim() : null

    const existing = await providerThreadState(moduleName, summary.id)

    const { id: threadId } = await upsertProviderThread({
      providerModule: moduleName,
      externalId: summary.id,
      channel,
      subject,
      subjectNormalised: normaliseSubject(subject ?? ''),
      preview: snippetOf(summary.preview ?? null),
      lastMessageAt,
      lastDirection: 'in',
      unread: summary.unread === true,
    })
    outcome.conversations += 1

    // Opening a conversation is the expensive half - a second call into that
    // module, over the network for the telephony one. Skip it when we already
    // hold messages and nothing has happened since, which on a settled channel
    // is every conversation on the list.
    const settled =
      existing !== null &&
      existing.messageCount > 0 &&
      existing.lastMessageAt !== null &&
      existing.lastMessageAt.getTime() >= lastMessageAt.getTime()
    if (settled) continue

    const messages = await messagesFor(provider, summary.id, moduleName)
    if (messages === null) continue
    opened += 1

    const party = partyOf(summary)
    let stored = 0
    for (const message of messages) {
      if (!message || typeof message.id !== 'string' || message.id.trim() === '') continue
      const sentAt = whenOf(message.sentAt)
      if (Number.isNaN(sentAt.getTime())) continue
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
        providerModule: moduleName,
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
      })
      if (id) stored += 1
    }

    if (stored > 0) {
      outcome.messages += stored
      await recountProviderThread(threadId)
    }
  }

  return outcome
}

async function messagesFor(
  provider: ResolvedConversationProvider['provider'],
  id: string,
  moduleName: string,
): Promise<ConversationMessage[] | null> {
  try {
    const thread = await provider.thread(id)
    return thread?.messages ?? []
  } catch (err) {
    console.error(`[unified-inbox] could not read a conversation from ${moduleName}:`, err)
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
        // The newest thing we hold from them, less a minute of slack: a
        // conversation touched in the same second as the last pass would
        // otherwise fall down the gap between two ticks.
        since: watermarks[resolved.moduleName]
          ? new Date(watermarks[resolved.moduleName]!.getTime() - 60_000)
          : firstPassSince,
        deadline: opts.deadline,
      }),
    )
  }
  return outcomes
}
