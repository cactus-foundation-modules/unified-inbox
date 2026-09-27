import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'
// Type only: the shared Prisma client reads DATABASE_URL the first time it is
// imported, so everything that reaches it is imported inside beforeAll.
import type { ExtendedPrismaClient } from '@/lib/db/prisma'
import type { SessionUser } from '@/lib/auth/session'
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
// New-mail nudges, executed (migration 064): the arrival rule that the old
// "dated since" question got wrong, whose post counts (own, shared and team
// inboxes, and nothing the reader may not open), the ledger that makes one
// message one nudge however many rounds race for it, the signing pair, the
// subscriptions, and a whole round sealed to a real key and opened again.
//
// A real throwaway `cactus_rt_*` database on the Postgres VPS, dropped
// afterwards; the live site's database on the same server is never named,
// opened or altered. From the core checkout, with OVH_SERVER/OVH_USER/
// OVH_PASSWORD exported from the Deskwell workspace .env:
//
//   RUN_INBOX_NUDGES=1 npx vitest run \
//     modules/unified-inbox/lib/push-nudges.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_NUDGES === '1'

const CORE_SCHEMA = path.join(process.cwd(), 'prisma/migrations/20260626000000_init/migration.sql')
const MODULE_MIGRATIONS = path.join(process.cwd(), 'modules/unified-inbox/migrations')
const KEY = 'b'.repeat(64)
const MINUTE = 60_000

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

/** A browser's half of a subscription, made here so the round's output can be
 *  opened and read back. */
function browserKeys() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = randomBytes(16)
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: auth.toString('base64url'),
    open(body: Buffer): unknown {
      const salt = body.subarray(0, 16)
      const idLength = body.readUInt8(20)
      const asPublic = body.subarray(21, 21 + idLength)
      const sealed = body.subarray(21 + idLength)
      const shared = ecdh.computeSecret(asPublic)
      const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic])
      const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32))
      const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
      const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
      decipher.setAuthTag(sealed.subarray(sealed.length - 16))
      const record = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()])
      return JSON.parse(record.subarray(0, record.length - 1).toString('utf8'))
    },
  }
}

describe.runIf(shouldRun)('new-mail nudges against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: typeof import('./db')
  let pushDb: typeof import('./push-db')
  let arrivals: typeof import('./arrivals')
  let nudges: typeof import('./push-nudges')
  let me: SessionUser
  let colleague: SessionUser
  let connectionId: string
  const inbox: Record<string, string> = {}
  const thread: Record<string, string> = {}

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
    database = await createTestDatabase(vps, `cactus_rt_uinnudge_${stamp}`, role)
    process.env.DATABASE_URL = database.connectionUri
    process.env.ENCRYPTION_KEY = KEY
    process.env.SITE_URL = 'https://site.example'

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
    // And again: every migration is idempotent, and 064 has to be too.
    await applyFile(path.join(MODULE_MIGRATIONS, '064_browser_push.sql'))

    lib = await import('./db')
    pushDb = await import('./push-db')
    arrivals = await import('./arrivals')
    nudges = await import('./push-nudges')

    // Two ordinary members of staff, allowed into the hub and nothing more.
    await db.permission.create({ data: { key: 'unifiedinbox.view', module: 'unified-inbox' } })
    const staff = await db.role.create({ data: { name: 'Staff', permissions: { create: { permissionKey: 'unifiedinbox.view' } } } })
    me = await db.user.create({ data: { email: 'me@site.example', username: 'me', displayName: 'Me', roleId: staff.id }, include: { role: true } })
    colleague = await db.user.create({ data: { email: 'sam@site.example', username: 'sam', displayName: 'Sam', roleId: staff.id }, include: { role: true } })
    const stranger = await db.user.create({ data: { email: 'kit@site.example', username: 'kit', roleId: staff.id } })

    connectionId = (await lib.createConnection({
      label: 'Mail', imapHost: 'imap.example', imapPort: 993, imapUsername: 'all@site.example', imapPassword: 'pw',
    })).id

    // Every kind of address the rail has, and two it must not reach.
    inbox.own = (await lib.createInbox({ name: 'Mine', address: 'me@site.example', kind: 'individual', ownerUserId: me.id })).id
    inbox.shared = (await lib.createInbox({ name: 'Sales', address: 'sales@site.example' })).id
    inbox.team = (await lib.createInbox({ name: 'Sam', address: 'sam@site.example', kind: 'individual', ownerUserId: colleague.id })).id
    inbox.privateTeam = (await lib.createInbox({ name: 'Kit', address: 'kit@site.example', kind: 'individual', ownerUserId: stranger.id })).id
    inbox.restricted = (await lib.createInbox({ name: 'Accounts', address: 'accounts@site.example' })).id
    // Let into Sam's while Sam is away; accounts@ is Sam's alone.
    await db.$executeRawUnsafe(`INSERT INTO "uin_inbox_access" ("inbox_id", "user_id") VALUES ($1, $2)`, inbox.team, me.id)
    await db.$executeRawUnsafe(`INSERT INTO "uin_inbox_access" ("inbox_id", "user_id") VALUES ($1, $2)`, inbox.restricted, colleague.id)
  }, 600_000)

  afterAll(async () => {
    vi.unstubAllGlobals()
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  let uid = 1
  /** One incoming email, filed now, dated `writtenAgoMs` ago - collected late,
   *  as every real message is. */
  async function land(key: string, inboxId: string, opts: {
    from?: string; subject?: string; writtenAgoMs?: number; autoKind?: string | null; unread?: boolean; direction?: 'in' | 'out'
  } = {}) {
    const sentAt = new Date(Date.now() - (opts.writtenAgoMs ?? 10 * MINUTE))
    const subject = opts.subject ?? key
    const threadId = await lib.createThread({
      inboxId, subject, subjectNormalised: subject.toLowerCase(), preview: null,
      lastMessageAt: sentAt, lastDirection: opts.direction ?? 'in', unread: opts.unread ?? true,
    })
    await lib.insertMessage({
      threadId, connectionId, direction: opts.direction ?? 'in', messageIdHeader: `${key}-${uid}@example.com`,
      inReplyTo: null, references: [], fromName: opts.from ?? 'Ada Lovelace', fromAddress: 'ada@example.com',
      replyTo: null, toAddresses: [], ccAddresses: [], subject, bodyText: 'Hello', bodyHtml: null, snippet: 'Hello',
      sentAt, hasAttachments: false, sizeBytes: 10, imapFolder: 'INBOX', imapUid: uid++, threadMatch: 'new',
      routedOn: 'to', autoKind: opts.autoKind ?? null,
    })
    thread[key] = threadId
    return threadId
  }

  const since = () => new Date(Date.now() - 2 * MINUTE)
  const links = { base: '/hq/inbox' }
  const ids = (found: { arrivals: Array<{ threadId: string }> }) => found.arrivals.map((a) => a.threadId).sort()

  it('announces mail collected minutes after it was written, which the old rule never did', async () => {
    await land('own', inbox.own!)
    const found = await arrivals.arrivalsFor(me, { kind: 'since', since: since() }, new Date(), links)
    expect(ids(found)).toEqual([thread.own])
    // The old question, asked of the date written on it, finds nothing: the
    // mail was dated ten minutes back and the round looked back two.
    const old = await lib.listThreads({
      viewerUserId: me.id, inboxIds: [inbox.own!], includeUnrouted: false, unreadOnly: true, status: 'open',
      after: since(), page: 1, perPage: 10,
    })
    expect(old).toHaveLength(0)
  })

  it("covers the reader's own, shared and team inboxes, and nothing they may not open", async () => {
    await land('shared', inbox.shared!)
    await land('team', inbox.team!)
    await land('privateTeam', inbox.privateTeam!)
    await land('restricted', inbox.restricted!)
    const found = await arrivals.arrivalsFor(me, { kind: 'since', since: since() }, new Date(), links)
    expect(ids(found)).toEqual([thread.own, thread.shared, thread.team].sort())
    expect(found.total).toBe(3)
    const byThread = new Map(found.arrivals.map((a) => [a.threadId, a]))
    expect(byThread.get(thread.shared!)?.inbox).toBe('Sales')
    expect(byThread.get(thread.team!)?.inbox).toBe('Sam')
    expect(byThread.get(thread.team!)?.href).toBe(`/hq/inbox?tab=unified-inbox&inbox=${inbox.team}&id=${thread.team}`)

    // And Sam, who is on accounts@ and owns their own, sees those instead.
    const sams = await arrivals.arrivalsFor(colleague, { kind: 'since', since: since() }, new Date(), links)
    expect(ids(sams)).toEqual([thread.shared, thread.team, thread.restricted].sort())
  })

  it('leaves out automated mail, history, mail already read and mail the site sent', async () => {
    const auto = await land('auto', inbox.shared!, { autoKind: 'auto-reply' })
    const history = await land('history', inbox.shared!, { writtenAgoMs: 3 * 24 * 60 * MINUTE })
    const read = await land('read', inbox.shared!, { unread: false })
    const sent = await land('sent', inbox.shared!, { direction: 'out' })
    const found = await arrivals.arrivalsFor(me, { kind: 'since', since: since() }, new Date(), links)
    for (const id of [auto, history, read, sent]) expect(ids(found)).not.toContain(id)
  })

  it('claims each message exactly once, however many rounds race for it', async () => {
    const window = () => [new Date(Date.now() - 30 * MINUTE), new Date(Date.now() - 24 * 60 * MINUTE)] as const
    const racing = await Promise.all([
      pushDb.claimArrivals(...window()),
      pushDb.claimArrivals(...window()),
      pushDb.claimArrivals(...window()),
    ])
    const all = racing.flat()
    expect(new Set(all).size).toBe(all.length)
    // Everything incoming, human and recent - whether or not a given reader
    // may see it, which is asked per person afterwards.
    expect(new Set(all)).toEqual(new Set([
      thread.own, thread.shared, thread.team, thread.privateTeam, thread.restricted, thread.read,
    ]))
    expect(await pushDb.claimArrivals(...window())).toEqual([])
  })

  it('makes one signing pair and keeps it, however many ask at once', async () => {
    const pairs = await Promise.all([pushDb.getOrCreateVapidKeys(), pushDb.getOrCreateVapidKeys(), pushDb.getOrCreateVapidKeys()])
    expect(new Set(pairs.map((p) => p.publicKey)).size).toBe(1)
    expect((await pushDb.getOrCreateVapidKeys()).publicKey).toBe(pairs[0]!.publicKey)
    const stored = await db.$queryRawUnsafe<{ push_vapid_private_encrypted: string }[]>(
      `SELECT "push_vapid_private_encrypted" FROM "uin_settings" WHERE "id" = 'singleton'`,
    )
    expect(stored[0]!.push_vapid_private_encrypted).not.toContain(pairs[0]!.privateKey)
  })

  it('keeps a browser against whoever is signed in to it, and only lets its owner remove it', async () => {
    const endpoint = 'https://web.push.apple.com/shared-machine'
    const keys = browserKeys()
    await pushDb.saveSubscription(colleague.id, { endpoint, p256dh: keys.p256dh, auth: keys.auth })
    await pushDb.saveSubscription(me.id, { endpoint, p256dh: keys.p256dh, auth: keys.auth })
    let rows = await pushDb.listSubscriptions()
    expect(rows.filter((r) => r.endpoint === endpoint).map((r) => r.userId)).toEqual([me.id])
    await pushDb.deleteSubscription(colleague.id, endpoint)
    rows = await pushDb.listSubscriptions()
    expect(rows.some((r) => r.endpoint === endpoint)).toBe(true)
    await pushDb.deleteSubscription(me.id, endpoint)
    expect((await pushDb.listSubscriptions()).some((r) => r.endpoint === endpoint)).toBe(false)
  })

  it('sends each person one sealed nudge about their own post, and forgets a browser that has gone', async () => {
    const mine = browserKeys()
    const sams = browserKeys()
    const keysOf = (k: { p256dh: string; auth: string }) => ({ p256dh: k.p256dh, auth: k.auth })
    await pushDb.saveSubscription(me.id, { endpoint: 'https://web.push.apple.com/mine', ...keysOf(mine) })
    await pushDb.saveSubscription(colleague.id, { endpoint: 'https://fcm.googleapis.com/fcm/send/sam', ...keysOf(sams) })
    await pushDb.saveSubscription(colleague.id, { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/gone', ...keysOf(sams) })

    const posts: Array<{ url: string; body: Buffer; headers: Record<string, string> }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      posts.push({ url, body: Buffer.from(init.body as Uint8Array), headers: init.headers as Record<string, string> })
      return new Response(null, { status: url.includes('/gone') ? 410 : 201 })
    })

    const fresh = await land('fresh', inbox.shared!, { from: 'Bob Jones', subject: 'Invoice 42' })
    const round = await nudges.sendPushNudges({ deadline: Date.now() + 20_000 })
    expect(round).toMatchObject({ conversations: 1, people: 2, sent: 2, gone: 1, failed: 0 })

    const toMe = posts.find((p) => p.url.endsWith('/mine'))!
    expect(toMe.headers.Authorization).toMatch(/^vapid t=/)
    expect(mine.open(toMe.body)).toEqual({
      title: 'Bob Jones',
      body: 'Invoice 42 - in Sales',
      href: `/cactus-admin/inbox?tab=unified-inbox&inbox=${inbox.shared}&id=${fresh}`,
      tag: `uin-thread-${fresh}`,
      icon: '/web-app-manifest-512x512.png',
    })
    expect((await pushDb.listSubscriptions()).some((r) => r.endpoint.endsWith('/gone'))).toBe(false)

    // And nothing twice: the next round finds nothing new to claim.
    posts.length = 0
    expect((await nudges.sendPushNudges({ deadline: Date.now() + 20_000 })).conversations).toBe(0)
    expect(posts).toHaveLength(0)
  })

  it('tells nobody about post they may not read', async () => {
    const posts: string[] = []
    vi.stubGlobal('fetch', async (url: string) => { posts.push(url); return new Response(null, { status: 201 }) })
    await land('kits', inbox.privateTeam!)
    const round = await nudges.sendPushNudges({ deadline: Date.now() + 20_000 })
    expect(round).toMatchObject({ conversations: 1, people: 0, sent: 0 })
    expect(posts).toHaveLength(0)
  })

  it('prunes the ledger', async () => {
    expect(await pushDb.pruneNudgeLedger(new Date(Date.now() + MINUTE))).toBeGreaterThan(0)
    expect(await pushDb.pruneNudgeLedger(new Date(Date.now() + MINUTE))).toBe(0)
  })
})
