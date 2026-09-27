import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import type { ExtendedPrismaClient } from '@/lib/db/prisma'
import type { ConversationMessage, ResolvedConversationProvider } from '@/lib/conversations/types'
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
// Texting somebody from an email conversation, executed.
//
// Everything in lib/text-links.ts is raw SQL, and so is the collecting pass
// that reads it: strings to `tsc`, strings to `eslint`, never run by a build.
// So the whole round is run here against a real database - a text sent from an
// email conversation, the channel's copy of it coming back, the customer's
// reply landing on the email conversation, a call from the same number staying
// on the phone one, and the reply being moved back out - with a fake channel
// standing in for the telephony module.
//
// A real throwaway database on the Postgres VPS, built from the core schema and
// this module's own migrations. Named `cactus_rt_*` and dropped afterwards; the
// live site's database sits on the same server and is never named, opened or
// altered.
//
//   RUN_INBOX_TEXT_LINKS=1 npx vitest run \
//     modules/unified-inbox/lib/text-links.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_TEXT_LINKS === '1'
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
const PHONE = '+447700900123'
const MARCUS = 'user-marcus'

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

/** A telephony channel with one conversation, whose messages the test sets. */
function fakeChannel(messages: () => ConversationMessage[]): ResolvedConversationProvider {
  const summary = () => {
    const list = messages()
    const newest = list.reduce((a, m) => (m.sentAt > a ? m.sentAt : a), new Date(0))
    return {
      id: PHONE,
      channel: 'phone' as const,
      subject: `Phone: ${PHONE}`,
      preview: null,
      participant: { name: null, email: null, phone: PHONE },
      lastMessageAt: newest,
      unread: false,
      status: 'open' as const,
      href: 'm/phone',
    }
  }
  return {
    moduleName: 'phone-module',
    id: 'phone-module',
    provider: {
      label: 'Phone',
      channel: 'phone',
      capabilities: { reply: true, markRead: false, byIdentity: false },
      list: async () => ({ items: [summary()] }),
      thread: async () => ({ summary: summary(), messages: messages() }),
    },
  }
}

describe.runIf(shouldRun)('texting from an email conversation, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: typeof import('./db')
  let links: typeof import('./text-links')
  let sync: typeof import('./provider-sync')

  let emailThread = ''
  let personId = ''
  const said: ConversationMessage[] = []
  const channel = fakeChannel(() => said)

  const messagesOn = async (threadId: string) => db.$queryRaw<{
    id: string; direction: string; channel: string; provider_module: string | null
    provider_message_id: string | null; from_phone: string | null; body_text: string | null
  }[]>`
    SELECT "id", "direction", "channel", "provider_module", "provider_message_id", "from_phone", "body_text"
      FROM "uin_messages" WHERE "thread_id" = ${threadId} ORDER BY "sent_at" ASC
  `
  const threadRow = async (id: string) => (await db.$queryRaw<{
    status: string; unread: boolean; message_count: number; preview: string | null
  }[]>`
    SELECT "status", "unread", "message_count", "preview" FROM "uin_threads" WHERE "id" = ${id}
  `)[0]!
  const phoneThread = async () => (await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "uin_threads" WHERE "provider_module" = 'phone-module' AND "external_id" = ${PHONE}
  `)[0]?.id ?? null

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
    database = await createTestDatabase(vps, `cactus_rt_uintxt_${stamp}`, role)
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
    // Twice, because a module's migrations run again on every install that
    // already has them applied as far as a failed build: idempotent or broken.
    await applyFile(path.join(MODULE_MIGRATIONS, '066_text_links.sql'))

    lib = await import('./db')
    links = await import('./text-links')
    sync = await import('./provider-sync')

    const connection = await lib.createConnection({
      label: 'iCloud',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapUsername: 'someone@example.com',
      imapPassword: 'nothing-real',
    })
    const inboxId = (await lib.createInbox({
      name: 'Sales', address: 'sales@deskwell.co.uk', connectionId: connection.id,
    })).id

    await db.$executeRawUnsafe(`INSERT INTO "Role" ("id", "name") VALUES ('role-staff', 'Staff')`)
    await db.$executeRawUnsafe(
      `INSERT INTO "User" ("id", "email", "username", "roleId", "updatedAt")
       VALUES ($1, 'marcus@deskwell.co.uk', 'marcus', 'role-staff', now())`,
      MARCUS,
    )

    personId = await lib.createPerson({ displayName: 'Ada Lovelace', primaryEmail: 'ada@example.com', organisationId: null })
    await lib.addIdentity({ personId, kind: 'phone', value: '020 8138 0512', matchValue: '02081380512', source: 'hand' })
    await lib.addIdentity({ personId, kind: 'phone', value: '07700 900123', matchValue: '07700900123', source: 'hand' })

    emailThread = await lib.createThread({
      inboxId,
      subject: 'Two of the Artisan desks',
      subjectNormalised: 'two of the artisan desks',
      preview: 'Could you deliver on Tuesday?',
      lastMessageAt: new Date('2026-09-20T08:00:00Z'),
      lastDirection: 'in',
      unread: false,
    })
    await db.$executeRaw`UPDATE "uin_threads" SET "person_id" = ${personId} WHERE "id" = ${emailThread}`
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('finds the mobile on the contact card, and not the landline', async () => {
    const thread = await lib.getThreadDetail(emailThread)
    expect(await links.threadTextNumber(thread!, '+44')).toBe(PHONE)
  })

  it('writes a sent text onto the email conversation, where an email reply will not quote it', async () => {
    // A call from them the day before anybody texted: history, and it stays on
    // the phone conversation.
    said.push({
      id: 'call:CA0', direction: 'in', authorName: PHONE, text: 'Missed call', html: null,
      sentAt: new Date('2026-09-19T15:00:00Z'), attachments: [], medium: 'call',
    } as ConversationMessage)

    const since = new Date()
    await links.linkTextsToThread({ phone: PHONE, threadId: emailThread, since, userId: MARCUS })
    const sentAt = new Date(since.getTime() + 500)
    await links.recordSentText({
      threadId: emailThread, phone: PHONE, body: 'Are you in on Tuesday?',
      authorUserId: MARCUS, authorName: 'Marcus', sentAt,
    })

    const rows = await messagesOn(emailThread)
    const text = rows.find((r) => r.channel === 'sms')!
    expect(text).toMatchObject({ direction: 'out', from_phone: PHONE, provider_module: null })
    expect(text.provider_message_id).toMatch(/^uin-out:text:/)

    // An email reply still answers an email: there is none here, so nothing.
    expect(await lib.newestMessageOnThread(emailThread)).toBeNull()

    // The channel's copy of the text comes back a moment later.
    said.push({
      id: 'sms:SM1', direction: 'out', authorName: null, text: 'Are you in on Tuesday?', html: null,
      sentAt: new Date(sentAt.getTime() + 2000), attachments: [], medium: 'text',
    } as ConversationMessage)
  })

  it('files the channel copy against our text and their reply on the email conversation', async () => {
    await lib.setThreadStatus(emailThread, 'done', null)
    said.push({
      id: 'sms:SM2', direction: 'in', authorName: PHONE, text: 'Yes, any time after ten', html: null,
      sentAt: new Date(Date.now() + 5000), attachments: [], medium: 'text',
    } as ConversationMessage)

    await sync.syncProvider(channel)

    const rows = await messagesOn(emailThread)
    const texts = rows.filter((r) => r.channel === 'sms')
    // One of ours, claimed - not two - and their reply.
    expect(texts.map((r) => r.provider_message_id)).toEqual(['sms:SM1', 'sms:SM2'])
    expect(texts.every((r) => r.provider_module === 'phone-module')).toBe(true)
    expect(texts[1]).toMatchObject({ direction: 'in', from_phone: PHONE })

    // It landed as an email would: open again, unread, their words on the row.
    expect(await threadRow(emailThread)).toMatchObject({
      status: 'open', unread: true, preview: 'Yes, any time after ten',
    })

    // The call from before stays on the phone conversation, and nothing else
    // went there.
    const phone = await phoneThread()
    expect(phone).not.toBeNull()
    expect((await messagesOn(phone!)).map((r) => r.provider_message_id)).toEqual(['call:CA0'])

    const link = await links.textLinkFor(PHONE)
    expect(link).toMatchObject({ providerModule: 'phone-module', externalId: PHONE, endedAt: null })
    expect(link!.seenThrough).not.toBeNull()
  })

  it('files nothing twice on the next pass', async () => {
    await sync.syncProvider(channel)
    // And once more with the note's mark cleared, so the conversation is
    // genuinely re-read rather than skipped as settled.
    await db.$executeRaw`UPDATE "uin_text_links" SET "seen_through" = NULL WHERE "phone" = ${PHONE}`
    await sync.syncProvider(channel)

    expect((await messagesOn(emailThread)).filter((r) => r.channel === 'sms')).toHaveLength(2)
    expect(await messagesOn((await phoneThread())!)).toHaveLength(1)
  })

  it('moves a reply out to the phone conversation, and their next text goes there too', async () => {
    const reply = (await messagesOn(emailThread)).find((r) => r.provider_message_id === 'sms:SM2')!
    const message = await links.sideTextForMove(reply.id)
    const link = await links.textLinkFor(PHONE)
    expect(links.moveTextRefusal(message!, link)).toBeNull()

    const { threadId } = await links.moveTextToPhone(message!, link!, MARCUS)
    expect(threadId).toBe(await phoneThread())

    expect((await messagesOn(threadId)).map((r) => r.provider_message_id)).toEqual(['call:CA0', 'sms:SM2'])
    expect((await messagesOn(emailThread)).filter((r) => r.channel === 'sms').map((r) => r.provider_message_id))
      .toEqual(['sms:SM1'])
    expect(await threadRow(threadId)).toMatchObject({ unread: true, message_count: 2 })
    expect((await links.textLinkFor(PHONE))!.endedAt).not.toBeNull()

    said.push({
      id: 'sms:SM3', direction: 'in', authorName: PHONE, text: 'Running late', html: null,
      sentAt: new Date(Date.now() + 10_000), attachments: [], medium: 'text',
    } as ConversationMessage)
    await sync.syncProvider(channel)

    // SM1 stays where it is, SM2 where it was moved, SM3 goes to the phone
    // conversation - and nothing is filed a second time anywhere.
    expect((await messagesOn(threadId)).map((r) => r.provider_message_id))
      .toEqual(['call:CA0', 'sms:SM2', 'sms:SM3'])
    expect((await messagesOn(emailThread)).filter((r) => r.channel === 'sms')).toHaveLength(1)
  })

  it('starts again from now when somebody texts them from the conversation once more', async () => {
    const before = await links.textLinkFor(PHONE)
    const again = new Date()
    await links.linkTextsToThread({ phone: PHONE, threadId: emailThread, since: again, userId: MARCUS })
    const after = await links.textLinkFor(PHONE)
    expect(after!.endedAt).toBeNull()
    expect(after!.since.getTime()).toBeGreaterThan(before!.since.getTime())
  })
})
