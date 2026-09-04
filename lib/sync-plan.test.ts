import { describe, it, expect } from 'vitest'
import {
  applyUidValidity,
  backfillFloor,
  backfillRange,
  filterNewUids,
  folderOwnersFor,
  forwardRange,
  planFolders,
  outOfTime,
  makeDeadline,
  CRON_BUDGET_MS,
  CRON_TICK_DEADLINE_MS,
} from './sync-plan'
import { PROVIDER_BUDGET_MS } from './provider-sync'
import type { MailFolder } from './imap'

function folder(path: string, role: MailFolder['role']): MailFolder {
  return { path, name: path, specialUse: null, role }
}

const AVAILABLE: MailFolder[] = [
  folder('INBOX', 'inbox'),
  folder('Sent Messages', 'sent'),
  folder('Archive', 'archive'),
  folder('Junk', 'junk'),
  folder('Deleted Messages', 'trash'),
  folder('Drafts', 'drafts'),
  folder('Suppliers', null),
]

describe('planFolders', () => {
  it('reads the archive and the Sent folder, not just INBOX', () => {
    // E2, and the single most likely way this module loses real customer mail:
    // an email archived from a phone between two hourly ticks is not in INBOX
    // by the time anybody looks.
    const paths = planFolders({ available: AVAILABLE, requested: [] }).map((f) => f.path)
    expect(paths).toContain('INBOX')
    expect(paths).toContain('Sent Messages')
    expect(paths).toContain('Archive')
  })

  it('marks the Sent folder as ours, so what is found there reads as outbound', () => {
    const plan = planFolders({ available: AVAILABLE, requested: [] })
    expect(plan.find((f) => f.path === 'Sent Messages')?.kind).toBe('sent')
  })

  it('never reads junk, trash or drafts', () => {
    const paths = planFolders({ available: AVAILABLE, requested: ['Junk', 'Drafts'] }).map((f) => f.path)
    expect(paths).not.toContain('Junk')
    expect(paths).not.toContain('Deleted Messages')
    expect(paths).not.toContain('Drafts')
  })

  it('reads nothing but the nominated folders when the account is set to folders only', () => {
    // The account somebody already had: the shop's mail is filed into one
    // folder and INBOX is their own post. Reading INBOX there puts a bank and a
    // doctor in the site's database.
    const paths = planFolders({ available: AVAILABLE, requested: ['Suppliers'], foldersOnly: true }).map((f) => f.path)
    expect(paths).toEqual(['Suppliers'])
  })

  it('still marks a nominated Sent folder as ours when reading folders only', () => {
    const plan = planFolders({ available: AVAILABLE, requested: ['Sent Messages'], foldersOnly: true })
    expect(plan).toEqual([{ path: 'Sent Messages', kind: 'sent' }])
  })

  it('still refuses junk, trash and drafts when reading folders only', () => {
    const paths = planFolders({ available: AVAILABLE, requested: ['Junk', 'Drafts', 'Suppliers'], foldersOnly: true })
      .map((f) => f.path)
    expect(paths).toEqual(['Suppliers'])
  })

  it('reads everything as before when the account has not been told otherwise', () => {
    // Default false, so an install updating into the column behaves exactly as
    // it did the day before.
    const before = planFolders({ available: AVAILABLE, requested: ['Suppliers'] })
    expect(before).toEqual(planFolders({ available: AVAILABLE, requested: ['Suppliers'], foldersOnly: false }))
    expect(before.map((f) => f.path)).toContain('INBOX')
  })

  it('adds the folders the owner nominates', () => {
    const paths = planFolders({ available: AVAILABLE, requested: ['Suppliers'] }).map((f) => f.path)
    expect(paths).toContain('Suppliers')
  })

  it('ignores a nominated folder that is not on the server rather than failing the run', () => {
    const paths = planFolders({ available: AVAILABLE, requested: ['Nonexistent'] }).map((f) => f.path)
    expect(paths).not.toContain('Nonexistent')
    expect(paths).toContain('INBOX')
  })

  it('lists each folder once however many times it is asked for', () => {
    const paths = planFolders({ available: AVAILABLE, requested: ['INBOX', 'inbox', 'Archive'] }).map((f) => f.path)
    expect(paths.filter((p) => p === 'INBOX')).toHaveLength(1)
    expect(paths.filter((p) => p === 'Archive')).toHaveLength(1)
  })
})

describe('applyUidValidity', () => {
  const cursor = { uidvalidity: 100, lastSeenUid: 500, backfillCursorUid: 200, backfillComplete: false }

  it('leaves the cursors alone while the folder is the same folder', () => {
    const result = applyUidValidity(cursor, 100)
    expect(result.reset).toBe(false)
    expect(result.cursor.lastSeenUid).toBe(500)
  })

  it('throws every cursor away when the server renumbers the folder', () => {
    // Carrying a stale UID across a UIDVALIDITY change is how a whole mailbox
    // gets filed twice, or skipped entirely.
    const result = applyUidValidity(cursor, 101)
    expect(result.reset).toBe(true)
    expect(result.cursor.uidvalidity).toBe(101)
    expect(result.cursor.lastSeenUid).toBe(0)
    expect(result.cursor.backfillCursorUid).toBeNull()
    expect(result.cursor.backfillComplete).toBe(false)
  })

  it('adopts the server value on a folder never seen before, without calling it a reset', () => {
    const result = applyUidValidity({ uidvalidity: null, lastSeenUid: 0, backfillCursorUid: null, backfillComplete: false }, 42)
    expect(result.reset).toBe(false)
    expect(result.cursor.uidvalidity).toBe(42)
  })
})

describe('filterNewUids', () => {
  it('drops the newest message the server hands back every single time', () => {
    // `n:*` is a closed range and `*` is the highest UID in the folder, so with
    // nothing new to collect the server returns the newest message again. Reply
    // Catcher filed that message on every poll until somebody noticed; this is
    // the test that says we do not.
    expect(filterNewUids([120], 120, new Set())).toEqual([])
  })

  it('collects what is genuinely new', () => {
    expect(filterNewUids([120, 121, 122], 120, new Set())).toEqual([121, 122])
  })

  it('skips a location the ledger has already recorded', () => {
    expect(filterNewUids([121, 122], 120, new Set([121]))).toEqual([122])
  })

  it('returns them oldest first, so a cursor only ever moves forward', () => {
    expect(filterNewUids([125, 122, 130], 120, new Set())).toEqual([122, 125, 130])
  })

  it('is empty twice running once everything has been read', () => {
    const first = filterNewUids([120, 121], 119, new Set())
    expect(first).toEqual([120, 121])
    // Second tick: cursor has moved, ledger holds both.
    expect(filterNewUids([121], 121, new Set([120, 121]))).toEqual([])
  })
})

describe('forwardRange', () => {
  it('asks for everything above the cursor', () => {
    expect(forwardRange(120)).toBe('121:*')
  })

  it('starts at 1 on a folder with no cursor yet', () => {
    expect(forwardRange(0)).toBe('1:*')
  })
})

describe('backfillRange', () => {
  it('walks downwards a bounded batch at a time', () => {
    expect(backfillRange({ uidvalidity: 1, lastSeenUid: 500, backfillCursorUid: 500, backfillComplete: false }, 15))
      .toEqual({ from: 485, to: 499 })
  })

  it('never goes below UID 1', () => {
    expect(backfillRange({ uidvalidity: 1, lastSeenUid: 10, backfillCursorUid: 10, backfillComplete: false }, 50))
      .toEqual({ from: 1, to: 9 })
  })

  it('stops once there is nothing older left', () => {
    expect(backfillRange({ uidvalidity: 1, lastSeenUid: 1, backfillCursorUid: 1, backfillComplete: false }, 15)).toBeNull()
  })

  it('does nothing at all once the backfill is finished', () => {
    expect(backfillRange({ uidvalidity: 1, lastSeenUid: 500, backfillCursorUid: 300, backfillComplete: true }, 15)).toBeNull()
  })
})

describe('backfillFloor', () => {
  it('is the owner s window, counted back from today', () => {
    const floor = backfillFloor(12, new Date('2026-08-28T00:00:00.000Z'))
    expect(floor.toISOString().slice(0, 10)).toBe('2025-08-28')
  })
})

describe('the clock', () => {
  it('is out of time only once the budget has gone', () => {
    const deadline = makeDeadline(1_000, 0)
    expect(outOfTime(deadline, 500)).toBe(false)
    expect(outOfTime(deadline, 1_000)).toBe(true)
  })
})

// The dispatcher aborts any one job at 25 seconds. Each pass in the tick holds
// its own budget, but it takes that budget from the clock when it starts - so
// the numbers only add up if the later ones are capped against the run's own
// start as well.
describe('the tick fits inside the slice it is given', () => {
  it('leaves the channels no room past the abort, however long the mail took', () => {
    const started = 1_000_000
    const mailRanLong = started + CRON_BUDGET_MS
    const deadline = Math.min(mailRanLong + PROVIDER_BUDGET_MS, started + CRON_TICK_DEADLINE_MS)
    expect(deadline - started).toBeLessThanOrEqual(CRON_TICK_DEADLINE_MS)
    expect(CRON_TICK_DEADLINE_MS).toBeLessThan(25_000)
  })

  it('still gives the channels their whole budget when the mail was quick', () => {
    const started = 1_000_000
    const mailWasQuick = started + 2_000
    const deadline = Math.min(mailWasQuick + PROVIDER_BUDGET_MS, started + CRON_TICK_DEADLINE_MS)
    expect(deadline).toBe(mailWasQuick + PROVIDER_BUDGET_MS)
  })
})

describe('folderOwnersFor', () => {
  const owning = (id: string, imapFolder: string, folderOwnsMail = true) =>
    ({ id, imapFolder, folderOwnsMail })

  it('keys a claimed folder by its name in lower case', () => {
    expect(folderOwnersFor([owning('purchasing', 'Purchasing')]))
      .toEqual(new Map([['purchasing', 'purchasing']]))
  })

  it('ignores an inbox that has not claimed its folder', () => {
    expect(folderOwnersFor([owning('sales', 'INBOX', false)])).toEqual(new Map())
  })

  it('lets nobody own a folder two addresses have both claimed', () => {
    // Filing a customer's mail on a coin toss is worse than not filing it, so
    // the folder claims nothing and the addresses decide as they always did.
    const owners = folderOwnersFor([owning('a', 'Shared'), owning('b', 'shared')])
    expect(owners.get('shared')).toBeNull()
  })

  it('ignores a folder name that is nothing but spaces', () => {
    expect(folderOwnersFor([owning('blank', '   ')])).toEqual(new Map())
  })
})
