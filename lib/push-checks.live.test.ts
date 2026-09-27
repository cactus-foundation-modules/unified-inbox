import { createHmac } from 'node:crypto'
import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'
// Type only: the shared Prisma client reads DATABASE_URL the first time it is
// imported, so everything that reaches it is imported inside beforeAll.
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
// Push checks, executed (migration 063): the token minted and kept, the
// provider's signing key stored encrypted, the ring and answer stamps, the
// hourly job stepping over an account its provider rings for, and the route
// itself - Zoho's handshake, a signed ring, a forged one, a wrong token.
//
// A real throwaway `cactus_rt_*` database on the Postgres VPS, dropped
// afterwards; the live site's database on the same server is never named,
// opened or altered. From the core checkout, with OVH_SERVER/OVH_USER/
// OVH_PASSWORD exported from the Deskwell workspace .env:
//
//   RUN_INBOX_PUSH=1 npx vitest run \
//     modules/unified-inbox/lib/push-checks.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_PUSH === '1'
if (shouldRun) {
  try {
    ;(process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - the guard below fails the suite loudly rather than skipping.
  }
}

// The route hands the collection to after(), which only exists inside a real
// request. Here it is caught instead, and the collection itself is stood in
// for: opening a mailbox is not what this suite is about.
const deferred: Array<() => unknown> = []
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (work: () => unknown) => { deferred.push(work) },
}))
const collected: Array<{ connectionId: string; rang: Date }> = []
vi.mock('./push-collect', () => ({
  collectOnPush: async (connectionId: string, rang: Date) => {
    collected.push({ connectionId, rang })
    return { stored: 0, answered: true }
  },
}))

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

describe.runIf(shouldRun)('push checks against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: typeof import('./db')
  let sync: typeof import('./sync')
  let route: typeof import('../app/api/webhooks/new-mail/route')
  let NextRequestCtor: typeof import('next/server').NextRequest
  let connectionId: string
  let token: string

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
    database = await createTestDatabase(vps, `cactus_rt_uinpush_${stamp}`, role)
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
    const files = readdirSync(MODULE_MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
    for (const file of files) await applyFile(path.join(MODULE_MIGRATIONS, file))
    // And again: every migration is idempotent, and 063 has to be too.
    await applyFile(path.join(MODULE_MIGRATIONS, '063_push_checks.sql'))

    lib = await import('./db')
    sync = await import('./sync')
    route = await import('../app/api/webhooks/new-mail/route')
    NextRequestCtor = (await import('next/server')).NextRequest
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  const ring = (opts: { token?: string; body?: string; headers?: Record<string, string> }) =>
    route.POST(new NextRequestCtor(
      `https://site.example/api/m/unified-inbox/webhooks/new-mail?token=${opts.token ?? token}`,
      { method: 'POST', body: opts.body ?? '', headers: opts.headers ?? {} },
    ))

  it('mints a token only when the switch is turned on, and keeps it through off and on again', async () => {
    const plain = await lib.createConnection({
      label: 'Zoho', imapHost: 'imap.example', imapPort: 993, imapUsername: 'hi@example.com', imapPassword: 'pw',
    })
    expect(plain.pushChecks).toBe(false)
    expect(plain.pushToken).toBeNull()
    connectionId = plain.id

    const on = await lib.updateConnection(connectionId, { pushChecks: true })
    expect(on?.pushChecks).toBe(true)
    expect(on?.pushToken).toMatch(/^[0-9a-f]{48}$/)
    token = on!.pushToken!

    await lib.updateConnection(connectionId, { pushChecks: false })
    const again = await lib.updateConnection(connectionId, { pushChecks: true })
    expect(again?.pushToken).toBe(token)
    expect((await lib.connectionByPushToken(token))?.id).toBe(connectionId)

    const born = await lib.createConnection({
      label: 'Born on', imapHost: 'imap.example', imapPort: 993, imapUsername: 'b@example.com', imapPassword: 'pw',
      pushChecks: true,
    })
    expect(born.pushToken).toMatch(/^[0-9a-f]{48}$/)
    expect(born.pushToken).not.toBe(token)
    await lib.deleteConnection(born.id)
  })

  it('refuses a wrong token and a malformed one', async () => {
    expect((await ring({ token: 'f'.repeat(48) })).status).toBe(401)
    expect((await ring({ token: 'nope' })).status).toBe(401)
    expect(collected).toHaveLength(0)
  })

  const secret = 'zoho-says-this-once'
  const sign = (body: string, key = secret) => createHmac('sha256', key).update(body).digest('base64')

  it("keeps Zoho's first-request secret, encrypted, and rings on the handshake", async () => {
    const res = await ring({ body: '{}', headers: { 'x-hook-secret': secret } })
    expect(res.status).toBe(200)
    expect(await lib.getPushHookSecret(connectionId)).toBe(secret)
    const stored = await db.$queryRawUnsafe<{ push_hook_secret_encrypted: string }[]>(
      `SELECT "push_hook_secret_encrypted" FROM "uin_connections" WHERE "id" = $1`, connectionId,
    )
    expect(stored[0]!.push_hook_secret_encrypted).not.toContain(secret)
    expect((await lib.getConnection(connectionId))?.hasPushSecret).toBe(true)

    expect(deferred).toHaveLength(1)
    await deferred.shift()!()
    expect(collected.at(-1)?.connectionId).toBe(connectionId)
  })

  it('accepts a signed ring, empty body or not, and stamps it', async () => {
    const before = (await lib.pushRingState(connectionId)).requestedAt!
    await new Promise((r) => setTimeout(r, 20))
    const body = '{"subject":"Hello","fromAddress":"a@example.com"}'
    expect((await ring({ body, headers: { 'x-hook-signature': sign(body) } })).status).toBe(200)
    expect((await ring({ body: '', headers: { 'x-hook-signature': sign('') } })).status).toBe(200)
    const after = (await lib.pushRingState(connectionId)).requestedAt!
    expect(after.getTime()).toBeGreaterThan(before.getTime())
    expect(deferred).toHaveLength(2)
    deferred.length = 0
  })

  it('refuses a ring without the signature, or signed with another key, once a secret is held', async () => {
    const stamp = (await lib.pushRingState(connectionId)).requestedAt
    expect((await ring({ body: '{}' })).status).toBe(401)
    expect((await ring({ body: '{}', headers: { 'x-hook-signature': sign('{}', 'forged') } })).status).toBe(401)
    expect((await lib.pushRingState(connectionId)).requestedAt).toEqual(stamp)
    expect(deferred).toHaveLength(0)
  })

  it('only ever moves the answered stamp forward', async () => {
    const { requestedAt } = await lib.pushRingState(connectionId)
    await lib.markPushAnswered(connectionId, requestedAt!)
    await lib.markPushAnswered(connectionId, new Date(requestedAt!.getTime() - 60_000))
    expect((await lib.pushRingState(connectionId)).answeredAt).toEqual(requestedAt)
  })

  it('leaves a recently checked push account out of the hourly job without opening it', async () => {
    await lib.recordConnectionSync(connectionId, 'ok', null)
    const outcomes = await sync.syncAllConnections({ budgetMs: 5_000 })
    expect(outcomes.map((o) => o.connectionId)).not.toContain(connectionId)
  })
})
