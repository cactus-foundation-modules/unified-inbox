import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
// Type only, and everything else that would reach the shared Prisma client is
// imported inside beforeAll: that client is built the first time it is imported
// and reads DATABASE_URL as it goes, so importing any of it before the
// throwaway database exists gets a client pointed at nothing at all.
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
// The webhook credential SQL, executed.
//
// Nothing else executes it. `tsc` sees a template string, `eslint` sees a
// template string, and a build never runs a query - so a statement Postgres
// will not parse, a column name that does not exist, or a CHECK that refuses a
// value the screen offers all pass every standing gate and fail for the first
// time on a live site. That has happened once already on this platform, to a
// subquery aliased `both`.
//
// So: a real throwaway database on the Postgres VPS, built from the core schema
// and this module's own migrations, and every statement the shared-credential
// work added run against it. The database is named `cactus_rt_*` and dropped
// afterwards; the live site's database sits on the same server and is never
// named, opened or altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network.
// Run it from the core checkout with OVH_SERVER/OVH_USER/OVH_PASSWORD exported
// from the Deskwell workspace .env:
//
//   RUN_INBOX_WEBHOOK_GUARDS=1 npx vitest run \
//     modules/unified-inbox/lib/webhook-credentials.live.test.ts --testTimeout 120000
//
// Deliberately not a script in core's package.json: core's tracked files ship to
// every install, and naming a module in one of them is the leak the module rules
// are about. A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_WEBHOOK_GUARDS === '1'
if (shouldRun) {
  try {
    ;(process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - the guard below fails the suite loudly rather than skipping.
  }
}

const CORE_SCHEMA = path.join(process.cwd(), 'prisma/migrations/20260626000000_init/migration.sql')
const MODULE_MIGRATIONS = path.join(process.cwd(), 'modules/unified-inbox/migrations')

/** Any 64-character value will do: the point is that what goes in encrypted
 *  comes back out the same, not which key did it. */
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

/** The module's own db layer, imported only once a database exists to point it
 *  at: the shared Prisma client reads DATABASE_URL when it is first imported. */
type WebhooksDb = typeof import('./webhooks-db')

describe.runIf(shouldRun)('webhook credentials against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: WebhooksDb

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
    database = await createTestDatabase(vps, `cactus_rt_uinhooks_${stamp}`, role)
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

    lib = await import('./webhooks-db')
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('starts with no shared pair set', async () => {
    expect(await lib.getSharedWebhookState()).toEqual({ hasSecret: false, hasHeaders: false })
    expect(await lib.getSharedWebhookSecrets()).toEqual({ secret: null, headers: {} })
  })

  it('stores the shared pair encrypted and reads it back whole', async () => {
    const state = await lib.setSharedWebhookCredentials({
      secret: 'the-shared-one',
      headers: { 'X-Api-Key': 'abc123' },
    })
    expect(state).toEqual({ hasSecret: true, hasHeaders: true })
    expect(await lib.getSharedWebhookSecrets()).toEqual({
      secret: 'the-shared-one',
      headers: { 'X-Api-Key': 'abc123' },
    })

    // Encrypted at rest, not merely promised to be.
    const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT "webhook_secret_encrypted" AS s FROM "uin_settings" WHERE "id" = 'singleton'`,
    )
    expect(String(rows[0]?.s)).not.toContain('the-shared-one')
  })

  it('leaves the other half of the shared pair alone when only one is given', async () => {
    await lib.setSharedWebhookCredentials({ secret: 'rotated' })
    const after = await lib.getSharedWebhookSecrets()
    expect(after.secret).toBe('rotated')
    expect(after.headers).toEqual({ 'X-Api-Key': 'abc123' })
  })

  it('takes the shared pair for a subscription that asks for it', async () => {
    const hook = await lib.createWebhook({
      name: 'Shared both ways',
      url: 'https://example.com/hook',
      events: ['message.received'],
      payloadStyle: 'event',
      secretSource: 'shared',
      headersSource: 'shared',
    })
    expect(hook.secretSource).toBe('shared')
    expect(hook.hasSecret).toBe(false)
    expect(await lib.getEffectiveWebhookSecrets(hook)).toEqual({
      secret: 'rotated',
      headers: { 'X-Api-Key': 'abc123' },
    })
  })

  it('takes its own once it has been given one, and neither when told none', async () => {
    const hook = await lib.createWebhook({
      name: 'Its own',
      url: 'https://example.com/own',
      events: ['message.received'],
      payloadStyle: 'event',
      secretSource: 'own',
      secret: 'mine-alone',
      headersSource: 'none',
    })
    expect(await lib.getEffectiveWebhookSecrets(hook)).toEqual({ secret: 'mine-alone', headers: {} })

    const off = await lib.updateWebhook(hook.id, { secretSource: 'none' })
    expect(off).not.toBeNull()
    if (!off) return
    // Still stored, simply not used - so switching back does not lose it.
    expect(off.hasSecret).toBe(true)
    expect(await lib.getEffectiveWebhookSecrets(off)).toEqual({ secret: null, headers: {} })
  })

  it('changes one source without disturbing the other', async () => {
    const hook = await lib.createWebhook({
      name: 'Mixed',
      url: 'https://example.com/mixed',
      events: ['message.received'],
      payloadStyle: 'event',
      secretSource: 'shared',
      headersSource: 'own',
      headers: { 'X-Own': 'yes' },
    })
    const patched = await lib.updateWebhook(hook.id, { name: 'Mixed, renamed' })
    expect(patched?.secretSource).toBe('shared')
    expect(patched?.headersSource).toBe('own')
    expect(patched?.name).toBe('Mixed, renamed')
  })

  it('lists every subscription with its two sources', async () => {
    const all = await lib.listWebhooks()
    expect(all.length).toBeGreaterThanOrEqual(3)
    for (const hook of all) {
      expect(['shared', 'own', 'none']).toContain(hook.secretSource)
      expect(['shared', 'own', 'none']).toContain(hook.headersSource)
    }
  })

  it('refuses a source the screen would never offer', async () => {
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "uin_webhooks" SET "secret_source" = 'whatever' WHERE "name" = 'Mixed, renamed'`,
      ),
    ).rejects.toThrow()
  })

  it('clears one half of the shared pair without touching the other', async () => {
    await lib.setSharedWebhookCredentials({ secret: '' })
    expect(await lib.getSharedWebhookState()).toEqual({ hasSecret: false, hasHeaders: true })
    const after = await lib.getSharedWebhookSecrets()
    expect(after.secret).toBeNull()
    expect(after.headers).toEqual({ 'X-Api-Key': 'abc123' })
  })
})
