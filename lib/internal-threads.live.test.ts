import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
// Type only, and the module's own db layer is imported inside beforeAll: the
// shared Prisma client is built the first time it is imported and reads
// DATABASE_URL as it goes.
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
// One email between two colleagues, two conversations, executed.
//
// `migrations/020_internal_threads.sql` is raw SQL and nothing else in this
// repository runs it: `tsc` sees a template string, `eslint` sees a template
// string, a build never executes a query, and the module build gate compiles
// rather than connects. It also does the two things most worth executing before
// a customer does - it swaps a unique index that every ingest depends on, and it
// winds mail cursors BACKWARDS so already-read mail is read again.
//
// Wind them back too far and a site re-reads years of mail on a 25 second cron
// slice. Wind them back on the wrong rows and it does that to a folder with no
// internal mail in it at all. Neither shows up anywhere but here.
//
// A real throwaway database on the Postgres VPS, built from the core schema and
// this module's own migrations. Named `cactus_rt_*` and dropped afterwards; the
// live site's database sits on the same server and is never named, opened or
// altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_INTERNAL_GUARDS=1 npx vitest run \
//     modules/unified-inbox/lib/internal-threads.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_INTERNAL_GUARDS === '1'
if (shouldRun) {
  try {
    ;(process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - the guard below fails the suite loudly rather than skipping.
  }
}

const CORE_SCHEMA = path.join(process.cwd(), 'prisma/migrations/20260626000000_init/migration.sql')
const MODULE_MIGRATIONS = path.join(process.cwd(), 'modules/unified-inbox/migrations')
const MIGRATION_020 = path.join(MODULE_MIGRATIONS, '020_internal_threads.sql')

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

const SENT_AT = new Date('2026-09-02T23:53:10.000Z')

describe.runIf(shouldRun)('colleague mail on both conversations, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db
  let applyFile: (file: string) => Promise<void>

  let connectionId = ''
  let chrisInbox = ''
  let marcusInbox = ''
  let chrisThread = ''
  let marcusThread = ''

  const message = (over: Partial<Parameters<Db['insertMessage']>[0]>) => ({
    threadId: marcusThread,
    connectionId,
    direction: 'in' as const,
    messageIdHeader: 'original@deskwell.co.uk',
    inReplyTo: null,
    references: [],
    fromName: 'Chris',
    fromAddress: 'chris@deskwell.co.uk',
    replyTo: null,
    toAddresses: ['marcus@deskwell.co.uk'],
    ccAddresses: [],
    subject: 'Artisan Furniture',
    bodyText: 'Are we still on for Tuesday?',
    bodyHtml: null,
    snippet: 'Are we still on for Tuesday?',
    sentAt: SENT_AT,
    hasAttachments: false,
    sizeBytes: 2048,
    imapFolder: 'Deskwell/Marcus Ashford',
    imapUid: 28,
    threadMatch: 'new',
    routedOn: 'to',
    autoKind: null,
    ...over,
  })

  beforeAll(async () => {
    if (!process.env.OVH_SERVER || !process.env.OVH_USER || !process.env.OVH_PASSWORD) {
      throw new Error(
        'OVH_SERVER, OVH_USER and OVH_PASSWORD are needed for this suite. Export them from the Deskwell workspace .env - a skip here is a fail.',
      )
    }
    vps = vpsConfigFromEnv()
    await dropStaleTestObjects(vps)

    const stamp = Date.now()
    role = await createTestRole(vps, `cactus_rt_role_${stamp}`)
    database = await createTestDatabase(vps, `cactus_rt_uinint_${stamp}`, role)
    process.env.DATABASE_URL = database.connectionUri
    process.env.ENCRYPTION_KEY = KEY

    const { stalePlanRetryExtension } = await import('@/lib/db/prisma')
    const { splitSqlStatements } = await import('@/lib/backup/restore')
    db = await connect(database.connectionUri, stalePlanRetryExtension)

    applyFile = async (file: string) => {
      for (const statement of splitSqlStatements(readFileSync(file, 'utf8'))) {
        await db.$executeRawUnsafe(statement)
      }
    }
    await applyFile(CORE_SCHEMA)
    for (const file of readdirSync(MODULE_MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      await applyFile(path.join(MODULE_MIGRATIONS, file))
    }

    lib = await import('./db')

    const connection = await lib.createConnection({
      label: 'iCloud',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapUsername: 'someone@example.com',
      imapPassword: 'nothing-real',
    })
    connectionId = connection.id

    chrisInbox = (await lib.createInbox({
      name: 'Chris', address: 'chris@deskwell.co.uk', connectionId,
    })).id
    marcusInbox = (await lib.createInbox({
      name: 'Marcus Ashford', address: 'marcus@deskwell.co.uk', connectionId,
    })).id

    const thread = {
      subject: 'Artisan Furniture',
      subjectNormalised: 'artisan furniture',
      preview: 'Are we still on for Tuesday?',
      lastMessageAt: SENT_AT,
      lastDirection: 'in' as const,
      unread: true,
    }
    marcusThread = await lib.createThread({ ...thread, inboxId: marcusInbox })
    chrisThread = await lib.createThread({ ...thread, inboxId: chrisInbox, lastDirection: 'out', unread: false })
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('files one email on both colleagues conversations', async () => {
    const onMarcus = await lib.insertMessage(message({ threadId: marcusThread, direction: 'in' }))
    const onChris = await lib.insertMessage(message({ threadId: chrisThread, direction: 'out' }))
    expect(onMarcus).toBeTruthy()
    // The old key allowed a message once per account. This is the whole fix:
    // the second side is a real row, not a swallowed duplicate.
    expect(onChris).toBeTruthy()
    expect(onChris).not.toBe(onMarcus)
  })

  it('still refuses the same email twice on one conversation', async () => {
    // Found again in Archive, or two ticks racing. The guard that was there
    // before is still there.
    expect(await lib.insertMessage(message({ threadId: marcusThread, imapFolder: 'Archive', imapUid: 91 })))
      .toBeNull()
  })

  it('turns away the second copy when a relay rewrote the Message-ID', async () => {
    const key = 'sha256-internal-pair-key'
    expect(await lib.insertMessage(message({
      threadId: chrisThread, messageIdHeader: 'reply@deskwell.co.uk', internalKey: key,
      fromAddress: 'marcus@deskwell.co.uk', toAddresses: ['chris@deskwell.co.uk'], direction: 'in',
    }))).toBeTruthy()

    // Same email back out of the sender's Sent folder, wearing the id the relay
    // gave it. Nothing in the header says it is the one we hold.
    expect(await lib.insertMessage(message({
      threadId: chrisThread, messageIdHeader: 'reply@smtp-relay.example.com', internalKey: key,
      fromAddress: 'marcus@deskwell.co.uk', toAddresses: ['chris@deskwell.co.uk'], direction: 'in',
      imapFolder: 'Sent Messages', imapUid: 24105,
    }))).toBeNull()

    // The other side of the same email is a different conversation, so it is
    // still allowed to hold its own copy.
    expect(await lib.insertMessage(message({
      threadId: marcusThread, messageIdHeader: 'reply@smtp-relay.example.com', internalKey: key,
      fromAddress: 'marcus@deskwell.co.uk', toAddresses: ['chris@deskwell.co.uk'], direction: 'out',
      imapFolder: 'Sent Messages', imapUid: 24105,
    }))).toBeTruthy()
  })

  it('hands back every conversation a referenced message sits on, with its inbox', async () => {
    const refs = await lib.threadsForMessageIds(['original@deskwell.co.uk'])
    const found = refs.get('original@deskwell.co.uk') ?? []
    expect(found.map((r) => r.threadId).sort()).toEqual([chrisThread, marcusThread].sort())
    expect(found.find((r) => r.threadId === chrisThread)?.inboxId).toBe(chrisInbox)
    expect(found.find((r) => r.threadId === marcusThread)?.inboxId).toBe(marcusInbox)
  })

  it('knows which conversations already hold a message, by header or by pair key', async () => {
    const byHeader = await lib.threadsHoldingIdentity(connectionId, 'original@deskwell.co.uk', null)
    expect([...byHeader].sort()).toEqual([chrisThread, marcusThread].sort())

    // The relay-rewritten copy is recognised through the pair key even though
    // the header it arrives with has never been seen on this account.
    const byPair = await lib.threadsHoldingIdentity(
      connectionId, 'never-seen@smtp-relay.example.com', 'sha256-internal-pair-key',
    )
    expect([...byPair].sort()).toEqual([chrisThread, marcusThread].sort())
  })

  it('winds a folder holding colleague mail back so the sweep meets it again', async () => {
    await db.$executeRawUnsafe(
      `INSERT INTO "uin_sync_state" ("connection_id", "folder", "uidvalidity", "last_seen_uid", "backfill_complete")
       VALUES ($1, 'Deskwell/Marcus Ashford', 1746031665, 29, true)`,
      connectionId,
    )
    // A folder with nothing but customer mail in it, which must not be touched:
    // winding this one back is how a site re-reads years of post on a cron slice.
    await db.$executeRawUnsafe(
      `INSERT INTO "uin_sync_state" ("connection_id", "folder", "uidvalidity", "last_seen_uid", "backfill_complete")
       VALUES ($1, 'INBOX', 1309083136, 21858, true)`,
      connectionId,
    )
    await db.$executeRawUnsafe(
      `INSERT INTO "uin_messages" ("thread_id", "connection_id", "direction", "channel", "message_id_header",
        "from_address", "to_addresses", "cc_addresses", "subject", "sent_at", "imap_folder", "imap_uid", "source")
       VALUES ($1, $2, 'in', 'email', 'customer@example.com-1', 'customer@example.com',
               ARRAY['hi@deskwell.co.uk'], ARRAY[]::text[], 'A question', $3, 'INBOX', 21000, 'imap')`,
      marcusThread, connectionId, SENT_AT,
    )

    await applyFile(MIGRATION_020)

    const rows = await db.$queryRawUnsafe<{ folder: string; last_seen_uid: bigint }[]>(
      `SELECT "folder", "last_seen_uid" FROM "uin_sync_state" WHERE "connection_id" = $1 ORDER BY "folder"`,
      connectionId,
    )
    const byFolder = new Map(rows.map((r) => [r.folder, Number(r.last_seen_uid)]))
    // Oldest colleague message in that folder sits at uid 28, so the sweep has
    // to start again from 27 - far enough to meet it, no further.
    expect(byFolder.get('Deskwell/Marcus Ashford')).toBe(27)
    expect(byFolder.get('INBOX')).toBe(21858)
  })

  it('is idempotent - running it twice changes nothing', async () => {
    await applyFile(MIGRATION_020)
    const rows = await db.$queryRawUnsafe<{ folder: string; last_seen_uid: bigint }[]>(
      `SELECT "folder", "last_seen_uid" FROM "uin_sync_state" WHERE "connection_id" = $1 ORDER BY "folder"`,
      connectionId,
    )
    const byFolder = new Map(rows.map((r) => [r.folder, Number(r.last_seen_uid)]))
    expect(byFolder.get('Deskwell/Marcus Ashford')).toBe(27)
    expect(byFolder.get('INBOX')).toBe(21858)
  })
})
