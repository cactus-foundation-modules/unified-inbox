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
// WhatsApp conversations reach the database, executed against a real one.
//
// `uin_threads.channel` is checked in the SCHEMA, not only in the code:
//
//   CHECK ("channel" IN ('email', 'chat', 'form', 'phone', 'sms', ...))
//
// which is the right way round, and is exactly why this file exists. Adding a
// channel in TypeScript and forgetting the constraint gives a module that
// typechecks, lints and passes the whole suite, and then refuses every single
// WhatsApp conversation the moment a real Postgres sees one - because a CHECK
// constraint is a string to tsc, a string to eslint, and never executed by a
// build. This suite is the only thing in the repository that runs it.
//
// The second claim is about identity. The telephony module publishes TWO
// channels, and both of them group their conversations by the other person's
// phone number - so the same number is the external id under `twilio` and
// under `twilio-whatsapp`. If threads were keyed on the module rather than on
// the channel, a customer who both rang and messaged would have one row that
// the two channels overwrote in turn, and their WhatsApp messages would appear
// inside their call history. They are two conversations and must stay two.
//
// Skipped unless opted into, so a plain npm test never touches the network:
//
//   RUN_INBOX_WHATSAPP=1 npx vitest run \
//     modules/unified-inbox/lib/whatsapp-channel.live.test.ts --testTimeout 120000
//
// A SKIP HERE IS A FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_WHATSAPP === '1'
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

describe.runIf(shouldRun)('WhatsApp conversations, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let queries: Db

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
    database = await createTestDatabase(vps, `cactus_rt_uinwa_${stamp}`, role)
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
    // Every migration in order, exactly as the runner applies them - which
    // matters here: 030 narrows the channel constraint and 038 widens it again,
    // so a test that applied only the latest file would prove nothing.
    for (const file of readdirSync(MODULE_MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      await applyFile(path.join(MODULE_MIGRATIONS, file))
    }

    queries = await import('./db')
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  /** One conversation as the collection tick files it. */
  const arrive = (providerModule: string, channel: string, externalId: string, at: Date) =>
    queries.upsertProviderThread({
      providerModule,
      externalId,
      channel,
      subject: `${channel}: ${externalId}`,
      subjectNormalised: `${channel} ${externalId}`,
      preview: 'Something somebody said.',
      lastMessageAt: at,
      lastDirection: 'in',
      unread: false,
      inboxId: null,
      sourceLabel: null,
    })

  it('accepts a WhatsApp conversation', async () => {
    const { id, created } = await arrive(
      'twilio-whatsapp',
      'whatsapp',
      '+447700900123',
      new Date('2026-09-05T10:00:00Z'),
    )
    expect(created).toBe(true)

    const stored = await queries.getThreadDetail(id)
    expect(stored?.channel).toBe('whatsapp')
    expect(stored?.providerModule).toBe('twilio-whatsapp')
  })

  it('still accepts every channel that came before it', async () => {
    for (const channel of ['email', 'chat', 'form', 'phone', 'sms', 'discussion']) {
      const { id } = await arrive(`legacy-${channel}`, channel, `old-${channel}`, new Date('2026-09-05T11:00:00Z'))
      const stored = await queries.getThreadDetail(id)
      expect(stored?.channel).toBe(channel)
    }
  })

  it('refuses a channel nobody publishes, so the constraint is genuinely on', async () => {
    await expect(
      arrive('twilio-carrier-pigeon', 'pigeon', '+447700900999', new Date('2026-09-05T12:00:00Z')),
    ).rejects.toThrow()
  })

  // The one that would be silently wrong. Both telephony channels group by the
  // other person's number, so this is the SAME external id arriving twice under
  // two different channels - one human who both rang and messaged.
  it('keeps a number’s calls and its WhatsApp messages as two conversations', async () => {
    const number = '+447700900456'
    const phone = await arrive('twilio', 'phone', number, new Date('2026-09-05T13:00:00Z'))
    const whatsapp = await arrive('twilio-whatsapp', 'whatsapp', number, new Date('2026-09-05T14:00:00Z'))

    expect(whatsapp.created).toBe(true)
    expect(whatsapp.id).not.toBe(phone.id)

    const storedPhone = await queries.getThreadDetail(phone.id)
    const storedWhatsApp = await queries.getThreadDetail(whatsapp.id)
    expect(storedPhone?.channel).toBe('phone')
    expect(storedWhatsApp?.channel).toBe('whatsapp')
  })

  // And the other half of the same claim: a second collection of the SAME
  // channel is an update, not a third conversation.
  it('updates rather than duplicates when the same conversation comes round again', async () => {
    const number = '+447700900789'
    const first = await arrive('twilio-whatsapp', 'whatsapp', number, new Date('2026-09-05T15:00:00Z'))
    const second = await arrive('twilio-whatsapp', 'whatsapp', number, new Date('2026-09-05T16:00:00Z'))

    expect(second.created).toBe(false)
    expect(second.id).toBe(first.id)
  })
})
