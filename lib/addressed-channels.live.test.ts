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
// A channel that addressed its conversations at one of the site's inboxes,
// executed against a real database.
//
// A form on the site can now say where its enquiries belong: point the "Get in
// touch" form at sales@ and its enquiries are sales@ post from the moment they
// arrive. Four claims come out of that, all of them raw SQL, and nothing else
// in this repository runs a single one of them - tsc sees a template string,
// eslint sees a template string, and a build never executes a query.
//
// THE UPSERT TAKES AN ADDRESS. Two new columns in an INSERT ... ON CONFLICT DO
// UPDATE whose SET list now carries two COALESCEs. Get a comma wrong and every
// enquiry on every site stops being collected.
//
// FILED ONCE, THEN LEFT ALONE. Somebody who moves an enquiry out of sales@ must
// not find it back there after the next collection because the form still says
// sales@. That is the COALESCE on the stored side, and it is the one that would
// be silently wrong.
//
// COUNTED IN ONE PLACE. The unread tally keys on a COALESCE across three
// columns and the order of them decides whether an addressed enquiry is counted
// under its inbox or under its channel. Counting it under both is how a badge
// starts disagreeing with the list under it.
//
// LISTED IN ONE PLACE. The channel's own entry lists what was addressed at
// nothing; the inbox lists what was addressed at it. An enquiry appearing in
// both is the second place to look for the same thing that this whole module
// exists to abolish.
//
// READ HERE STAYS READ. A channel with no read state of its own reports every
// enquiry as new for ever, so the SET list has to say that unread only goes
// back on when the conversation has genuinely moved on. Get that wrong and
// every enquiry somebody read this morning is bold again after the next
// collection, which is what happened.
//
// THE ORDER OF THE CHANNELS IS KEPT. A text[] written by the settings UPDATE,
// which nothing else in this repository executes either.
//
// Skipped unless opted into, so a plain npm test never touches the network:
//
//   RUN_INBOX_ADDRESSED=1 npx vitest run \
//     modules/unified-inbox/lib/addressed-channels.live.test.ts --testTimeout 120000
//
// A SKIP HERE IS A FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_ADDRESSED === '1'
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

/** Whose lists these are. Every conversation list in the module is a list as
 *  one PERSON sees it now, because "this is junk" is that reader's opinion
 *  rather than a fact about the mail (see migrations/041_spam.sql). Nothing in
 *  this suite marks anything as junk, so any consistent reader will do. */
const VIEWER = 'user-viewer'

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

describe.runIf(shouldRun)('a channel that addressed its conversations, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let queries: Db
  let salesId: string
  let accountsId: string

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
    database = await createTestDatabase(vps, `cactus_rt_uinaddr_${stamp}`, role)
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

    const inbox = async (name: string, address: string): Promise<string> => {
      const rows = await db.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO "uin_inboxes" ("name", "address") VALUES ($1, $2) RETURNING "id"`,
        name,
        address,
      )
      return rows[0]!.id
    }
    salesId = await inbox('Sales', 'sales@example.co.uk')
    accountsId = await inbox('Accounts', 'accounts@example.co.uk')

    queries = await import('./db')
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  /** One enquiry as the collection tick files it. */
  const arrive = (
    externalId: string,
    opts: { inboxId: string | null; sourceLabel: string | null; at?: Date },
  ) =>
    queries.upsertProviderThread({
      providerModule: 'contact-form',
      externalId,
      channel: 'form',
      subject: `Enquiry ${externalId}`,
      subjectNormalised: `enquiry ${externalId}`,
      preview: 'Some words somebody typed into a form.',
      lastMessageAt: opts.at ?? new Date('2026-09-04T09:00:00Z'),
      lastDirection: 'in',
      // Every collection: the contact form has no read state to report, so it
      // says "new" about an enquiry for as long as it holds it.
      unread: true,
      inboxId: opts.inboxId,
      sourceLabel: opts.sourceLabel,
    })

  const isUnread = async (id: string): Promise<boolean> => {
    const rows = await db.$queryRawUnsafe<{ unread: boolean }[]>(
      `SELECT "unread" FROM "uin_threads" WHERE "id" = $1`,
      id,
    )
    return rows[0]!.unread
  }

  it('files an enquiry at the inbox the form named, with the form’s own name on it', async () => {
    const { id, created } = await arrive('e1', { inboxId: salesId, sourceLabel: 'Get in touch' })
    expect(created).toBe(true)

    const stored = await queries.getThreadDetail(id)
    expect(stored?.inboxId).toBe(salesId)
    expect(stored?.sourceLabel).toBe('Get in touch')
    expect(stored?.providerModule).toBe('contact-form')
  })

  it('leaves an enquiry addressed at nothing on its channel', async () => {
    const { id } = await arrive('e2', { inboxId: null, sourceLabel: 'Request a quote' })
    const stored = await queries.getThreadDetail(id)
    expect(stored?.inboxId).toBeNull()
    expect(stored?.sourceLabel).toBe('Request a quote')
  })

  it('does not move one back after somebody has moved it', async () => {
    const first = await arrive('e3', { inboxId: salesId, sourceLabel: 'Get in touch' })
    await db.$executeRawUnsafe(
      `UPDATE "uin_threads" SET "inbox_id" = $1 WHERE "id" = $2`,
      accountsId,
      first.id,
    )

    // The next collection pass, with the form still saying sales@.
    const again = await arrive('e3', { inboxId: salesId, sourceLabel: 'Get in touch' })
    expect(again.id).toBe(first.id)
    expect(again.created).toBe(false)

    const stored = await queries.getThreadDetail(first.id)
    expect(stored?.inboxId).toBe(accountsId)
  })

  it('files one that arrived before its form was pointed anywhere', async () => {
    const first = await arrive('e4', { inboxId: null, sourceLabel: 'Get in touch' })
    expect((await queries.getThreadDetail(first.id))?.inboxId).toBeNull()

    const again = await arrive('e4', { inboxId: salesId, sourceLabel: 'Get in touch' })
    expect(again.id).toBe(first.id)
    expect((await queries.getThreadDetail(first.id))?.inboxId).toBe(salesId)
  })

  it('leaves an enquiry somebody has read alone when nothing new has come in', async () => {
    // The bug this settles: an enquiry read in the morning went bold again on
    // the next Check now, because the form still called it new and the upsert
    // believed it.
    const { id } = await arrive('r1', { inboxId: salesId, sourceLabel: 'Get in touch' })
    await queries.setThreadRead(id, false)
    expect(await isUnread(id)).toBe(false)

    await arrive('r1', { inboxId: salesId, sourceLabel: 'Get in touch' })
    expect(await isUnread(id)).toBe(false)
  })

  it('makes one unread again when a genuinely newer message arrives', async () => {
    const { id } = await arrive('r2', { inboxId: salesId, sourceLabel: 'Get in touch' })
    await queries.setThreadRead(id, false)

    await arrive('r2', {
      inboxId: salesId,
      sourceLabel: 'Get in touch',
      at: new Date('2026-09-05T11:30:00Z'),
    })
    expect(await isUnread(id)).toBe(true)
  })

  it('remembers the order somebody dragged the channels into', async () => {
    const saved = await queries.updateSettings({ channelOrder: ['phone', 'form', 'chat'] })
    expect(saved.channelOrder).toEqual(['phone', 'form', 'chat'])
    expect((await queries.getSettings()).channelOrder).toEqual(['phone', 'form', 'chat'])
  })

  it('counts an addressed enquiry under its inbox and not under its channel', async () => {
    await arrive('c1', { inboxId: salesId, sourceLabel: 'Get in touch' })
    await arrive('c2', { inboxId: null, sourceLabel: 'Get in touch' })

    const counts = await queries.openCounts(VIEWER, [salesId, accountsId], false, ['contact-form'])
    // Everything filed at sales@ across this suite, the addressed enquiries
    // among them - asked as "more than none" rather than as an exact number,
    // because the tests above deliberately leave rows behind.
    expect(counts[salesId]).toBeGreaterThan(0)
    // The channel's own tally is the ones addressed at nothing.
    expect(counts['m:contact-form']).toBeGreaterThan(0)

    const bySales = await queries.listThreads({
      viewerUserId: VIEWER,
      inboxIds: [salesId],
      includeUnrouted: false,
      inboxId: salesId,
      status: 'all',
      page: 1,
      perPage: 50,
    })
    const byChannel = await queries.listThreads({
      viewerUserId: VIEWER,
      inboxIds: [salesId, accountsId],
      includeUnrouted: false,
      // Both, exactly as the screen asks it: the channels this reader may see,
      // and the one whose entry they have clicked.
      providerModules: ['contact-form'],
      providerModule: 'contact-form',
      status: 'all',
      page: 1,
      perPage: 50,
    })

    expect(bySales.map((r) => r.subject)).toContain('Enquiry c1')
    expect(bySales.map((r) => r.subject)).not.toContain('Enquiry c2')
    expect(byChannel.map((r) => r.subject)).toContain('Enquiry c2')
    expect(byChannel.map((r) => r.subject)).not.toContain('Enquiry c1')
  })

  it('keeps an addressed enquiry out of a reader’s All view when that inbox is not theirs', async () => {
    await arrive('v1', { inboxId: accountsId, sourceLabel: 'Get in touch' })

    // Somebody on sales@ only, who may read the contact form channel.
    const rows = await queries.listThreads({
      viewerUserId: VIEWER,
      inboxIds: [salesId],
      includeUnrouted: false,
      providerModules: ['contact-form'],
      status: 'all',
      page: 1,
      perPage: 50,
    })
    expect(rows.map((r) => r.subject)).not.toContain('Enquiry v1')
  })
})
