import { z } from 'zod'
import { getInstalledManifests } from '@/lib/modules/live-status'
import { cacheAttachment, loadAttachmentBytes } from './attachments'
import { getSettings } from './db'
import { MAX_EAGER_BYTES_PER_MESSAGE, storableAs, storableTypesFrom, worthFetching } from './inbound-file-policy'
import {
  claimOffer,
  inboxMessageIdsToReoffer,
  loadOfferableMessage,
  recordHandlerLink,
  recordOffer,
  releaseClaim,
  settleUnofferable,
  storedAttachmentBytes,
  unofferedMessageIds,
  unstoredAttachments,
  type UnstoredAttachment,
} from './message-handlers-db'
import type {
  AttachmentFetchMode,
  HandlerNote,
  InboundMessageEvent,
  InboundMessageHandler,
  InboundMessageOutcome,
} from './types'

// ---------------------------------------------------------------------------
// `unified-inbox.message-received` - the inbox tells other modules that mail
// has arrived.
//
// The reason this seam exists: a supplier's proforma arrives as an email, and
// what to do with it is purchasing's business, not the inbox's. The inbox knows
// that mail arrived and nothing else does; the module that files paperwork knows
// about purchase orders and the inbox knows nothing about them. So the inbox
// announces, generically, and whoever is listening listens. It names no module.
//
// HANDLERS, not bare observers. Unlike `shop.order-paid`, a handler may answer:
// records the message is about (stored as automatic links, exactly like the
// ones the reference patterns find) and one line to show on the message.
// Nothing it returns is required.
//
// Four rules hold everywhere a message is offered from:
//
//   - A message is CLAIMED before its listeners run (claimOffer), so the
//     collecting pass, the hourly catch-up and the "offer again" button never
//     run them on one message at the same time.
//   - A handler gets five seconds. Past that its signal is aborted and it is
//     treated as having said nothing; work that takes longer (reading a PDF)
//     belongs on the handler's own cron, queued from its cheap inline check.
//   - A handler that throws is logged and the next one runs. Collecting the
//     post must never be failed or held up by a listener having a bad day.
//   - A message is offered once, and then stamped handled_at. The hourly
//     catch-up re-offers anything from the last three days never stamped, and
//     the "offer the last 14 days again" button re-offers regardless - so every
//     handler MUST be idempotent on messageId.
//
// Files are metadata only unless a handler asked for a kind of file, and then
// only files whose bytes prove them that kind are stored - see
// lib/inbound-file-policy.ts.
//
// On a site where nothing listens, every entry point below returns after one
// memoised read of the installed manifests and touches no row at all.
// ---------------------------------------------------------------------------

export const MESSAGE_RECEIVED_POINT = 'unified-inbox.message-received'

/** Each handler's allowance, per message. */
export const HANDLER_BUDGET_MS = 5_000

/** One file fetched from the mail server and stored, before the offer gives
 *  up on it and hands the listeners the message without it. */
export const FETCH_BUDGET_MS = 8_000

/**
 * The hourly catch-up's slice of the sync job, after everything else.
 *
 * Has to cover one file fetch AND one handler's turn with room to spare, or
 * the catch-up could never fetch a file at all - a fetch is only started when
 * both still fit (see offerMessage). It is also capped against the start of the
 * run (CRON_CATCH_UP_CEILING_MS in lib/sync-plan.ts, 48 seconds), because the
 * passes before it can between them run to about 48 on a bad hour; then it
 * gets less than this, or nothing and runs next hour.
 */
export const CATCH_UP_BUDGET_MS = 16_000

/** How many never-to-be-offered rows the catch-up settles per run. */
const SETTLE_BATCH = 500

/** How many messages the hourly catch-up looks at in one go. */
const CATCH_UP_BATCH = 25

/** How many the button asks for per page while it walks a fortnight. */
const REOFFER_PAGE = 25

/** A note is one line. Anything longer is somebody's paragraph. */
const NOTE_MAX_CHARS = 200

/** A handler naming more records than this on one email is describing the
 *  catalogue, not the message. */
const MAX_LINKS_PER_HANDLER = 10

/** Confidence given to a handler's link: the same as a reference the owning
 *  module has confirmed, because that is what it is. */
const HANDLER_LINK_CONFIDENCE = 90

export type MessageHandlerEntry = {
  moduleName: string
  /** The extension point entry's id, unique within its module. */
  id: string
  /** `<module>:<id>` - what the handler's note is stored and replaced by. */
  source: string
  handle: InboundMessageHandler
  /** The kinds of file this handler asked to have stored as mail arrives,
   *  already cut down to the storable ones (lib/inbound-file-policy.ts). */
  attachmentTypes: string[]
}

type ExtensionPointEntry = { point: string; id: string }

/**
 * What a module registers: the handler itself, or - when it wants files in
 * hand - `{ handle, attachmentTypes }`.
 *
 * Declared on the export rather than on the manifest entry because core keeps
 * a parsed manifest, and a field its schema does not know is dropped before
 * any module could read it.
 */
function readRegistration(value: unknown): { handle: InboundMessageHandler; attachmentTypes: string[] } | null {
  if (typeof value === 'function') return { handle: value as InboundMessageHandler, attachmentTypes: [] }
  if (value && typeof value === 'object' && typeof (value as { handle?: unknown }).handle === 'function') {
    const registered = value as { handle: InboundMessageHandler; attachmentTypes?: unknown }
    return { handle: registered.handle, attachmentTypes: storableTypesFrom(registered.attachmentTypes) }
  }
  return null
}

/**
 * Every kind of file some handler asked for, which is what is stored as mail
 * arrives and fetched for the catch-up. Nothing when none asked, and nothing
 * when the site has said attachments are never to be fetched.
 */
export function storableTypesFor(
  handlers: MessageHandlerEntry[],
  attachmentFetch: AttachmentFetchMode,
): ReadonlySet<string> {
  if (attachmentFetch === 'never') return new Set()
  return new Set(handlers.flatMap((h) => h.attachmentTypes))
}

/**
 * Every handler registered against the point, in manifest order.
 *
 * Read from the server registry, which keeps `serverOnly` entries: a handler
 * is database work and has no business in the map the public pages load.
 * Dynamic for the same reason lib/provider-registry.ts gives - the generated
 * registry imports this module's own screens, which reach back here, and a
 * static edge closes a cycle Turbopack can fail a build on.
 */
export async function gatherMessageHandlers(): Promise<MessageHandlerEntry[]> {
  const { moduleServerExtensionPointComponents } = await import('@/lib/modules/extension-points.server')
  const fns = moduleServerExtensionPointComponents[MESSAGE_RECEIVED_POINT] ?? {}
  if (Object.keys(fns).length === 0) return []

  const gathered: MessageHandlerEntry[] = []
  for (const mod of await getInstalledManifests()) {
    const manifest = mod.manifest as { name?: string; extensionPoints?: ExtensionPointEntry[] } | null
    if (!manifest?.extensionPoints || typeof manifest.name !== 'string') continue
    for (const entry of manifest.extensionPoints) {
      if (entry.point !== MESSAGE_RECEIVED_POINT) continue
      const registered = readRegistration(fns[entry.id])
      if (!registered) continue
      gathered.push({
        moduleName: manifest.name,
        id: entry.id,
        source: `${manifest.name}:${entry.id}`,
        ...registered,
      })
    }
  }
  return gathered
}

// What a handler hands back is another module's code talking, so it is
// checked like any other input from outside: a shape that does not fit is
// logged and ignored rather than half-stored.
const OutcomeSchema = z.object({
  links: z.array(z.object({
    moduleName: z.string().trim().min(1).max(100),
    recordType: z.string().trim().min(1).max(100),
    recordId: z.string().trim().min(1).max(200),
    label: z.string().trim().max(200),
  })).max(MAX_LINKS_PER_HANDLER).optional(),
  note: z.string().max(2_000).optional(),
})

export type HandlerRun = {
  entry: MessageHandlerEntry
  status: 'ok' | 'threw' | 'timed-out' | 'invalid'
  outcome: InboundMessageOutcome | null
}

/** One line, as a note is shown: whitespace folded, cut at the limit. Null for
 *  a note with nothing in it. */
export function tidyNote(note: string | undefined): string | null {
  if (typeof note !== 'string') return null
  const line = note.replace(/\s+/g, ' ').trim()
  if (!line) return null
  return line.length > NOTE_MAX_CHARS ? `${line.slice(0, NOTE_MAX_CHARS - 1).trimEnd()}…` : line
}

const TIMED_OUT = Symbol('timed-out')

/** One handler, inside its allowance. Never throws. */
async function runOne(
  entry: MessageHandlerEntry,
  event: InboundMessageEvent,
  budgetMs: number,
): Promise<HandlerRun> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(TIMED_OUT)
    }, budgetMs)
  })

  // A copy each, so one handler rearranging the attachments cannot change what
  // the next one is told.
  const work = Promise.resolve().then(() => entry.handle(structuredClone(event), { signal: controller.signal }))
  // A handler that is still going when its time runs out may fail later, with
  // nobody left waiting on it. That must not surface as an unhandled rejection.
  work.catch(() => {})

  try {
    const answer = await Promise.race([work, timeout])
    if (answer === TIMED_OUT) {
      console.warn(`[${MESSAGE_RECEIVED_POINT}] ${entry.source} ran out of time on message ${event.messageId}`)
      return { entry, status: 'timed-out', outcome: null }
    }
    if (answer === undefined || answer === null) return { entry, status: 'ok', outcome: null }
    const parsed = OutcomeSchema.safeParse(answer)
    if (!parsed.success) {
      console.warn(`[${MESSAGE_RECEIVED_POINT}] ${entry.source} answered in a shape the inbox does not understand; ignored`)
      return { entry, status: 'invalid', outcome: null }
    }
    return { entry, status: 'ok', outcome: parsed.data }
  } catch (err) {
    console.error(`[${MESSAGE_RECEIVED_POINT}] ${entry.source} failed on message ${event.messageId}`, err)
    return { entry, status: 'threw', outcome: null }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Offer one event to every handler, in order, each inside its allowance.
 *
 * Stops early - and says so with `complete: false` - only when the caller's
 * deadline would not leave the next handler its full allowance. Everything else
 * (a throw, a timeout, an answer in the wrong shape) is that handler's turn
 * taken, and the next one runs.
 */
export async function runHandlers(
  event: InboundMessageEvent,
  handlers: MessageHandlerEntry[],
  opts: { budgetMs?: number; deadline?: number; now?: () => number } = {},
): Promise<{ runs: HandlerRun[]; complete: boolean }> {
  const budgetMs = opts.budgetMs ?? HANDLER_BUDGET_MS
  const now = opts.now ?? Date.now
  const runs: HandlerRun[] = []
  for (const entry of handlers) {
    if (opts.deadline !== undefined && opts.deadline - now() < budgetMs) return { runs, complete: false }
    runs.push(await runOne(entry, event, budgetMs))
  }
  return { runs, complete: true }
}

/**
 * This run's notes folded into the ones an earlier offer left: a handler that
 * says something new replaces its own line, a handler that says nothing this
 * time leaves its old one alone, and nobody touches anybody else's.
 */
export function mergeNotes(existing: HandlerNote[], runs: HandlerRun[], at: Date): HandlerNote[] {
  const fresh = new Map<string, HandlerNote>()
  for (const run of runs) {
    const note = tidyNote(run.outcome?.note)
    if (!note) continue
    fresh.set(run.entry.source, {
      source: run.entry.source,
      moduleName: run.entry.moduleName,
      note,
      at: at.toISOString(),
    })
  }
  const kept = existing.filter((n) => !fresh.has(n.source))
  return [...kept, ...fresh.values()]
}

export type OfferResult =
  | 'no-handlers'
  | 'not-offerable'
  | 'already-offered'
  | 'in-progress'
  | 'deferred'
  | 'offered'
  | 'partly-offered'
  | 'failed'

const GAVE_UP = Symbol('gave-up')

/** Waits for work up to a limit, then stops waiting. The work is not stopped -
 *  there is no cancelling an IMAP fetch halfway - but a late failure is
 *  swallowed rather than surfacing as an unhandled rejection. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof GAVE_UP> {
  work.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<typeof GAVE_UP>((resolve) => { timer = setTimeout(() => resolve(GAVE_UP), ms) })
  try {
    return await Promise.race([work, limit])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Put the files a listener asked for into the media library, for a message
 * collected before anything listened for them. Each one is fetched without
 * storing, judged by its bytes (lib/inbound-file-policy.ts), and only then
 * stored, labelled with the kind its bytes prove.
 *
 * Every step is bounded, and a file that cannot be had in time is simply
 * left out: the message is offered with that file's mediaId null. A slow mail
 * server costs one file, never the offer. Returns whether anything was stored.
 *
 * Once one fetch has been given up on, no more are started for this message.
 * The abandoned fetch cannot be cancelled and is still talking to the mail
 * server, so starting the next would open a second connection to the same
 * account alongside it - and a server that slow for one file is not going to
 * be quicker for the next. The rest are offered as metadata alone.
 */
type WantedFiles = { rows: UnstoredAttachment[]; budgetLeft: number }

/** The files on a message still on the mail server that are worth fetching
 *  for what the listeners asked for, and what is left of its allowance. */
async function wantedFilesFor(messageId: string, wanted: ReadonlySet<string>): Promise<WantedFiles> {
  if (wanted.size === 0) return { rows: [], budgetLeft: 0 }
  const budgetLeft = MAX_EAGER_BYTES_PER_MESSAGE - await storedAttachmentBytes(messageId)
  const rows = (await unstoredAttachments(messageId)).filter((row) => worthFetching(row, wanted, budgetLeft))
  return { rows, budgetLeft }
}

async function storeWantedFiles(
  messageId: string,
  wanted: ReadonlySet<string>,
  pending: WantedFiles,
  roomFor: (ms: number) => boolean,
  fetchBudgetMs: number,
): Promise<{ stored: boolean; attempted: boolean; outOfRoom: boolean }> {
  let budgetLeft = pending.budgetLeft
  let stored = false
  let attempted = false
  for (const row of pending.rows) {
    if (row.sizeBytes !== null && row.sizeBytes > budgetLeft) continue
    // Out of time is not the same as out of patience. A slow server is given
    // up on below and the message offered without the file; a run that simply
    // has no time left hands the message back, whole, for the next run - one
    // that offered it now would stamp it and the file would never be fetched.
    if (!roomFor(fetchBudgetMs)) return { stored, attempted, outOfRoom: true }
    attempted = true
    const done = await within((async () => {
      const fetched = await loadAttachmentBytes(row.id, { cache: false })
      if (!fetched.ok) return 0
      const type = storableAs(fetched.buffer, wanted, budgetLeft)
      if (!type) return 0
      const kept = await cacheAttachment({ id: row.id, messageId, filename: fetched.filename }, fetched.buffer, type)
      // In the library, or it did not happen: bytes stored with no library row
      // are still offered as mediaId null and still counted as unstored, so
      // calling them progress would fetch them again every hour.
      return kept?.mediaId ? fetched.buffer.length : 0
    })(), fetchBudgetMs)
    if (done === GAVE_UP) {
      console.warn(`[${MESSAGE_RECEIVED_POINT}] a file on message ${messageId} took too long to fetch; offered without it and any after it`)
      break
    }
    if (done > 0) {
      budgetLeft -= done
      stored = true
    }
  }
  return { stored, attempted, outOfRoom: false }
}

/**
 * Offer one stored message to every handler, and keep what they said.
 *
 * The message is CLAIMED first (claimOffer), so no two callers ever run the
 * listeners on one message at the same time; 'in-progress' means somebody
 * else holds it. `force` is the button: offer it whether or not it has been
 * before. `fetchTypes` is what the catch-up and the button pass to have the
 * files listeners asked for fetched from the mail server first; the collecting
 * pass stored them from the bytes in hand and passes nothing.
 *
 * Never throws: a failure is logged, answered as 'failed', and the claim let
 * go so the catch-up can try again.
 */
export async function offerMessage(
  messageId: string,
  opts: {
    handlers?: MessageHandlerEntry[]
    deadline?: number
    force?: boolean
    fetchTypes?: ReadonlySet<string>
    budgetMs?: number
    /** Each file's allowance; FETCH_BUDGET_MS unless a test says otherwise. */
    fetchBudgetMs?: number
    /** The first message of a catch-up run or a button request. A message
     *  there is no time left to fetch a wanted file for is handed back
     *  ('deferred') to be offered whole next time - but at the head of a run,
     *  only when that cannot repeat for ever: when it never had room to try,
     *  or stored something this time (so next time has less to do). One that
     *  tried and got nothing - its files keep failing - is offered with what
     *  there is, or it would never be offered at all. */
    headOfRun?: boolean
  } = {},
): Promise<OfferResult> {
  let claimed = false
  try {
    const handlers = opts.handlers ?? await gatherMessageHandlers()
    if (handlers.length === 0) return 'no-handlers'
    const budgetMs = opts.budgetMs ?? HANDLER_BUDGET_MS
    const roomFor = (extra = 0) => opts.deadline === undefined || opts.deadline - Date.now() >= budgetMs + extra

    let message = await loadOfferableMessage(messageId)
    if (!message) return 'not-offerable'
    if (message.handledAt && !opts.force) return 'already-offered'
    if (!roomFor()) return 'deferred'

    // The files the listeners asked for that are still on the mail server.
    // A message with no sender address has no library folder to file a file
    // under (lib/attachment-filing.ts), so a fetched file would be stored with
    // no library row and still be handed over as mediaId null: not fetched.
    // Worked out before the claim, so a message there is no time to fetch for
    // is handed back without its attempt being counted against it. A message
    // with nothing to fetch needs only a handler's turn.
    const fetchBudgetMs = opts.fetchBudgetMs ?? FETCH_BUDGET_MS
    const fileable = message.event.fromAddress !== ''
    const pending = opts.fetchTypes && fileable
      ? await wantedFilesFor(messageId, opts.fetchTypes)
      : { rows: [], budgetLeft: 0 }
    if (pending.rows.length > 0 && !roomFor(fetchBudgetMs)) return 'deferred'

    if (!await claimOffer(messageId, opts.force === true)) return 'in-progress'
    claimed = true

    if (opts.fetchTypes && pending.rows.length > 0) {
      const files = await storeWantedFiles(messageId, opts.fetchTypes, pending, roomFor, fetchBudgetMs)
      const handBack = files.outOfRoom && (!opts.headOfRun || files.stored || !files.attempted)
      if (handBack) {
        // Whatever was stored stays stored, so the next run has less to do.
        await releaseClaim(messageId, { refund: true })
        claimed = false
        return 'deferred'
      }
      if (files.stored) message = await loadOfferableMessage(messageId) ?? message
    }

    const { runs, complete } = await runHandlers(message.event, handlers, { budgetMs, deadline: opts.deadline })

    for (const run of runs) {
      for (const link of run.outcome?.links ?? []) {
        try {
          await recordHandlerLink({
            threadId: message.event.threadId,
            moduleName: link.moduleName,
            recordType: link.recordType,
            recordId: link.recordId,
            label: link.label,
            confidence: HANDLER_LINK_CONFIDENCE,
          })
        } catch (err) {
          console.error(`[${MESSAGE_RECEIVED_POINT}] could not keep a link ${run.entry.source} asked for`, err)
        }
      }
    }

    // Stamped only when every handler had its turn. One that threw or ran out
    // of time HAD its turn - re-offering it every hour for three days would be
    // a retry loop nobody asked for; the button is there for that. A run the
    // deadline cut short did not, and the catch-up finishes it. Either way the
    // claim is let go here.
    await recordOffer(messageId, { notes: mergeNotes(message.notes, runs, new Date()), stamp: complete })
    claimed = false
    if (complete) return 'offered'
    return runs.length > 0 ? 'partly-offered' : 'deferred'
  } catch (err) {
    console.error(`[${MESSAGE_RECEIVED_POINT}] could not offer message ${messageId}`, err)
    if (claimed) await releaseClaim(messageId).catch(() => {})
    return 'failed'
  }
}

/**
 * The hourly safety net: offer anything from the last three days that was
 * never offered. Returns straight away, having read nothing, on a site where
 * nothing listens.
 */
export async function catchUpMessageHandlers(opts: { deadline: number }): Promise<{ offered: number; settled: number }> {
  const handlers = await gatherMessageHandlers()
  if (handlers.length === 0) return { offered: 0, settled: 0 }
  if (opts.deadline - Date.now() < HANDLER_BUDGET_MS) return { offered: 0, settled: 0 }

  // What will never be offered leaves the index first - see settleUnofferable.
  let settled = 0
  try {
    settled = await settleUnofferable(SETTLE_BATCH)
  } catch (err) {
    console.error(`[${MESSAGE_RECEIVED_POINT}] could not settle messages that will never be offered`, err)
  }

  const fetchTypes = storableTypesFor(handlers, (await getSettings()).attachmentFetch)
  let offered = 0
  let first = true
  for (const messageId of await unofferedMessageIds(CATCH_UP_BATCH)) {
    if (opts.deadline - Date.now() < HANDLER_BUDGET_MS) break
    // A message handed back for want of time keeps its place (its attempt is
    // refunded), so next hour it is at the head of the run - see headOfRun.
    const result = await offerMessage(messageId, {
      handlers, deadline: opts.deadline, fetchTypes, headOfRun: first,
    })
    first = false
    if (result === 'offered' || result === 'partly-offered') offered += 1
  }
  return { offered, settled }
}

/**
 * One slice of "offer the last 14 days again" for an inbox. Offers regardless
 * of what was offered before, and hands back where it got to: `next` is the
 * cursor for the following request - the last message it finished with - and
 * `done` says whether there is anything left.
 *
 * The two are separate on purpose. A message handed back on the very first
 * request leaves nothing finished, so `next` is null exactly as it is at the
 * start: null means "from the beginning", never "finished". Reading a null
 * cursor as the end once stopped a walk at its first message.
 */
export async function reofferInbox(
  inboxId: string,
  opts: { after: string | null; deadline: number },
): Promise<{ handlers: number; offered: number; next: string | null; done: boolean }> {
  const handlers = await gatherMessageHandlers()
  if (handlers.length === 0) return { handlers: 0, offered: 0, next: null, done: true }
  const fetchTypes = storableTypesFor(handlers, (await getSettings()).attachmentFetch)

  let offered = 0
  let cursor = opts.after
  for (;;) {
    const page = await inboxMessageIdsToReoffer(inboxId, cursor, REOFFER_PAGE)
    if (page.length === 0) return { handlers: handlers.length, offered, next: null, done: true }
    for (const messageId of page) {
      if (opts.deadline - Date.now() < HANDLER_BUDGET_MS) {
        return { handlers: handlers.length, offered, next: cursor, done: false }
      }
      const head = cursor === opts.after
      const result = await offerMessage(messageId, {
        handlers, deadline: opts.deadline, force: true, fetchTypes, headOfRun: head,
      })
      // Handed back for want of time to fetch its files: the next request
      // starts from it again. Safe even at the head of a request, because
      // headOfRun only hands a head back when it stored something this time
      // (a request always starts with room to try), so every retry has less
      // to do than the one before.
      if (result === 'deferred') return { handlers: handlers.length, offered, next: cursor, done: false }
      // Cut short by its handlers: handed back too - unless it is the first
      // this request tried, when handing it back would ask the same question
      // for ever. Handlers whose allowances add up to more than one request's
      // time get what turns there were, and the walk moves on.
      if (result === 'partly-offered' && !head) {
        return { handlers: handlers.length, offered, next: cursor, done: false }
      }
      // 'in-progress' is stepped over: somebody else is offering it right now,
      // which is the offer this walk was going to make.
      if (result === 'offered' || result === 'partly-offered') offered += 1
      cursor = messageId
    }
  }
}
