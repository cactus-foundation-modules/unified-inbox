import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
// Type only, and the module's own db layer is imported inside beforeAll: the
// shared Prisma client is built the first time it is imported and reads
// DATABASE_URL as it goes.
import type { ExtendedPrismaClient } from '@/lib/db/prisma'
import { chooseThread, HEURISTIC_WINDOW_DAYS } from './threading'
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
// A mailshot's copies in the Sent folder are one conversation EACH, executed.
//
// A campaign that files itself into the mailbox's Sent folder is read back a
// message at a time on the next collection, and every one of them has the same
// subject, the same sender and a different customer. The rule that decides
// whether two such messages are one conversation is half in `chooseThread` and
// half in the raw SQL behind `candidateThreads` - which is a query, and a query
// is a string to `tsc`, to `eslint` and to the module build gate alike. It has
// to be RUN.
//
// It got this wrong on the live site: seven campaign emails to seven different
// companies arrived as one conversation with seven messages on it, because the
// only participant the query collected was the From line - and the From line is
// ours on every single one of them.
//
// A real throwaway database on the Postgres VPS, built from the core schema and
// this module's own migrations. Named `cactus_rt_*` and dropped afterwards; the
// live site's database sits on the same server and is never named, opened or
// altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_CAMPAIGN_THREADS=1 npx vitest run \
//     modules/unified-inbox/lib/campaign-threads.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_CAMPAIGN_THREADS === '1'
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

const SUBJECT = 'The chair everyone avoids'
const NORMALISED = 'the chair everyone avoids'
const US = 'emma@deskwelloffice.co.uk'
const ALICE = 'david_abbott@gailsbread.co.uk'
const BOB = 'meaghan.baker@ihg.com'
const SENT_AT = new Date('2026-09-09T16:12:05.000Z')
const SINCE = new Date(SENT_AT.getTime() - HEURISTIC_WINDOW_DAYS * 24 * 60 * 60 * 1000)

describe.runIf(shouldRun)('a mailshot is one conversation per person, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db

  let connectionId = ''
  let inboxId = ''
  let aliceThread = ''

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
    database = await createTestDatabase(vps, `cactus_rt_uincamp_${stamp}`, role)
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

    connectionId = (await lib.createConnection({
      label: 'Deskwell',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapUsername: US,
      imapPassword: 'nothing-real',
    })).id

    inboxId = (await lib.createInbox({ name: 'Emma', address: US, connectionId })).id

    // The first copy out of the Sent folder: our address wrote it, one customer
    // received it, and nobody has answered yet.
    aliceThread = await lib.createThread({
      inboxId,
      subject: SUBJECT,
      subjectNormalised: NORMALISED,
      preview: 'Are you the person who gets the "my chair is broken" emails?',
      lastMessageAt: SENT_AT,
      lastDirection: 'out',
      unread: false,
    })
    await lib.insertMessage({
      threadId: aliceThread,
      connectionId,
      direction: 'out',
      messageIdHeader: 'uin.xWODW@deskwelloffice.co.uk',
      inReplyTo: null,
      references: [],
      fromName: 'Emma',
      fromAddress: US,
      replyTo: null,
      toAddresses: [ALICE],
      ccAddresses: [],
      subject: SUBJECT,
      bodyText: 'Are you the person who gets the "my chair is broken" emails?',
      bodyHtml: null,
      snippet: 'Are you the person who gets the "my chair is broken" emails?',
      sentAt: SENT_AT,
      hasAttachments: false,
      sizeBytes: 4096,
      imapFolder: 'Sent',
      imapUid: 17,
      threadMatch: 'new',
      routedOn: 'outbound',
      autoKind: null,
    })
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('collects who was written to, not only who wrote', async () => {
    const [candidate] = await lib.candidateThreads(NORMALISED, SINCE)
    expect(candidate?.id).toBe(aliceThread)
    // Both. The recipient is the whole of what tells one of these apart from
    // the next, and it lives in an array column rather than in from_address.
    expect([...(candidate?.participants ?? [])].sort()).toEqual([US, ALICE].sort())
  })

  it('starts a fresh conversation for the next person on the list', async () => {
    const candidates = await lib.candidateThreads(NORMALISED, SINCE)
    expect(chooseThread({
      inReplyTo: null,
      references: [],
      byMessageId: new Map(),
      subjectNormalised: NORMALISED,
      participants: [US, BOB],
      sentAt: new Date(SENT_AT.getTime() + 13_000),
      inboxId,
      candidates,
      ownAddresses: [US],
    })).toEqual({ threadId: null, matchedOn: 'new' })
  })

  it('still puts the customer own answer back on their own conversation', async () => {
    const candidates = await lib.candidateThreads(NORMALISED, SINCE)
    // No In-Reply-To on it: some mail programs strip it, which is the only
    // reason the heuristic exists at all.
    expect(chooseThread({
      inReplyTo: null,
      references: [],
      byMessageId: new Map(),
      subjectNormalised: NORMALISED,
      participants: [ALICE, US],
      sentAt: new Date(SENT_AT.getTime() + 3_600_000),
      inboxId,
      candidates,
      ownAddresses: [US],
    })).toEqual({ threadId: aliceThread, matchedOn: 'heuristic' })
  })
})
