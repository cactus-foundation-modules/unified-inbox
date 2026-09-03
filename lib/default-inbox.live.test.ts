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
// An address of one's own, executed.
//
// `migrations/017_user_default_inbox.sql` and the four statements that read and
// write it are raw SQL, and nothing else in this repository runs them: `tsc`
// sees a template string, `eslint` sees a template string, and a build never
// executes a query. The dangerous one is setInboxAudience, which does a scoped
// DELETE with a `NOT IN` list and an upsert on a primary key of "user_id"
// alone - "somebody's own inbox is one address or none" is a claim the database
// has to enforce, and nothing had ever asked it to.
//
// A real throwaway database on the Postgres VPS, built from the core schema and
// this module's own migrations. Named `cactus_rt_*` and dropped afterwards; the
// live site's database sits on the same server and is never named, opened or
// altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_DEFAULT_GUARDS=1 npx vitest run \
//     modules/unified-inbox/lib/default-inbox.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_DEFAULT_GUARDS === '1'
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

describe.runIf(shouldRun)('an address of one’s own, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db

  let purchasing = ''
  let accounts = ''
  const emma = 'user-emma'
  const marcus = 'user-marcus'

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
    database = await createTestDatabase(vps, `cactus_rt_uindef_${stamp}`, role)
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

    // Two real people: the foreign key to "User" is part of what is being tested.
    await db.$executeRawUnsafe(`INSERT INTO "Role" ("id", "name") VALUES ('role-staff', 'Staff')`)
    for (const [id, email, username] of [
      [emma, 'emma@deskwell.co.uk', 'emma'],
      [marcus, 'marcus@deskwell.co.uk', 'marcus'],
    ]) {
      await db.$executeRawUnsafe(
        `INSERT INTO "User" ("id", "email", "username", "roleId", "updatedAt")
         VALUES ($1, $2, $3, 'role-staff', now())`,
        id, email, username,
      )
    }

    const connection = await lib.createConnection({
      label: 'iCloud',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapUsername: 'someone@example.com',
      imapPassword: 'nothing-real',
    })
    purchasing = (await lib.createInbox({ name: 'Purchasing', address: 'purchasing@deskwell.co.uk', connectionId: connection.id })).id
    accounts = (await lib.createInbox({ name: 'Accounts', address: 'accounts@deskwell.co.uk', connectionId: connection.id })).id
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('starts with nobody having an address of their own', async () => {
    expect(await lib.listUserDefaultInboxes()).toEqual([])
    expect(await lib.defaultInboxIdFor(emma)).toBeNull()
  })

  it('makes an address somebody’s own, alongside who may read it', async () => {
    await lib.setInboxAudience(purchasing, [
      { userId: emma, canReply: true },
      { userId: marcus, canReply: false },
    ], [emma])
    expect(await lib.defaultInboxIdFor(emma)).toBe(purchasing)
    expect(await lib.defaultInboxIdFor(marcus)).toBeNull()
    expect(await lib.listUserDefaultInboxes()).toEqual([{ userId: emma, inboxId: purchasing }])
  })

  it('holds one person to one address of their own', async () => {
    // The primary key on "user_id" alone is the claim; the upsert has to move
    // the row rather than leave two answers to one question.
    await lib.setInboxAudience(accounts, [{ userId: emma, canReply: true }], [emma])
    expect(await lib.defaultInboxIdFor(emma)).toBe(accounts)
    expect(await lib.listUserDefaultInboxes()).toEqual([{ userId: emma, inboxId: accounts }])
  })

  it('knows which addresses are somebody’s own, from the inbox’s side', async () => {
    // Asked at send time to settle whose signature goes at the foot: a reply
    // leaving a personal address signs as its owner whoever pressed Send.
    expect(await lib.inboxIsSomebodysOwn(accounts)).toBe(true)
    expect(await lib.inboxIsSomebodysOwn(purchasing)).toBe(false)
  })

  it('takes it away from whoever is dropped off the list, and nobody else', async () => {
    await lib.setInboxAudience(purchasing, [{ userId: marcus, canReply: true }], [marcus])
    expect(await lib.defaultInboxIdFor(marcus)).toBe(purchasing)
    // Emma still has accounts@ - a save on purchasing@ must not disturb it.
    expect(await lib.defaultInboxIdFor(emma)).toBe(accounts)

    await lib.setInboxAudience(purchasing, [{ userId: marcus, canReply: true }], [])
    expect(await lib.defaultInboxIdFor(marcus)).toBeNull()
    expect(await lib.defaultInboxIdFor(emma)).toBe(accounts)
    // And the inbox stops being anybody's own along with it.
    expect(await lib.inboxIsSomebodysOwn(purchasing)).toBe(false)
  })

  it('lets go when the person does', async () => {
    await db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, emma)
    expect(await lib.listUserDefaultInboxes()).toEqual([])
  })
})
