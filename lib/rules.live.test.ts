import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
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
import type { RuleBody } from './rules'

// ---------------------------------------------------------------------------
// Inbox rules, executed.
//
// migrations/078_rules.sql and every query in lib/rules-db.ts are raw SQL, and
// nothing else in this repository runs a line of them - tsc and eslint see
// template strings and a build never connects. So this suite does: a real
// throwaway database on the database server, built from the core schema and
// this module's own migrations, named `cactus_rt_*` and dropped afterwards.
// The live site's database on the same server is never named or touched.
//
//   RUN_INBOX_RULES_GUARDS=1 npx vitest run \
//     modules/unified-inbox/lib/rules.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_RULES_GUARDS === '1'

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
type RulesDb = typeof import('./rules-db')
type Engine = typeof import('./rules-engine')

const mergeRule = (over: Partial<RuleBody> = {}): RuleBody => ({
  name: 'Supplier replies join their purchase order',
  enabled: true,
  trigger: 'newConversation',
  match: 'all',
  conditions: [{ id: 'c1', field: 'subject', op: 'matches', value: 'PO-#####' }],
  actions: [{ type: 'mergeByReference', pattern: 'PO-#####', lookIn: 'subject', sameCompany: true, withinDays: 60 }],
  stopProcessing: false,
  ...over,
})

describe.runIf(shouldRun)('inbox rules, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db
  let rulesDb: RulesDb
  let engine: Engine

  let connectionId = ''
  let purchasingInbox = ''
  let chrisInbox = ''

  /** One conversation with one message, as the collecting pass files it. */
  async function conversation(over: {
    inboxId: string
    subject: string
    direction: 'in' | 'out'
    from: string
    to: string[]
    sentAt: Date
    body?: string
  }): Promise<{ threadId: string; messageId: string }> {
    const threadId = await lib.createThread({
      inboxId: over.inboxId,
      subject: over.subject,
      subjectNormalised: over.subject.toLowerCase(),
      preview: 'Our purchase order is attached.',
      lastMessageAt: over.sentAt,
      lastDirection: over.direction,
      unread: over.direction === 'in',
    })
    // createThread stamps created_at as now; the rule cares which started
    // first, so make that the message's own time.
    await db.$executeRawUnsafe('UPDATE "uin_threads" SET "created_at" = $1 WHERE "id" = $2', over.sentAt, threadId)
    const messageId = await lib.insertMessage({
      threadId,
      connectionId,
      direction: over.direction,
      messageIdHeader: `${threadId}@example.test`,
      inReplyTo: null,
      references: [],
      fromName: null,
      fromAddress: over.from,
      replyTo: null,
      toAddresses: over.to,
      ccAddresses: [],
      subject: over.subject,
      bodyText: over.body ?? 'Thank you for placing your order.',
      bodyHtml: null,
      snippet: 'Thank you for placing your order.',
      sentAt: over.sentAt,
      hasAttachments: false,
      sizeBytes: 2048,
      imapFolder: 'INBOX',
      imapUid: Math.floor(Math.random() * 1_000_000),
      threadMatch: 'new',
      routedOn: 'to',
      autoKind: null,
      internalKey: null,
    })
    if (!messageId) throw new Error('message not written')
    return { threadId, messageId }
  }

  async function mergedInto(threadId: string): Promise<string | null> {
    const rows = await db.$queryRawUnsafe<Array<{ m: string | null }>>(
      'SELECT "merged_into_id" AS m FROM "uin_threads" WHERE "id" = $1', threadId,
    )
    return rows[0]?.m ?? null
  }

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000)

  beforeAll(async () => {
    vps = vpsConfigFromEnv()
    await dropStaleTestObjects(vps)

    const stamp = Date.now()
    role = await createTestRole(vps, `cactus_rt_role_${stamp}`)
    database = await createTestDatabase(vps, `cactus_rt_uinrul_${stamp}`, role)
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
    // Twice, as an install that picks the file up again would.
    await applyFile(path.join(MODULE_MIGRATIONS, '078_rules.sql'))

    lib = await import('./db')
    rulesDb = await import('./rules-db')
    engine = await import('./rules-engine')

    connectionId = (await lib.createConnection({
      label: 'Mail', imapHost: 'imap.example.com', imapPort: 993,
      imapUsername: 'someone@example.com', imapPassword: 'nothing-real',
    })).id
    purchasingInbox = (await lib.createInbox({ name: 'Purchasing', address: 'purchasing@shop.example', connectionId })).id
    chrisInbox = (await lib.createInbox({ name: 'Chris', address: 'chris@shop.example', connectionId })).id
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('stores, lists, reorders, switches and deletes rules', async () => {
    const a = await rulesDb.createRule(mergeRule({ name: 'A' }), null)
    const b = await rulesDb.createRule(mergeRule({ name: 'B', enabled: false }), null)
    expect((await rulesDb.listRules()).map((r) => r.name)).toEqual(['A', 'B'])
    expect((await rulesDb.enabledRules()).map((r) => r.name)).toEqual(['A'])

    await rulesDb.reorderRules([b.id, a.id])
    expect((await rulesDb.listRules()).map((r) => r.name)).toEqual(['B', 'A'])

    expect(await rulesDb.setRuleEnabled(b.id, true, null)).toBe(true)
    expect((await rulesDb.enabledRules()).map((r) => r.name)).toEqual(['B', 'A'])

    const updated = await rulesDb.updateRule(a.id, mergeRule({ name: 'A2', match: 'any' }), null)
    expect(updated?.name).toBe('A2')
    expect(updated?.match).toBe('any')
    expect(updated?.unreadable).toBe(false)

    expect(await rulesDb.deleteRule(a.id)).toBe(true)
    expect(await rulesDb.deleteRule(b.id)).toBe(true)
    expect(await rulesDb.countRules()).toBe(0)
  })

  it('merges a supplier’s fresh reply into the purchase order it mentions, once', async () => {
    const rule = await rulesDb.createRule(mergeRule(), null)

    const po = await conversation({
      inboxId: purchasingInbox, subject: 'Purchase order PO-00091 from Shop', direction: 'out',
      from: 'purchasing@shop.example', to: ['sales@supplier.example'], sentAt: hoursAgo(20),
    })
    // A different order, which must be left alone.
    const otherPo = await conversation({
      inboxId: purchasingInbox, subject: 'Purchase order PO-000912 from Shop', direction: 'out',
      from: 'purchasing@shop.example', to: ['sales@supplier.example'], sentAt: hoursAgo(19),
    })
    const reply = await conversation({
      inboxId: chrisInbox, subject: 'Sales Order 0000980102 - PO-00091', direction: 'in',
      from: 'faye.whitmore@supplier.example', to: ['chris@shop.example'], sentAt: hoursAgo(2),
    })

    await engine.applyRulesToMessage(reply.messageId)

    expect(await mergedInto(reply.threadId)).toBe(po.threadId)
    expect(await mergedInto(otherPo.threadId)).toBeNull()

    const runs = await rulesDb.listRuleRuns(rule.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.summary).toContain('PO-00091')
    expect(runs[0]?.mergeIds.length).toBe(1)
    expect(runs[0]?.undone).toBe(false)

    const stored = await rulesDb.getRule(rule.id)
    expect(stored?.fireCount).toBe(1)
    expect(stored?.lastFiredAt).not.toBeNull()

    // The timeline names the rule rather than "Somebody".
    const events = await lib.listThreadEvents(po.threadId)
    const merged = events.find((e) => e.kind === 'merged')
    expect(merged?.detail?.ruleName).toBe(rule.name)

    // A second go does nothing: the claim holds.
    await engine.applyRulesToMessage(reply.messageId)
    expect(await rulesDb.listRuleRuns(rule.id)).toHaveLength(1)

    // Put back, and the log says so - and the rule does not merge it again.
    const mergeId = runs[0]!.mergeIds[0]!
    const undone = await lib.undoThreadMerge(mergeId, null)
    expect(undone).not.toHaveProperty('error')
    expect((await rulesDb.listRuleRuns(rule.id))[0]?.undone).toBe(true)
    const backfill = await engine.backfillRule(rule.id, 7, null)
    expect(backfill).not.toHaveProperty('error')
    expect(await mergedInto(reply.threadId)).toBeNull()

    await rulesDb.deleteRule(rule.id)
  })

  it('leaves a reply from another company alone when asked to keep to the same one', async () => {
    const rule = await rulesDb.createRule(mergeRule(), null)
    await conversation({
      inboxId: purchasingInbox, subject: 'Purchase order PO-00200 from Shop', direction: 'out',
      from: 'purchasing@shop.example', to: ['sales@one.example'], sentAt: hoursAgo(30),
    })
    const stranger = await conversation({
      inboxId: chrisInbox, subject: 'Your ref PO-00200', direction: 'in',
      from: 'someone@two.example', to: ['chris@shop.example'], sentAt: hoursAgo(1),
    })
    await engine.applyRulesToMessage(stranger.messageId)
    expect(await mergedInto(stranger.threadId)).toBeNull()
    // Nothing done, so nothing logged and the claim given back.
    expect(await rulesDb.listRuleRuns(rule.id)).toHaveLength(0)
    await rulesDb.deleteRule(rule.id)
  })

  it('finds a reference in the earlier conversation’s message text when told to look there', async () => {
    const bodyRule = mergeRule({
      conditions: [],
      actions: [{ type: 'mergeByReference', pattern: 'PO-#####', lookIn: 'subjectOrBody', sameCompany: true, withinDays: 60 }],
    })
    // The order went out with a subject that never mentions its number.
    const po = await conversation({
      inboxId: purchasingInbox, subject: 'Your order from Shop', direction: 'out',
      from: 'purchasing@shop.example', to: ['sales@five.example'], sentAt: hoursAgo(30),
      body: 'Please find our purchase order PO-00500 attached.',
    })
    // A longer number in another body must not count.
    const near = await conversation({
      inboxId: purchasingInbox, subject: 'Another order', direction: 'out',
      from: 'purchasing@shop.example', to: ['sales@five.example'], sentAt: hoursAgo(31),
      body: 'Purchase order PO-005001 attached.',
    })
    const reply = await conversation({
      inboxId: chrisInbox, subject: 'Order acknowledgement', direction: 'in',
      from: 'orders@five.example', to: ['chris@shop.example'], sentAt: hoursAgo(2),
      body: 'We confirm receipt of your PO-00500.',
    })

    // Subject-only leaves it alone: neither subject carries the number.
    const subjectOnly = await rulesDb.createRule(mergeRule({ name: 'Subject only', conditions: [] }), null)
    await engine.applyRulesToMessage(reply.messageId)
    expect(await mergedInto(reply.threadId)).toBeNull()
    await rulesDb.deleteRule(subjectOnly.id)

    const rule = await rulesDb.createRule(bodyRule, null)
    await engine.applyRulesToMessage(reply.messageId)
    expect(await mergedInto(reply.threadId)).toBe(po.threadId)
    expect(await mergedInto(near.threadId)).toBeNull()
    await rulesDb.deleteRule(rule.id)
  })

  it('finds the partner for mail already here, oldest first, and previews it first', async () => {
    const po = await conversation({
      inboxId: purchasingInbox, subject: 'Purchase order PO-00300 from Shop', direction: 'out',
      from: 'purchasing@shop.example', to: ['sales@three.example'], sentAt: hoursAgo(50),
    })
    const reply = await conversation({
      inboxId: chrisInbox, subject: 'Sales Order 77 - PO-00300', direction: 'in',
      from: 'orders@three.example', to: ['chris@shop.example'], sentAt: hoursAgo(40),
    })

    const preview = await engine.previewRule(mergeRule(), 7)
    const seen = preview.matches.find((m) => m.messageId === reply.messageId)
    expect(seen?.wouldAct).toBe(true)
    expect(seen?.outcome).toContain('PO-00300')
    expect(await mergedInto(reply.threadId)).toBeNull()

    const rule = await rulesDb.createRule(mergeRule(), null)
    let after: string | null = null
    for (let i = 0; i < 20; i++) {
      const slice = await engine.backfillRule(rule.id, 7, after)
      if ('error' in slice) throw new Error(slice.error)
      if (slice.done || !slice.next) break
      after = slice.next
    }
    expect(await mergedInto(reply.threadId)).toBe(po.threadId)
    await rulesDb.deleteRule(rule.id)
  })

  it('assigns, moves, marks read and done, in one go', async () => {
    await db.$executeRawUnsafe(`INSERT INTO "Role" ("id", "name") VALUES ('role-rt', 'Staff') ON CONFLICT DO NOTHING`)
    await db.$executeRawUnsafe(
      `INSERT INTO "User" ("id", "email", "username", "roleId", "updatedAt")
       VALUES ('user-sam', 'sam@shop.example', 'sam', 'role-rt', now()) ON CONFLICT DO NOTHING`,
    )
    const userId = 'user-sam'
    const rule = await rulesDb.createRule({
      name: 'Invoices go to purchasing',
      enabled: true,
      trigger: 'everyMessage',
      match: 'all',
      conditions: [
        { id: 'a', field: 'subject', op: 'contains', value: 'invoice' },
        { id: 'b', field: 'fromDomain', op: 'is', value: '@four.example' },
      ],
      actions: [{ type: 'assign', userId }, { type: 'move', inboxId: purchasingInbox }, { type: 'markRead' }, { type: 'markDone' }],
      stopProcessing: true,
    }, null)
    const invoice = await conversation({
      inboxId: chrisInbox, subject: 'Invoice 4411', direction: 'in',
      from: 'accounts@four.example', to: ['chris@shop.example'], sentAt: hoursAgo(1),
    })
    await engine.applyRulesToMessage(invoice.messageId)
    const thread = await rulesDb.threadBasics(invoice.threadId)
    expect(thread?.inboxId).toBe(purchasingInbox)
    expect(thread?.status).toBe('done')
    expect(thread?.unread).toBe(false)
    expect(thread?.assigneeUserId).toBe(userId)
    const runs = await rulesDb.listRuleRuns(rule.id)
    expect(runs[0]?.summary).toMatch(/^Assigned it, moved it to Purchasing, marked it read and marked it done$/)
    await rulesDb.deleteRule(rule.id)
  })
})
