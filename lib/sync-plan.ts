import type { MailFolder } from './imap'

// ---------------------------------------------------------------------------
// The arithmetic of a sync, with no mail server and no database anywhere near
// it: which folders to read, which UIDs are actually new, how much of the clock
// is left, and when a mailbox has to be re-seeded from scratch.
//
// It lives on its own because every one of these decisions is a way to lose
// mail quietly. Reading only INBOX loses everything the owner files from their
// phone between two ticks. Trusting an IMAP range loses nothing but re-files
// the newest message on every single poll, for ever. Missing a UIDVALIDITY
// change duplicates an entire mailbox. None of that shows up in a type check.
// ---------------------------------------------------------------------------

/** Folders we never read. Junk is where spam lives and reading it would mint a
 *  conversation, and eventually a person, out of every piece of it. Drafts are
 *  half-written and Trash is deleted - filing either as a real message would be
 *  telling the owner something untrue about their own mailbox. */
const NEVER_SYNC: Array<MailFolder['role']> = ['junk', 'trash', 'drafts']

export type FolderPlan = {
  path: string
  /** What we expect to find there. Sent mail is ours; everything else is theirs
   *  until the addresses say otherwise. */
  kind: 'inbox' | 'sent' | 'archive' | 'other'
}

/**
 * Which folders this account is read from (E2).
 *
 * INBOX alone is the single most likely way this module loses real customer
 * mail: an email that arrives and is archived from a phone between two hourly
 * ticks is never in INBOX when we look. So the archive is read too, and the
 * Sent folder, so mail the owner sends from their phone appears in the thread
 * rather than leaving a conversation that reads as though they never replied.
 *
 * Anything the owner nominates by name is read as well, and anything an inbox
 * has been pointed at explicitly. Folders that do not exist on the server are
 * dropped rather than failing the whole run.
 */
export function planFolders(input: {
  available: MailFolder[]
  /** extra_folders from the connection, plus each inbox's own folder settings. */
  requested: Array<string | null | undefined>
}): FolderPlan[] {
  const byPath = new Map(input.available.map((f) => [f.path.toLowerCase(), f]))
  const out: FolderPlan[] = []
  const seen = new Set<string>()

  function add(folder: MailFolder | undefined, kind: FolderPlan['kind']) {
    if (!folder) return
    if (NEVER_SYNC.includes(folder.role)) return
    const key = folder.path.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ path: folder.path, kind })
  }

  add(input.available.find((f) => f.role === 'inbox') ?? byPath.get('inbox'), 'inbox')
  for (const folder of input.available.filter((f) => f.role === 'sent')) add(folder, 'sent')
  for (const folder of input.available.filter((f) => f.role === 'archive')) add(folder, 'archive')

  for (const requested of input.requested) {
    if (!requested) continue
    const folder = byPath.get(requested.trim().toLowerCase())
    if (!folder) continue
    add(folder, folder.role === 'sent' ? 'sent' : folder.role === 'inbox' ? 'inbox' : 'other')
  }

  return out
}

export type SyncCursor = {
  uidvalidity: number | null
  lastSeenUid: number
  backfillCursorUid: number | null
  backfillComplete: boolean
}

/**
 * UIDVALIDITY is the server saying "forget every UID you hold for this folder".
 * Carrying the old cursors across a change would either skip the whole mailbox
 * or, worse, re-file all of it under UIDs that now mean different messages. The
 * dedupe on Message-ID saves us from duplicates either way, but the cursors are
 * meaningless and have to go.
 */
export function applyUidValidity(cursor: SyncCursor, serverUidValidity: number): {
  cursor: SyncCursor
  reset: boolean
} {
  if (cursor.uidvalidity !== null && cursor.uidvalidity === serverUidValidity) {
    return { cursor, reset: false }
  }
  const reset = cursor.uidvalidity !== null && cursor.uidvalidity !== serverUidValidity
  return {
    cursor: {
      uidvalidity: serverUidValidity,
      lastSeenUid: reset ? 0 : cursor.lastSeenUid,
      backfillCursorUid: reset ? null : cursor.backfillCursorUid,
      backfillComplete: reset ? false : cursor.backfillComplete,
    },
    reset,
  }
}

/** The IMAP range for the forward pass: everything newer than the cursor. */
export function forwardRange(lastSeenUid: number): string {
  return `${Math.max(0, lastSeenUid) + 1}:*`
}

/**
 * Which of the UIDs the server handed back are genuinely new.
 *
 * `n:*` is a closed range and `*` is the highest UID in the folder, so when
 * nothing new has arrived the server returns the newest message again, every
 * time. Reply Catcher filed that message on every poll until somebody noticed.
 * Two guards, deliberately overlapping: anything not strictly above the cursor
 * goes, and anything the ledger has already recorded at that location goes too.
 */
export function filterNewUids(
  fetched: number[],
  lastSeenUid: number,
  alreadyProcessed: Set<number>,
): number[] {
  return fetched
    .filter((uid) => uid > lastSeenUid)
    .filter((uid) => !alreadyProcessed.has(uid))
    .sort((a, b) => a - b)
}

/**
 * The downward walk through a mailbox's history (D6). One bounded batch a tick,
 * oldest-ward, until either the backfill window or UID 1 is reached - a mailbox
 * with years in it takes many ticks and that is fine, as long as progress only
 * ever moves in one direction.
 */
export function backfillRange(cursor: SyncCursor, batchSize: number): {
  from: number
  to: number
} | null {
  if (cursor.backfillComplete) return null
  const top = cursor.backfillCursorUid ?? cursor.lastSeenUid
  if (top <= 1) return null
  const to = top - 1
  const from = Math.max(1, to - batchSize + 1)
  return { from, to }
}

/** The oldest message worth collecting, from the owner's backfill setting. */
export function backfillFloor(months: number, now: Date = new Date()): Date {
  const floor = new Date(now.getTime())
  floor.setUTCMonth(floor.getUTCMonth() - Math.max(1, months))
  return floor
}

/**
 * The wall clock, checked between batches rather than inside one.
 *
 * The cron dispatcher gives any single job 25 seconds and moves on, so the
 * budget has to leave room to commit what has been collected and write the
 * cursor. A manual check runs in a module route with a 60 second ceiling and
 * gets a bigger slice, because somebody is sitting there watching it (E9).
 */
export const CRON_BUDGET_MS = 18_000
export const MANUAL_BUDGET_MS = 45_000
/** Messages fetched and parsed before the clock is looked at again. Sized so a
 *  batch of ordinary mail lands well inside the budget's slack. */
export const BATCH_SIZE = 15

/**
 * When the people pass has to stop, measured from the start of the whole run
 * rather than from when it began.
 *
 * Working out whose conversations these are runs AFTER the mail has been
 * collected and written, so it gets whatever is left of the slice: everything
 * before it is already committed, and stopping early costs nothing but a
 * conversation waiting one more tick for a name. Collecting the mail is the
 * part that must not be squeezed - a person can be worked out at any time, and
 * an email that was never fetched cannot.
 */
export const CRON_PEOPLE_DEADLINE_MS = 22_000
export const MANUAL_PEOPLE_DEADLINE_MS = 55_000

export function makeDeadline(budgetMs: number, now: number = Date.now()): number {
  return now + budgetMs
}

export function outOfTime(deadline: number, now: number = Date.now()): boolean {
  return now >= deadline
}
