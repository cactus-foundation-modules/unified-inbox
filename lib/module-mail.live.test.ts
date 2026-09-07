import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PrismaClient } from '@prisma/client'
// Type only, and the settings module is imported inside beforeAll: the shared
// Prisma client is built the first time it is imported and reads DATABASE_URL
// as it goes.
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
// The two module mail settings, executed against a real database.
//
// Every query in module-senders.ts is raw SQL and nothing else in this
// repository runs it: tsc sees a template string, eslint sees a template
// string, and a build never executes a query. Migration 046 is worse - DDL that
// no gate anywhere runs until an install takes the update.
//
// Four things here would sail through every other gate and then be wrong on a
// live site.
//
// THE UPGRADE. 046 copies the sending inbox into the new filing column, which
// is the only reason a site already filing purchase orders carries on filing
// them. Get that UPDATE wrong and copies stop appearing on every install that
// had them, silently, with nothing in any log to say so.
//
// INDEPENDENCE. The whole point of the change is that either setting works
// without the other. Both are one row, so writing one must not blank the other
// - which is exactly what an INSERT ... ON CONFLICT naming both columns would
// do, and what the two separate statements exist to avoid.
//
// CLEARING. inbox_id stopped being NOT NULL in 046, so "back to the site's
// usual address" is now a null in a row that may still be answering the other
// question. A row answering neither is taken away again.
//
// A DELETED INBOX. Both foreign keys became ON DELETE SET NULL. Under the old
// CASCADE, retiring an address quietly deleted where a module filed as well;
// under SET NULL the row survives with nulls and both lookups say so.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_MODULE_MAIL=1 npx vitest run \
//     modules/unified-inbox/lib/module-mail.live.test.ts --testTimeout 120000
//
// A SKIP HERE IS A FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_MODULE_MAIL === '1'
if (shouldRun) {
  try {
    ;(process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - the guard below fails the suite loudly rather than skipping.
  }
}

const CORE_SCHEMA = path.join(process.cwd(), 'prisma/migrations/20260626000000_init/migration.sql')
const MODULE_MIGRATIONS = path.join(process.cwd(), 'modules/unified-inbox/migrations')

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

type Settings = typeof import('./module-senders')

describe.runIf(shouldRun)('which inbox a module sends as, and where its copies go', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let settings: Settings
  let orders: string
  let accounts: string

  const inboxId = async (name: string, address: string) => {
    const rows = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "uin_inboxes" ("name", "address") VALUES ('${name}', '${address}') RETURNING "id"`,
    )
    return rows[0]!.id
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
    database = await createTestDatabase(vps, `cactus_rt_uinmail_${stamp}`, role)
    process.env.DATABASE_URL = database.connectionUri

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

    orders = await inboxId('Orders', 'orders@example.co.uk')
    accounts = await inboxId('Accounts', 'accounts@example.co.uk')

    settings = await import('./module-senders')
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  beforeEach(async () => {
    await db.$executeRawUnsafe('DELETE FROM "uin_module_senders"')
  })

  it('files a copy without touching the address the module sends as', async () => {
    await settings.setModuleCopyInbox('shop', orders)

    expect(await settings.getModuleCopyInboxId('shop')).toBe(orders)
    // The entire point of splitting them. A shop that wants to see what its
    // customers were told does not thereby change what a confirmation says it
    // came from.
    expect(await settings.getModuleSenderInboxId('shop')).toBeNull()
  })

  it('sends as one inbox and files into another', async () => {
    await settings.setModuleSender('shop', accounts)
    await settings.setModuleCopyInbox('shop', orders)

    // Written one after the other into the same row, so this is the assertion
    // that a second write does not blank the first.
    expect(await settings.getModuleMailSettings('shop')).toEqual({
      inboxId: accounts,
      copyInboxId: orders,
    })
  })

  it('clears one setting and leaves the other standing', async () => {
    await settings.setModuleSender('shop', accounts)
    await settings.setModuleCopyInbox('shop', orders)

    await settings.setModuleSender('shop', null)

    expect(await settings.getModuleMailSettings('shop')).toEqual({
      inboxId: null,
      copyInboxId: orders,
    })
  })

  it('takes the row away once it answers neither question', async () => {
    await settings.setModuleCopyInbox('shop', orders)
    await settings.setModuleCopyInbox('shop', null)

    const rows = await db.$queryRawUnsafe<{ module_name: string }[]>(
      `SELECT "module_name" FROM "uin_module_senders"`,
    )
    expect(rows).toEqual([])
    expect(await settings.getModuleMailSettings('shop')).toEqual({ inboxId: null, copyInboxId: null })
  })

  it('counts a module as belonging to an inbox it only files into', async () => {
    await settings.setModuleSender('purchase-orders', accounts)
    await settings.setModuleCopyInbox('shop', orders)

    // The conversation screen's record picker opens on these, and a module
    // whose conversations ARE the filed copies belongs there most of all.
    expect(await settings.modulesForInbox(orders)).toEqual(['shop'])
    expect(await settings.modulesForInbox(accounts)).toEqual(['purchase-orders'])
  })

  it('keeps the other setting when the inbox itself is deleted', async () => {
    const retired = await inboxId('Retired', 'retired@example.co.uk')
    await settings.setModuleSender('shop', retired)
    await settings.setModuleCopyInbox('shop', orders)

    await db.$executeRawUnsafe(`DELETE FROM "uin_inboxes" WHERE "id" = '${retired}'`)

    // SET NULL, not CASCADE: retiring an address must not quietly forget where
    // that module files. Sending falls back to the site's own address, which is
    // what a module with no inbox has always done.
    expect(await settings.getModuleMailSettings('shop')).toEqual({
      inboxId: null,
      copyInboxId: orders,
    })
  })

  it('gives a site that was already filing the same filing inbox back', async () => {
    // The shape migration 046 upgrades: a row from 010 that answers only the
    // sending question, on a site where filing followed it.
    await db.$executeRawUnsafe(
      `INSERT INTO "uin_module_senders" ("module_name", "inbox_id") VALUES ('purchase-orders', '${accounts}')`,
    )

    const upgrade = readFileSync(path.join(MODULE_MIGRATIONS, '046_module_copy_inbox.sql'), 'utf8')
    const { splitSqlStatements } = await import('@/lib/backup/restore')
    const update = splitSqlStatements(upgrade).find((s) => s.trimStart().toUpperCase().startsWith('UPDATE'))
    expect(update).toBeTruthy()
    await db.$executeRawUnsafe(update!)

    expect(await settings.getModuleCopyInboxId('purchase-orders')).toBe(accounts)
  })

  it('leaves a site that had chosen nothing filing nothing', async () => {
    const upgrade = readFileSync(path.join(MODULE_MIGRATIONS, '046_module_copy_inbox.sql'), 'utf8')
    const { splitSqlStatements } = await import('@/lib/backup/restore')
    const update = splitSqlStatements(upgrade).find((s) => s.trimStart().toUpperCase().startsWith('UPDATE'))
    await db.$executeRawUnsafe(update!)

    // Which is every module on every site until somebody opens the box. An
    // upgrade that started filing mail nobody asked it to file would be a
    // mailbox full of surprises on update day.
    expect(await settings.getModuleCopyInboxId('shop')).toBeNull()
  })
})
