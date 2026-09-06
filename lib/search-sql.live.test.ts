import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
// Type only, and the queries are imported inside beforeAll: the shared Prisma
// client is built the first time it is imported and reads DATABASE_URL as it
// goes.
import type { ExtendedPrismaClient } from '@/lib/db/prisma'
import {
  vpsConfigFromEnv,
  createTestRole,
  createTestDatabase,
  dropTestDatabase,
  dropTestRole,
  dropStaleTestObjects,
  type VpsConfig,
  type TestRole,
  type TestDatabase,
} from '@/lib/backup/vps-database'

// ---------------------------------------------------------------------------
// The search queries, executed.
//
// Every clause the search dialog can add is raw SQL, and nothing else in this
// repository runs it: tsc sees a template string, eslint sees a template
// string, and a build never executes a query. Four things here would sail
// through every other gate and be wrong in front of somebody hunting for an
// invoice.
//
// WILDCARDS IN WHAT SOMEBODY TYPED. A percent sign in a search box is a search
// for everything unless it is escaped, and an underscore quietly matches any
// character. Neither is what a person looking for "50% off" means, and both
// look perfectly fine until the day the results are nonsense.
//
// WHO IT WENT TO, INCLUDING THE COPIES. array_to_string over two arrays glued
// together is the sort of expression that either works or throws at the
// database, and no amount of typechecking says which.
//
// THE DATE RANGE. Compared against last_message_at, which is a timestamp, from
// a calendar date the panel turned into an instant in the site's own timezone.
// The half-open end - up to and including the day named - is off by a whole day
// if it is written the obvious way.
//
// E17. The visibility clause and the search clauses live in one WHERE, so a
// conversation in an inbox this reader cannot open is never fetched, never
// counted and never paged. That is the claim worth executing rather than
// reading.
//
// Skipped unless opted into, so a plain npm test never touches the network:
//
//   RUN_INBOX_SEARCH_SQL=1 npx vitest run \
//     modules/unified-inbox/lib/search-sql.live.test.ts --testTimeout 120000
//
// A SKIP HERE IS A FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_SEARCH_SQL === '1'
if (shouldRun) {
  try {
    ;(process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - the guard below fails the suite loudly rather than skipping.
  }
}

const CORE_SCHEMA = path.join(process.cwd(), 'prisma/migrations/20260626000000_init/migration.sql')
const MODULE_MIGRATIONS = path.join(process.cwd(), 'modules/unified-inbox/migrations')

const KEY = 'a'.repeat(64)

type Extension = (typeof import('@/lib/db/prisma'))['stalePlanRetryExtension']

async function connect(uri: string, extension: Extension): Promise<ExtendedPrismaClient> {
  const db = new PrismaClient({ datasourceUrl: uri }).$extends(extension)
  for (let attempt = 0; ; attempt++) {
    try {
      await db.$queryRawUnsafe('SELECT 1')
      return db
    } catch (err) {
      if (attempt >= 15) throw err
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

type Db = typeof import('./db')

describe.runIf(shouldRun)('the search queries, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let queries: Db
  let salesId: string
  let accountsId: string

  /** Everything the reader may see, for the calls below. Sales only: accounts@
   *  is the inbox nobody in these tests is on, which is what makes the last
   *  one worth running. */
  const visible = () => ({
    inboxIds: [salesId],
    includeUnrouted: false,
    status: 'all' as const,
    page: 1,
    perPage: 25,
  })

  const subjectsOf = async (extra: Record<string, unknown>): Promise<string[]> => {
    const rows = await queries.listThreads({ ...visible(), ...extra })
    return rows.map((r) => r.subject ?? '').sort()
  }

  beforeAll(async () => {
    if (!process.env.OVH_SERVER || !process.env.OVH_USER || !process.env.OVH_PASSWORD) {
      throw new Error(
        'OVH_SERVER, OVH_USER and OVH_PASSWORD are needed for this suite. '
        + 'Export them from the Deskwell workspace .env - a skip here is a fail.',
      )
    }
    vps = vpsConfigFromEnv()
    await dropStaleTestObjects(vps)

    const stamp = Date.now()
    role = await createTestRole(vps, `cactus_rt_role_${stamp}`)
    database = await createTestDatabase(vps, `cactus_rt_uinsearch_${stamp}`, role)
    process.env.DATABASE_URL = database.connectionUri
    process.env.ENCRYPTION_KEY = KEY

    const { stalePlanRetryExtension } = await import('@/lib/db/prisma')
    const { splitSqlStatements } = await import('@/lib/backup/restore')
    db = await connect(database.connectionUri, stalePlanRetryExtension)

    const applyFile = async (file: string) => {
      for (const statement of splitSqlStatements(readFileSync(file, 'utf8'))) {
        await db.$executeRawUnsafe(statement)
      }
    }
    await applyFile(CORE_SCHEMA)
    for (const file of readdirSync(MODULE_MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      await applyFile(path.join(MODULE_MIGRATIONS, file))
    }

    const inbox = async (name: string, address: string): Promise<string> => {
      const rows = await db.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO "uin_inboxes" ("name", "address") VALUES ($1, $2) RETURNING "id"`,
        name,
        address,
      )
      return rows[0]!.id
    }
    salesId = await inbox('Sales', 'sales@example.co.uk')
    accountsId = await inbox('Accounts', 'accounts@example.co.uk')

    queries = await import('./db')

    // Four conversations with deliberately different words in them. A fixture
    // where every body says the same thing makes a search term match half the
    // table, and Postgres then correctly ignores the search index - which reads
    // exactly like a missing one and is nothing of the kind.
    await seed({
      inboxId: salesId,
      subject: 'Invoice 4021 for the boardroom chairs',
      lastMessageAt: '2026-09-03T10:00:00Z',
      messages: [
        {
          direction: 'in',
          fromName: 'Sally Whitcombe',
          fromAddress: 'sally@supplier.example',
          to: ['sales@example.co.uk'],
          cc: ['accounts@example.co.uk'],
          subject: 'Invoice 4021 for the boardroom chairs',
          body: 'The invoice for twelve boardroom chairs is attached, payable in thirty days.',
          hasAttachments: true,
        },
      ],
    })
    await seed({
      inboxId: salesId,
      subject: 'Delivery slot for the reception desk',
      lastMessageAt: '2026-08-20T09:30:00Z',
      messages: [
        {
          direction: 'in',
          fromName: 'Marcus Lyle',
          fromAddress: 'marcus@builders.example',
          to: ['sales@example.co.uk'],
          cc: [],
          subject: 'Delivery slot for the reception desk',
          body: 'Can the reception desk arrive on a Tuesday morning rather than a Friday.',
          hasAttachments: false,
        },
      ],
    })
    await seed({
      inboxId: salesId,
      // The wildcard case, and a subject somebody would plausibly search for.
      subject: '50% off storage until Friday',
      lastMessageAt: '2026-07-01T08:00:00Z',
      messages: [
        {
          direction: 'out',
          fromName: 'Deskwell',
          fromAddress: 'sales@example.co.uk',
          to: ['everyone@customers.example'],
          cc: [],
          subject: '50% off storage until Friday',
          body: 'Half price pedestals and cupboards while stocks last.',
          hasAttachments: false,
        },
      ],
    })
    await seed({
      // The one this reader may not open. Carries the same words as the first
      // on purpose: a search that leaks would leak THIS row.
      inboxId: accountsId,
      subject: 'Invoice 4022 for the boardroom chairs',
      lastMessageAt: '2026-09-04T11:00:00Z',
      messages: [
        {
          direction: 'in',
          fromName: 'Sally Whitcombe',
          fromAddress: 'sally@supplier.example',
          to: ['accounts@example.co.uk'],
          cc: [],
          subject: 'Invoice 4022 for the boardroom chairs',
          body: 'A second invoice for boardroom chairs, this one for the accounts team.',
          hasAttachments: true,
        },
      ],
    })
  }, 600_000)

  async function seed(thread: {
    inboxId: string
    subject: string
    lastMessageAt: string
    messages: Array<{
      direction: string
      fromName: string
      fromAddress: string
      to: string[]
      cc: string[]
      subject: string
      body: string
      hasAttachments: boolean
    }>
  }): Promise<void> {
    const rows = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "uin_threads"
         ("inbox_id", "channel", "subject", "subject_normalised", "preview",
          "last_message_at", "last_direction", "unread", "message_count", "status")
       VALUES ($1, 'email', $2, lower($2), $2, $3::timestamp, 'in', true, $4, 'open')
       RETURNING "id"`,
      thread.inboxId,
      thread.subject,
      thread.lastMessageAt,
      thread.messages.length,
    )
    const threadId = rows[0]!.id
    for (const message of thread.messages) {
      await db.$executeRawUnsafe(
        `INSERT INTO "uin_messages"
           ("thread_id", "direction", "channel", "from_name", "from_address",
            "to_addresses", "cc_addresses", "subject", "body_text", "sent_at", "has_attachments")
         VALUES ($1, $2, 'email', $3, $4, $5::text[], $6::text[], $7, $8, $9::timestamp, $10)`,
        threadId,
        message.direction,
        message.fromName,
        message.fromAddress,
        message.to,
        message.cc,
        message.subject,
        message.body,
        thread.lastMessageAt,
        message.hasAttachments,
      )
    }
  }

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('finds the words, and never the conversation in an inbox this reader cannot open', async () => {
    const found = await subjectsOf({ search: 'boardroom chairs' })
    expect(found).toEqual(['Invoice 4021 for the boardroom chairs'])
    // The same claim, counted rather than listed: E17 is about what is fetched,
    // counted and paged, not only about what is drawn.
    expect(await queries.countThreads({ ...visible(), search: 'boardroom chairs' })).toBe(1)
  })

  it('matches who it came from on either the name or the address, on part of one', async () => {
    expect(await subjectsOf({ fromText: 'whitcombe' }))
      .toEqual(['Invoice 4021 for the boardroom chairs'])
    expect(await subjectsOf({ fromText: 'supplier.example' }))
      .toEqual(['Invoice 4021 for the boardroom chairs'])
    expect(await subjectsOf({ fromText: 'nobody@nowhere' })).toEqual([])
  })

  it('counts the copies as "went to", because that is what somebody means by it', async () => {
    // accounts@ was only ever copied in on this one, and is exactly the address
    // somebody would search for to find the invoices.
    expect(await subjectsOf({ toText: 'accounts@example.co.uk' }))
      .toEqual(['Invoice 4021 for the boardroom chairs'])
    expect(await subjectsOf({ toText: 'builders.example' })).toEqual([])
  })

  it('takes a wildcard in the search box literally', async () => {
    // Unescaped, this matches every row in the table and the results are
    // nonsense. Escaped, it finds the one message with a percent sign in it.
    expect(await subjectsOf({ subjectText: '50%' })).toEqual(['50% off storage until Friday'])
    expect(await subjectsOf({ subjectText: '%' })).toEqual(['50% off storage until Friday'])
    // The underscore, same story: it must be a character rather than "any
    // character", or "off_storage" would find the one that says "off storage".
    expect(await subjectsOf({ subjectText: 'off_storage' })).toEqual([])
  })

  it('matches a subject on the conversation as well as on its messages', async () => {
    expect(await subjectsOf({ subjectText: 'reception desk' }))
      .toEqual(['Delivery slot for the reception desk'])
  })

  it('finds the ones with something attached', async () => {
    expect(await subjectsOf({ withAttachment: true }))
      .toEqual(['Invoice 4021 for the boardroom chairs'])
  })

  it('narrows to a date range, with the far end taking in the whole of its day', async () => {
    // Everything since the 20th of August: two of the three this reader has.
    expect(await subjectsOf({ after: new Date('2026-08-20T00:00:00Z') })).toEqual([
      'Delivery slot for the reception desk',
      'Invoice 4021 for the boardroom chairs',
    ])
    // Up to and including the 3rd of September, which is the day the invoice
    // arrived: an end written as the first second of that day would drop it.
    expect(await subjectsOf({
      after: new Date('2026-09-01T00:00:00Z'),
      before: new Date('2026-09-04T00:00:00Z'),
    })).toEqual(['Invoice 4021 for the boardroom chairs'])
    expect(await subjectsOf({ before: new Date('2026-07-01T00:00:00Z') })).toEqual([])
  })

  it('runs all of the cuts together, which is the query the dialog actually sends', async () => {
    expect(await subjectsOf({
      search: 'invoice',
      fromText: 'sally',
      toText: 'sales@example.co.uk',
      subjectText: '4021',
      withAttachment: true,
      after: new Date('2026-09-01T00:00:00Z'),
      before: new Date('2026-09-04T00:00:00Z'),
    })).toEqual(['Invoice 4021 for the boardroom chairs'])
  })

  it('counts the statuses behind a narrowed list without falling over', async () => {
    // The status tabs run the same clauses with the status left out. Nothing
    // else executes that combination, and a broken one takes the whole screen
    // down rather than only the tabs.
    const counts = await queries.statusCounts({
      ...visible(),
      search: 'invoice',
      withAttachment: true,
    })
    expect(counts.open ?? 0).toBe(1)
  })
})
