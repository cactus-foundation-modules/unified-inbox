import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
// Type only, and the module's own db layer is imported inside beforeAll: the
// shared Prisma client is built the first time it is imported and reads
// DATABASE_URL as it goes, so importing it before the throwaway database exists
// gets a client pointed at nothing at all.
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
// The Sent list's SQL, executed.
//
// Colleague post - one address here writing to another - is filed as INBOUND on
// the person it was addressed to, because that is what it is to them. Without
// the second half of `sentWhere` the sender then watches their own message
// disappear the moment it is delivered, which is a worse bug than the one being
// fixed. That second half is a subquery inside an OR inside a WHERE, and
// nothing else in this repository ever runs it: `tsc` sees a template string,
// `eslint` sees a template string, and a build never executes a query. A
// statement Postgres will not parse passes every standing gate and fails for
// the first time on a live site - which has happened here before, to a subquery
// aliased `both`.
//
// So: a real throwaway database on the Postgres VPS, built from the core schema
// and this module's own migrations, with the real rows and the real functions.
// The database is named `cactus_rt_*` and dropped afterwards; the live site's
// database sits on the same server and is never named, opened or altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network.
// Run it from the core checkout with OVH_SERVER/OVH_USER/OVH_PASSWORD exported
// from the Deskwell workspace .env:
//
//   RUN_INBOX_SENT_GUARDS=1 npx vitest run \
//     modules/unified-inbox/lib/sent-list.live.test.ts --testTimeout 120000
//
// Deliberately not a script in core's package.json: core's tracked files ship to
// every install, and naming a module in one of them is the leak the module rules
// are about. A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_SENT_GUARDS === '1'
if (shouldRun) {
  try {
    ;(process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - the guard below fails the suite loudly rather than skipping.
  }
}

const CORE_SCHEMA = path.join(process.cwd(), 'prisma/migrations/20260626000000_init/migration.sql')
const MODULE_MIGRATIONS = path.join(process.cwd(), 'modules/unified-inbox/migrations')

/** Any 64-character value will do: nothing here is encrypted, but createInbox
 *  reaches for the key regardless. */
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

describe.runIf(shouldRun)('the Sent list against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db

  let chrisInbox = ''
  let emmaInbox = ''
  let connectionId = ''

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
    database = await createTestDatabase(vps, `cactus_rt_uinsent_${stamp}`, role)
    // Set before the first import of anything that builds the shared client.
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

    lib = await import('./db')

    const connection = await lib.createConnection({
      label: 'iCloud',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapUsername: 'someone@example.com',
      imapPassword: 'nothing-real',
    })
    connectionId = connection.id
    chrisInbox = (await lib.createInbox({ name: 'Chris', address: 'chris@deskwell.co.uk', connectionId })).id
    emmaInbox = (await lib.createInbox({ name: 'Emma', address: 'emma@deskwell.co.uk', connectionId })).id

    // What the sync now files for a colleague message: inbound, on the
    // recipient's thread, from an address this site serves.
    const colleagueThread = await lib.createThread({
      inboxId: emmaInbox,
      subject: 'test',
      subjectNormalised: 'test',
      preview: 'just reply to let me know you got this',
      lastMessageAt: new Date('2026-09-02T19:49:14Z'),
      lastDirection: 'in',
      unread: true,
    })
    await lib.insertMessage({
      threadId: colleagueThread,
      connectionId,
      direction: 'in',
      messageIdHeader: 'colleague@deskwell.co.uk',
      inReplyTo: null,
      references: [],
      fromName: 'Chris',
      fromAddress: 'chris@deskwell.co.uk',
      replyTo: null,
      toAddresses: ['emma@deskwell.co.uk'],
      ccAddresses: [],
      subject: 'test',
      bodyText: 'just reply to let me know you got this',
      bodyHtml: null,
      snippet: 'just reply to let me know you got this',
      sentAt: new Date('2026-09-02T19:49:14Z'),
      hasAttachments: false,
      sizeBytes: 100,
      imapFolder: 'Deskwell/Emma Scott',
      imapUid: 1,
      threadMatch: 'new',
      routedOn: 'to',
      autoKind: null,
    })

    // An ordinary customer conversation on Emma's inbox, so the customer's own
    // message can be proved NOT to reach anybody's Sent list.
    const customerThread = await lib.createThread({
      inboxId: emmaInbox,
      subject: 'A quote please',
      subjectNormalised: 'a quote please',
      preview: 'can you price this up',
      lastMessageAt: new Date('2026-09-01T09:00:00Z'),
      lastDirection: 'in',
      unread: true,
    })
    await lib.insertMessage({
      threadId: customerThread,
      connectionId,
      direction: 'in',
      messageIdHeader: 'customer@example.com',
      inReplyTo: null,
      references: [],
      fromName: 'A customer',
      fromAddress: 'customer@example.com',
      replyTo: null,
      toAddresses: ['emma@deskwell.co.uk'],
      ccAddresses: [],
      subject: 'A quote please',
      bodyText: 'can you price this up',
      bodyHtml: null,
      snippet: 'can you price this up',
      sentAt: new Date('2026-09-01T09:00:00Z'),
      hasAttachments: false,
      sizeBytes: 100,
      imapFolder: 'Deskwell/Emma Scott',
      imapUid: 2,
      threadMatch: 'new',
      routedOn: 'to',
      autoKind: null,
    })

    // And Emma's reply to that customer: ordinary outbound, which the Sent list
    // has always shown and must carry on showing.
    await db.$executeRawUnsafe(
      `INSERT INTO "uin_messages"
         ("thread_id", "inbox_id", "direction", "channel", "message_id_header", "from_address",
          "to_addresses", "subject", "snippet", "sent_at")
       VALUES ($1, $2, 'out', 'email', 'reply@deskwell.co.uk', 'emma@deskwell.co.uk',
               ARRAY['customer@example.com']::text[], 'Re: A quote please', 'here you are',
               TIMESTAMP '2026-09-01 10:00:00')`,
      customerThread,
      emmaInbox,
    )
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('keeps the sender their copy of a message that was delivered to a colleague', async () => {
    // Chris may read his own address and nothing else. The message he wrote is
    // sitting inbound on Emma's thread, and it is still his to see.
    const rows = await lib.listSentMessages([chrisInbox], false, [], 1, 25)
    expect(rows.map((r) => r.subject)).toEqual(['test'])
    expect(rows[0]?.toAddresses).toEqual(['emma@deskwell.co.uk'])
    expect(await lib.countSentMessages([chrisInbox], false, [])).toBe(1)
  })

  it('labels it with the address it went out as, not the inbox it landed in', async () => {
    const rows = await lib.listSentMessages([chrisInbox], false, [], 1, 25)
    expect(rows[0]?.inboxId).toBe(chrisInbox)
  })

  it('still lists ordinary outbound mail, and only that, for the sender of it', async () => {
    const rows = await lib.listSentMessages([emmaInbox], false, [], 1, 25)
    // Emma's reply to the customer. The customer's own message is inbound from
    // an address this site does not serve, so it is not on anybody's Sent list,
    // and the colleague message is Chris's rather than hers.
    expect(rows.map((r) => r.subject)).toEqual(['Re: A quote please'])
    expect(await lib.countSentMessages([emmaInbox], false, [])).toBe(1)
  })

  it('shows both to somebody who may read both addresses', async () => {
    const rows = await lib.listSentMessages([chrisInbox, emmaInbox], false, [], 1, 25)
    // Newest first, so the colleague message of 2 September comes before the
    // customer reply of the 1st.
    expect(rows.map((r) => r.subject)).toEqual(['test', 'Re: A quote please'])
    expect(await lib.countSentMessages([chrisInbox, emmaInbox], false, [])).toBe(2)
  })

  it('lists nothing at all for somebody with no addresses', async () => {
    expect(await lib.listSentMessages([], false, [], 1, 25)).toEqual([])
    expect(await lib.countSentMessages([], false, [])).toBe(0)
  })

  it('runs the unrouted-only shape of the query, which has no inbox ids in it', async () => {
    // An administrator sees unfiled mail as well. The clause is built
    // differently in that case and has to parse too.
    expect(await lib.countSentMessages([], true, [])).toBe(0)
  })
})
