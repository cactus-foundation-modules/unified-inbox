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
// "Everything in that folder belongs to this address", applied to the post
// already in the folder - executed.
//
// `adoptUnroutedFolderMail` is an UPDATE ... FROM with a correlated EXISTS and
// a second statement keyed on the ids it returns, and raw SQL is a string to
// `tsc`, a string to `eslint`, and never executed by a build. It is also the
// only statement in the module that MOVES a conversation somebody may already
// have been reading, so "does it touch exactly the rows it should" is not a
// question to answer on a customer's site.
//
// A real throwaway database on the Postgres VPS, built from the core schema and
// this module's own migrations. Named `cactus_rt_*` and dropped afterwards; the
// live site's database sits on the same server and is never named, opened or
// altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_ADOPTION_GUARDS=1 npx vitest run \
//     modules/unified-inbox/lib/folder-adoption.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_ADOPTION_GUARDS === '1'
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

const SENT_AT = new Date('2026-09-03T09:14:00.000Z')

describe.runIf(shouldRun)('adopting the post already in a folder, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db

  let connectionId = ''
  let otherConnectionId = ''
  let purchasingId = ''
  let salesId = ''

  let uid = 1

  /** A conversation with one collected email on it, in whatever folder and on
   *  whatever account the case needs. */
  const collected = async (input: {
    inboxId: string | null
    connectionId: string
    folder: string
    routedOn?: string
    providerModule?: string
  }): Promise<string> => {
    const threadId = await lib.createThread({
      inboxId: input.inboxId,
      subject: 'Two of the Artisan desks',
      subjectNormalised: 'two of the artisan desks',
      preview: 'Could you hold them until the office move?',
      lastMessageAt: SENT_AT,
      lastDirection: 'in',
      unread: true,
    })
    if (input.providerModule) {
      await db.$executeRaw`
        UPDATE "uin_threads" SET "provider_module" = ${input.providerModule} WHERE "id" = ${threadId}
      `
    }
    await lib.insertMessage({
      threadId,
      connectionId: input.connectionId,
      direction: 'in',
      messageIdHeader: `<msg-${uid}@example.com>`,
      inReplyTo: null,
      references: [],
      fromName: 'A Supplier',
      fromAddress: 'supplier@example.com',
      replyTo: null,
      toAddresses: ['chris@dwoffice.furniture'],
      ccAddresses: [],
      subject: 'Two of the Artisan desks',
      bodyText: 'Could you hold them until the office move?',
      bodyHtml: null,
      snippet: 'Could you hold them',
      sentAt: SENT_AT,
      hasAttachments: false,
      sizeBytes: 2048,
      imapFolder: input.folder,
      imapUid: uid++,
      threadMatch: 'new',
      routedOn: input.routedOn ?? 'none',
      autoKind: null,
    })
    return threadId
  }

  const inboxOf = async (threadId: string): Promise<string | null> => {
    const rows = await db.$queryRaw<{ inbox_id: string | null }[]>`
      SELECT "inbox_id" FROM "uin_threads" WHERE "id" = ${threadId}
    `
    const row = rows[0]
    if (!row) throw new Error(`no conversation ${threadId}`)
    return row.inbox_id
  }

  const routedOnOf = async (threadId: string): Promise<string | null> => {
    const rows = await db.$queryRaw<{ routed_on: string | null }[]>`
      SELECT "routed_on" FROM "uin_messages" WHERE "thread_id" = ${threadId}
    `
    return rows[0]?.routed_on ?? null
  }

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
    database = await createTestDatabase(vps, `cactus_rt_uinada_${stamp}`, role)
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
      label: 'iCloud',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapUsername: 'someone@example.com',
      imapPassword: 'nothing-real',
    })).id
    otherConnectionId = (await lib.createConnection({
      label: 'The other account',
      imapHost: 'imap.example.net',
      imapPort: 993,
      imapUsername: 'somebody@example.net',
      imapPassword: 'nothing-real',
    })).id

    purchasingId = (await lib.createInbox({
      name: 'Purchasing',
      address: 'purchasing@deskwell.co.uk',
      connectionId,
      imapFolder: 'Purchasing',
      folderOwnsMail: true,
    })).id
    salesId = (await lib.createInbox({
      name: 'Sales',
      address: 'sales@deskwell.co.uk',
      connectionId,
      imapFolder: 'INBOX',
    })).id
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('gives the folder its own unfiled post, and says how much moved', async () => {
    // The case that prompted the setting: an email addressed to an address this
    // site has never served, dragged into the Purchasing folder by hand.
    const dragged = await collected({ inboxId: null, connectionId, folder: 'Purchasing' })

    expect(await lib.adoptUnroutedFolderMail(purchasingId)).toBe(1)
    expect(await inboxOf(dragged)).toBe(purchasingId)
    // And it stops counting as post nobody is reading.
    expect(await routedOnOf(dragged)).toBe('folder')
  })

  it('matches the folder however the mail server spells it', async () => {
    const dragged = await collected({ inboxId: null, connectionId, folder: 'purchasing' })
    expect(await lib.adoptUnroutedFolderMail(purchasingId)).toBe(1)
    expect(await inboxOf(dragged)).toBe(purchasingId)
  })

  it('leaves a conversation that already has an address exactly where it is', async () => {
    const filed = await collected({
      inboxId: salesId, connectionId, folder: 'Purchasing', routedOn: 'to',
    })
    expect(await lib.adoptUnroutedFolderMail(purchasingId)).toBe(0)
    expect(await inboxOf(filed)).toBe(salesId)
    expect(await routedOnOf(filed)).toBe('to')
  })

  it('leaves unfiled post that is in another folder', async () => {
    const elsewhere = await collected({ inboxId: null, connectionId, folder: 'INBOX' })
    expect(await lib.adoptUnroutedFolderMail(purchasingId)).toBe(0)
    expect(await inboxOf(elsewhere)).toBeNull()
  })

  it('leaves the same folder name on a different mail account', async () => {
    // Two accounts can both have a folder called Purchasing, and one owner's
    // rule says nothing about the other's post.
    const other = await collected({
      inboxId: null, connectionId: otherConnectionId, folder: 'Purchasing',
    })
    expect(await lib.adoptUnroutedFolderMail(purchasingId)).toBe(0)
    expect(await inboxOf(other)).toBeNull()
  })

  it('leaves live chat and contact form conversations alone', async () => {
    // Not email at all: they carry no folder, and a folder rule must not sweep
    // them up on the strength of having no inbox.
    const chat = await collected({
      inboxId: null, connectionId, folder: 'Purchasing', providerModule: 'live-chat',
    })
    expect(await lib.adoptUnroutedFolderMail(purchasingId)).toBe(0)
    expect(await inboxOf(chat)).toBeNull()
  })

  it('does nothing for an address that is not collected from a mailbox', async () => {
    const sendOnly = (await lib.createInbox({
      name: 'Receipts', address: 'receipts@deskwell.co.uk', connectionId: null, imapFolder: 'Purchasing',
      folderOwnsMail: true,
    })).id
    await collected({ inboxId: null, connectionId, folder: 'Purchasing' })
    expect(await lib.adoptUnroutedFolderMail(sendOnly)).toBe(0)
  })
})
