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
// The order the list of conversations comes back in, executed.
//
// All of this is raw SQL and nothing else in this repository runs it. tsc sees
// a template string, eslint sees a template string, and a build never executes
// a query - so an ORDER BY that Postgres will not parse, or an index expression
// it refuses as not immutable, is green on every other gate in the project and
// wrong the first time somebody opens their inbox.
//
// Four claims worth executing rather than reading:
//
// MIGRATION 045 APPLIES AT ALL. It adds an index over a GREATEST() of two
// columns, and an expression index is only accepted if Postgres considers the
// expression immutable. Reading the docs is not the same as being told yes.
//
// NOTHING MOVED FOR ORDINARY MAIL. last_arrived_at is null on every
// conversation this has never happened to, GREATEST ignores nulls, and the list
// is therefore ordered exactly as it was before the column existed. That is the
// whole safety argument for the change and it is one assertion.
//
// BACK-DATED POST SURFACES. An email filed into a watched folder by hand is
// dated when it was written and reaches us hours later. It used to land in a
// conversation without moving it an inch - see migration 045 for the live one
// that prompted this.
//
// THE BACKFILL DOES NOT. Every message the backfill walks is behind the
// conversation it joins, by definition. Stamping those would float an entire
// mailbox's history to the top of the list, which is a far louder bug than the
// one being fixed.
//
// Skipped unless opted into, so a plain npm test never touches the network:
//
//   RUN_INBOX_ARRIVAL=1 npx vitest run \
//     modules/unified-inbox/lib/arrival-order.live.test.ts --testTimeout 120000
//
// A SKIP HERE IS A FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_ARRIVAL === '1'
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

describe.runIf(shouldRun)('the order conversations are listed in, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let queries: Db
  let salesId: string
  const ids: Record<string, string> = {}

  const visible = () => ({
    viewerUserId: 'user-viewer',
    inboxIds: [salesId],
    includeUnrouted: false,
    status: 'all' as const,
    page: 1,
    perPage: 25,
  })

  const subjectsInOrder = async (extra: Record<string, unknown> = {}): Promise<string[]> => {
    const rows = await queries.listThreads({ ...visible(), ...extra })
    return rows.map((r) => r.subject ?? '')
  }

  /** A conversation whose newest message is dated `lastMessageAt`, and nothing
   *  else: no arrival recorded, which is every conversation on a site that has
   *  never had one filed in by hand. */
  async function seed(subject: string, lastMessageAt: string): Promise<string> {
    const rows = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "uin_threads"
         ("inbox_id", "channel", "subject", "subject_normalised", "preview",
          "last_message_at", "last_direction", "unread", "message_count", "status")
       VALUES ($1, 'email', $2, lower($2), $2, $3::timestamp, 'in', false, 1, 'open')
       RETURNING "id"`,
      salesId,
      subject,
      lastMessageAt,
    )
    const id = rows[0]!.id
    await db.$executeRawUnsafe(
      `INSERT INTO "uin_messages"
         ("thread_id", "direction", "channel", "from_name", "from_address",
          "to_addresses", "cc_addresses", "subject", "body_text", "sent_at", "has_attachments")
       VALUES ($1, 'in', 'email', 'Faye Whitmore', 'faye@supplier.example',
               ARRAY['sales@example.co.uk']::text[], ARRAY[]::text[], $2, $2, $3::timestamp, false)`,
      id,
      subject,
      lastMessageAt,
    )
    ids[subject] = id
    return id
  }

  /** What the collecting pass does to a conversation a message has landed on,
   *  called exactly as sync.ts calls it. */
  const land = (subject: string, sentAt: string, arrivedNow: boolean) => queries.touchThread(ids[subject]!, {
    sentAt: new Date(sentAt),
    direction: 'in',
    preview: 'a message',
    subject,
    subjectNormalised: subject.toLowerCase(),
    markUnread: true,
    inboxId: salesId,
    arrivedNow,
  })

  const arrivalOf = async (subject: string): Promise<Date | null> => {
    const rows = await db.$queryRawUnsafe<{ last_arrived_at: Date | null }[]>(
      `SELECT "last_arrived_at" FROM "uin_threads" WHERE "id" = $1`,
      ids[subject]!,
    )
    return rows[0]?.last_arrived_at ?? null
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
    database = await createTestDatabase(vps, `cactus_rt_uinarrival_${stamp}`, role)
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
    // Every module migration, in order, including 045. If the GREATEST index it
    // adds is not something Postgres will build, this line is where the suite
    // stops - which is the point of running it here rather than on a customer.
    for (const file of readdirSync(MODULE_MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      await applyFile(path.join(MODULE_MIGRATIONS, file))
    }

    const rows = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "uin_inboxes" ("name", "address") VALUES ('Sales', 'sales@example.co.uk') RETURNING "id"`,
    )
    salesId = rows[0]!.id

    queries = await import('./db')

    // Three ordinary conversations, a day apart, in the state a site has them
    // in before any of this: a date on the newest message and no arrival.
    await seed('Newest - delivery slot', '2026-09-06T10:00:00Z')
    await seed('Middle - invoice 4021', '2026-09-05T10:00:00Z')
    await seed('Oldest - purchase order', '2026-09-04T10:00:00Z')
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('orders conversations that have never had post filed in by hand exactly as it always did', async () => {
    expect(await subjectsInOrder()).toEqual([
      'Newest - delivery slot',
      'Middle - invoice 4021',
      'Oldest - purchase order',
    ])
    expect(await subjectsInOrder({ oldestFirst: true })).toEqual([
      'Oldest - purchase order',
      'Middle - invoice 4021',
      'Newest - delivery slot',
    ])
  })

  it('leaves the arrival unrecorded when the message moves the conversation forward', async () => {
    // The ordinary case: post that is newer than anything the conversation
    // holds. last_message_at says everything there is to say about it.
    await land('Oldest - purchase order', '2026-09-04T11:00:00Z', true)
    expect(await arrivalOf('Oldest - purchase order')).toBeNull()
    expect(await subjectsInOrder()).toEqual([
      'Newest - delivery slot',
      'Middle - invoice 4021',
      'Oldest - purchase order',
    ])
  })

  it('ignores the backfill, whose messages are all behind by definition', async () => {
    await land('Oldest - purchase order', '2026-01-02T09:00:00Z', false)
    expect(await arrivalOf('Oldest - purchase order')).toBeNull()
    expect(await subjectsInOrder()).toEqual([
      'Newest - delivery slot',
      'Middle - invoice 4021',
      'Oldest - purchase order',
    ])
  })

  it('surfaces a back-dated email filed into a watched folder by hand', async () => {
    // Dated behind what the conversation already holds, so last_message_at does
    // not move - and before this change neither did the conversation.
    await land('Oldest - purchase order', '2026-09-04T07:42:00Z', true)
    const arrived = await arrivalOf('Oldest - purchase order')
    expect(arrived).toBeInstanceOf(Date)

    expect(await subjectsInOrder()).toEqual([
      'Oldest - purchase order',
      'Newest - delivery slot',
      'Middle - invoice 4021',
    ])
    // And the mirror, which is the same index read backwards.
    expect(await subjectsInOrder({ oldestFirst: true })).toEqual([
      'Middle - invoice 4021',
      'Newest - delivery slot',
      'Oldest - purchase order',
    ])
  })

  it('hands the conversation back to its own date once real post arrives', async () => {
    // A recorded arrival is not a pin. The next message that genuinely moves
    // the conversation forward outranks it, because GREATEST takes the later of
    // the two and that is now the mail date again.
    await land('Middle - invoice 4021', '2027-01-01T10:00:00Z', true)
    expect(await subjectsInOrder()).toEqual([
      'Middle - invoice 4021',
      'Oldest - purchase order',
      'Newest - delivery slot',
    ])
  })
})
