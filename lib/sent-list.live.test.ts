import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
// Type only, and the module's own db layer is imported inside beforeAll: the
// shared Prisma client is built the first time it is imported and reads
// DATABASE_URL as it goes, so importing it before the throwaway database exists
// gets a client pointed at nothing at all.
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
// The Sent list's SQL, executed.
//
// Colleague post - one address here writing to another - is filed as INBOUND on
// the person it was addressed to, because that is what it is to them. Without
// the second half of `sentWhere` the sender then watches their own message
// disappear the moment it is delivered, which is a worse bug than the one being
// fixed. That second half is a subquery inside an OR inside a WHERE, and
// nothing else in this repository ever runs it: `tsc` sees a template string,
// `eslint` sees a template string, and a build never executes a query. A
// statement Postgres will not parse passes every standing gate and fails for
// the first time on a live site - which has happened here before, to a subquery
// aliased `both`.
//
// So: a real throwaway database on the Postgres VPS, built from the core schema
// and this module's own migrations, with the real rows and the real functions.
// The database is named `cactus_rt_*` and dropped afterwards; the live site's
// database sits on the same server and is never named, opened or altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network.
// Run it from the core checkout with OVH_SERVER/OVH_USER/OVH_PASSWORD exported
// from the Deskwell workspace .env:
//
//   RUN_INBOX_SENT_GUARDS=1 npx vitest run \
//     modules/unified-inbox/lib/sent-list.live.test.ts --testTimeout 120000
//
// Deliberately not a script in core's package.json: core's tracked files ship to
// every install, and naming a module in one of them is the leak the module rules
// are about. A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_SENT_GUARDS === '1'
if (shouldRun) {
  try {
    ;(process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - the guard below fails the suite loudly rather than skipping.
  }
}

const CORE_SCHEMA = path.join(process.cwd(), 'prisma/migrations/20260626000000_init/migration.sql')
const MODULE_MIGRATIONS = path.join(process.cwd(), 'modules/unified-inbox/migrations')

/** Any 64-character value will do: nothing here is encrypted, but createInbox
 *  reaches for the key regardless. */
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

describe.runIf(shouldRun)('the Sent list against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db

  let chrisInbox = ''
  let emmaInbox = ''
  let salesInbox = ''
  const chris = 'user-chris'
  const emma = 'user-emma'
  let connectionId = ''

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
    database = await createTestDatabase(vps, `cactus_rt_uinsent_${stamp}`, role)
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

    lib = await import('./db')

    const connection = await lib.createConnection({
      label: 'iCloud',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapUsername: 'someone@example.com',
      imapPassword: 'nothing-real',
    })
    connectionId = connection.id
    // The two staff accounts first: an individual inbox has an owner, and the
    // owner is a foreign key.
    await db.$executeRawUnsafe(`INSERT INTO "Role" ("id", "name") VALUES ('role-staff', 'Staff')`)
    for (const [id, email, username] of [
      [chris, 'chris@deskwell.co.uk', 'chris'],
      [emma, 'emma@deskwell.co.uk', 'emma'],
    ]) {
      await db.$executeRawUnsafe(
        `INSERT INTO "User" ("id", "email", "username", "roleId", "updatedAt")
         VALUES ($1, $2, $3, 'role-staff', now())`,
        id, email, username,
      )
    }

    // Two people's own addresses and one the business owns. The kinds matter to
    // every case below: a message nobody is recorded as having written is its
    // sender's when it left an address that is one person's alone, and the
    // address's own when it left a shared one.
    chrisInbox = (await lib.createInbox({
      name: 'Chris', address: 'chris@deskwell.co.uk', connectionId,
      kind: 'individual', ownerUserId: chris,
    })).id
    emmaInbox = (await lib.createInbox({
      name: 'Emma', address: 'emma@deskwell.co.uk', connectionId,
      kind: 'individual', ownerUserId: emma,
    })).id
    salesInbox = (await lib.createInbox({
      name: 'Sales', address: 'sales@deskwell.co.uk', connectionId,
    })).id

    // What the sync now files for a colleague message: inbound, on the
    // recipient's thread, from an address this site serves.
    const colleagueThread = await lib.createThread({
      inboxId: emmaInbox,
      subject: 'test',
      subjectNormalised: 'test',
      preview: 'just reply to let me know you got this',
      lastMessageAt: new Date('2026-09-02T19:49:14Z'),
      lastDirection: 'in',
      unread: true,
    })
    await lib.insertMessage({
      threadId: colleagueThread,
      connectionId,
      direction: 'in',
      messageIdHeader: 'colleague@deskwell.co.uk',
      inReplyTo: null,
      references: [],
      fromName: 'Chris',
      fromAddress: 'chris@deskwell.co.uk',
      replyTo: null,
      toAddresses: ['emma@deskwell.co.uk'],
      ccAddresses: [],
      subject: 'test',
      bodyText: 'just reply to let me know you got this',
      bodyHtml: null,
      snippet: 'just reply to let me know you got this',
      sentAt: new Date('2026-09-02T19:49:14Z'),
      hasAttachments: false,
      sizeBytes: 100,
      imapFolder: 'Deskwell/Emma Scott',
      imapUid: 1,
      threadMatch: 'new',
      routedOn: 'to',
      autoKind: null,
    })

    // The same message twice, which is how mail between two of our own addresses
    // is filed: the row the send path wrote on the sender's thread, and the copy
    // the mail server handed back, filed on the person it was addressed to. The
    // relay stamped its own id on the way out, so the delivered copy's
    // Message-ID is the outbound row's provider_message_id - which is the only
    // thing tying the two together.
    const pairThread = await lib.createThread({
      inboxId: chrisInbox,
      subject: 'Said once',
      subjectNormalised: 'said once',
      preview: 'only one of these is a thing I sent',
      lastMessageAt: new Date('2026-09-04T09:00:00Z'),
      lastDirection: 'out',
      unread: false,
    })
    await db.$executeRawUnsafe(
      `INSERT INTO "uin_messages"
         ("thread_id", "inbox_id", "direction", "channel", "message_id_header",
          "provider_message_id", "from_address", "to_addresses", "subject", "snippet",
          "sent_at", "author_user_id")
       VALUES ($1, $2, 'out', 'email', 'uin.said-once@deskwell.co.uk',
               'relay-said-once@smtp-relay.sendinblue.com', 'chris@deskwell.co.uk',
               ARRAY['emma@deskwell.co.uk']::text[], 'Said once', 'only one of these',
               TIMESTAMP '2026-09-04 09:00:00', $3)`,
      pairThread,
      chrisInbox,
      chris,
    )
    const deliveredThread = await lib.createThread({
      inboxId: emmaInbox,
      subject: 'Said once',
      subjectNormalised: 'said once',
      preview: 'only one of these is a thing I sent',
      lastMessageAt: new Date('2026-09-04T09:00:00Z'),
      lastDirection: 'in',
      unread: true,
    })
    await lib.insertMessage({
      threadId: deliveredThread,
      connectionId,
      direction: 'in',
      messageIdHeader: 'relay-said-once@smtp-relay.sendinblue.com',
      inReplyTo: null,
      references: [],
      fromName: 'Chris',
      fromAddress: 'chris@deskwell.co.uk',
      replyTo: null,
      toAddresses: ['emma@deskwell.co.uk'],
      ccAddresses: [],
      subject: 'Said once',
      bodyText: 'only one of these is a thing I sent',
      bodyHtml: null,
      snippet: 'only one of these is a thing I sent',
      sentAt: new Date('2026-09-04T09:00:00Z'),
      hasAttachments: false,
      sizeBytes: 100,
      imapFolder: 'Deskwell/Emma Scott',
      imapUid: 3,
      threadMatch: 'new',
      routedOn: 'to',
      autoKind: null,
    })

    // An ordinary customer conversation on Emma's inbox, so the customer's own
    // message can be proved NOT to reach anybody's Sent list.
    const customerThread = await lib.createThread({
      inboxId: emmaInbox,
      subject: 'A quote please',
      subjectNormalised: 'a quote please',
      preview: 'can you price this up',
      lastMessageAt: new Date('2026-09-01T09:00:00Z'),
      lastDirection: 'in',
      unread: true,
    })
    await lib.insertMessage({
      threadId: customerThread,
      connectionId,
      direction: 'in',
      messageIdHeader: 'customer@example.com',
      inReplyTo: null,
      references: [],
      fromName: 'A customer',
      fromAddress: 'customer@example.com',
      replyTo: null,
      toAddresses: ['emma@deskwell.co.uk'],
      ccAddresses: [],
      subject: 'A quote please',
      bodyText: 'can you price this up',
      bodyHtml: null,
      snippet: 'can you price this up',
      sentAt: new Date('2026-09-01T09:00:00Z'),
      hasAttachments: false,
      sizeBytes: 100,
      imapFolder: 'Deskwell/Emma Scott',
      imapUid: 2,
      threadMatch: 'new',
      routedOn: 'to',
      autoKind: null,
    })

    // And Emma's reply to that customer: ordinary outbound, collected off the
    // mail server rather than typed here, so no author is recorded. It went out
    // as an address that is Emma's alone, which is what makes it hers.
    await db.$executeRawUnsafe(
      `INSERT INTO "uin_messages"
         ("thread_id", "inbox_id", "direction", "channel", "message_id_header", "from_address",
          "to_addresses", "subject", "snippet", "sent_at")
       VALUES ($1, $2, 'out', 'email', 'reply@deskwell.co.uk', 'emma@deskwell.co.uk',
               ARRAY['customer@example.com']::text[], 'Re: A quote please', 'here you are',
               TIMESTAMP '2026-09-01 10:00:00')`,
      customerThread,
      emmaInbox,
    )

    // The shared address, and the whole point of the two folders. Somebody asks
    // sales@ for a price; Chris answers it from this hub, so the row carries him
    // as its author; and the site's own order confirmation leaves the same
    // address with no author at all, because no person typed it.
    const salesThread = await lib.createThread({
      inboxId: salesInbox,
      subject: 'Ten chairs',
      subjectNormalised: 'ten chairs',
      preview: 'what would ten of these cost',
      lastMessageAt: new Date('2026-09-03T09:00:00Z'),
      lastDirection: 'in',
      unread: true,
    })
    await db.$executeRawUnsafe(
      `INSERT INTO "uin_messages"
         ("thread_id", "inbox_id", "direction", "channel", "message_id_header", "from_address",
          "to_addresses", "subject", "snippet", "sent_at", "author_user_id")
       VALUES ($1, $2, 'out', 'email', 'chris-on-sales@deskwell.co.uk', 'sales@deskwell.co.uk',
               ARRAY['buyer@example.com']::text[], 'Re: Ten chairs', 'here is the price',
               TIMESTAMP '2026-09-03 10:00:00', $3),
              ($1, $2, 'out', 'email', 'order@deskwell.co.uk', 'sales@deskwell.co.uk',
               ARRAY['buyer@example.com']::text[], 'Your order', 'thank you for your order',
               TIMESTAMP '2026-09-03 11:00:00', NULL)`,
      salesThread,
      salesInbox,
      chris,
    )
    // One draft on each address, and one on no address at all - the half-written
    // answer to a chat, which belongs to its author rather than to a folder.
    for (const [author, inboxId, subject] of [
      [chris, chrisInbox, 'Half-written, from Chris'],
      [emma, emmaInbox, 'Half-written, from Emma'],
      [chris, null, 'Half-written, filed nowhere'],
    ] as Array<[string, string | null, string]>) {
      await lib.saveDraft({
        authorUserId: author,
        inboxId,
        threadId: null,
        mode: 'new',
        to: ['someone@example.com'],
        cc: [],
        subject,
        body: 'not finished',
        attachments: [],
      })
    }
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('keeps the sender their copy of a message that was delivered to a colleague', async () => {
    // Chris may read his own address and nothing else. The message he wrote is
    // sitting inbound on Emma's thread, and it is still his to see.
    const rows = await lib.listSentMessages([chrisInbox], false, [], 1, 25)
    expect(rows.map((r) => r.subject)).toEqual(['Said once', 'test'])
    expect(rows.find((r) => r.subject === 'test')?.toAddresses).toEqual(['emma@deskwell.co.uk'])
    expect(await lib.countSentMessages([chrisInbox], false, [])).toBe(2)
  })

  it('labels it with the address it went out as, not the inbox it landed in', async () => {
    const rows = await lib.listSentMessages([chrisInbox], false, [], 1, 25)
    expect(rows.find((r) => r.subject === 'test')?.inboxId).toBe(chrisInbox)
  })

  it('lists a message sent to a colleague ONCE, not as both copies of it', async () => {
    // The row the send path wrote and the copy the mail server handed back are
    // one message said one time. Without this the sender saw the pair, a second
    // apart, saying the same words to the same person.
    const rows = await lib.listSentMessages([chrisInbox, emmaInbox], false, [], 1, 25)
    expect(rows.filter((r) => r.subject === 'Said once')).toHaveLength(1)
    // And it is the SENDER's own copy that survives - the one the send path
    // wrote, which is the only one carrying an author - so opening it lands on
    // their conversation rather than on the one it was delivered into.
    const kept = rows.find((r) => r.subject === 'Said once')
    expect(kept?.authorUserId).toBe(chris)
    expect(kept?.inboxId).toBe(chrisInbox)
  })

  it('keeps a message that was ONLY ever the delivered copy', async () => {
    // Nothing here wrote a row for it - it was written on a phone, or in
    // Outlook - so there is no twin to fold it into, and dropping it would lose
    // the sender their own message. This is the case the clause above exists for.
    const rows = await lib.listSentMessages([chrisInbox], false, [], 1, 25)
    expect(rows.map((r) => r.subject)).toContain('test')
  })

  it('still lists ordinary outbound mail, and only that, for the sender of it', async () => {
    const rows = await lib.listSentMessages([emmaInbox], false, [], 1, 25)
    // Emma's reply to the customer. The customer's own message is inbound from
    // an address this site does not serve, so it is not on anybody's Sent list,
    // and the colleague message is Chris's rather than hers.
    expect(rows.map((r) => r.subject)).toEqual(['Re: A quote please'])
    expect(await lib.countSentMessages([emmaInbox], false, [])).toBe(1)
  })

  it('shows both to somebody who may read both addresses', async () => {
    const rows = await lib.listSentMessages([chrisInbox, emmaInbox], false, [], 1, 25)
    // Newest first, so the colleague message of 2 September comes before the
    // customer reply of the 1st, and the pair of the 4th before either.
    expect(rows.map((r) => r.subject)).toEqual(['Said once', 'test', 'Re: A quote please'])
    expect(await lib.countSentMessages([chrisInbox, emmaInbox], false, [])).toBe(3)
  })

  it('lists nothing at all for somebody with no addresses', async () => {
    expect(await lib.listSentMessages([], false, [], 1, 25)).toEqual([])
    expect(await lib.countSentMessages([], false, [])).toBe(0)
  })

  it('runs the unrouted-only shape of the query, which has no inbox ids in it', async () => {
    // An administrator sees unfiled mail as well. The clause is built
    // differently in that case and has to parse too.
    expect(await lib.countSentMessages([], true, [])).toBe(0)
  })

  // The folder under Yours, which is a PERSON's rather than an address's. Same
  // rows, one more clause, and it is a clause with a subquery inside an OR
  // inside an AND - the shape that has failed to parse on a live site before.
  describe('somebody\u2019s own Sent folder', () => {
    /** What Chris sees under Yours: he may read all three addresses. */
    const chrisSees = () => lib.listSentMessages(
      [chrisInbox, emmaInbox, salesInbox], false, [], 1, 25, chris,
    )

    it('leaves a colleague\u2019s writing out, on an address they both read', async () => {
      const rows = await chrisSees()
      // The colleague message he wrote, and his own reply from the shared
      // address. Not Emma's reply to the customer, which is hers, and not the
      // order confirmation, which nobody typed.
      expect(rows.map((r) => r.subject)).toEqual(['Said once', 'Re: Ten chairs', 'test'])
      expect(await lib.countSentMessages(
        [chrisInbox, emmaInbox, salesInbox], false, [], chris,
      )).toBe(3)
    })

    it('keeps what somebody sent from a SHARED address', async () => {
      // The half no address could answer: sales@ is nobody's, so the only thing
      // that makes this reply Chris's is that the row says he wrote it.
      const rows = await chrisSees()
      expect(rows.find((r) => r.subject === 'Re: Ten chairs')?.inboxId).toBe(salesInbox)
    })

    it('keeps mail collected off the server that left their own address', async () => {
      // Nothing in a mailbox records who typed a message, so Emma's reply has no
      // author. It went out as an address that is hers alone, and it is hers.
      const rows = await lib.listSentMessages(
        [chrisInbox, emmaInbox, salesInbox], false, [], 1, 25, emma,
      )
      expect(rows.map((r) => r.subject)).toEqual(['Re: A quote please'])
      expect(await lib.countSentMessages(
        [chrisInbox, emmaInbox, salesInbox], false, [], emma,
      )).toBe(1)
    })

    it('leaves out mail a module sent on its own', async () => {
      // The order confirmation left sales@ with no author. It belongs to the
      // address rather than to a person, so it is in nobody's own folder.
      for (const who of [chris, emma]) {
        const rows = await lib.listSentMessages(
          [chrisInbox, emmaInbox, salesInbox], false, [], 1, 25, who,
        )
        expect(rows.map((r) => r.subject)).not.toContain('Your order')
      }
    })

    it('still holds the address\u2019s own folder to everything that left it', async () => {
      // The other half of the pair, and the reason the module mail is not lost:
      // the folder hanging under sales@ on the rail, which names one address and
      // nobody at all.
      const rows = await lib.listSentMessages([salesInbox], false, [], 1, 25)
      expect(rows.map((r) => r.subject)).toEqual(['Your order', 'Re: Ten chairs'])
      expect(await lib.countSentMessages([salesInbox], false, [])).toBe(2)
    })

    it('lists nothing for somebody who wrote nothing', async () => {
      expect(await lib.listSentMessages(
        [chrisInbox, emmaInbox, salesInbox], false, [], 1, 25, 'user-nobody',
      )).toEqual([])
      expect(await lib.countSentMessages(
        [chrisInbox, emmaInbox, salesInbox], false, [], 'user-nobody',
      )).toBe(0)
    })

    it('runs the unrouted-only shape with the author clause on it too', async () => {
      // No inbox ids at all, which builds the WHERE a different way, with the
      // person's clause ANDed onto it.
      expect(await lib.countSentMessages([], true, [], chris)).toBe(0)
    })
  })

  // The Drafts folder has two shapes - every one of this person's, or narrowed
  // to the address a folder names - and both are raw SQL that nothing else
  // runs. What they must never do is reach a colleague's, which is what the
  // shared-address cases below are here to hold down.
  describe('the drafts folder', () => {
    it('lists this person\u2019s own, filed and unfiled, and nobody else\u2019s', async () => {
      const rows = await lib.listDrafts(chris)
      expect(rows.map((r) => r.subject).sort()).toEqual([
        'Half-written, filed nowhere',
        'Half-written, from Chris',
      ])
      expect(await lib.countDrafts(chris)).toBe(2)
    })

    it('leaves a colleague\u2019s draft out even on an address both can read', async () => {
      // Emma may read chris@ and does not get what Chris left half-written on
      // it. Half-written text is not something a shared address shares.
      const rows = await lib.listDrafts(emma)
      expect(rows.map((r) => r.subject)).toEqual(['Half-written, from Emma'])
      expect(await lib.countDrafts(emma)).toBe(1)
    })

    it('narrows to one address, and still only to this person\u2019s own', async () => {
      expect(await lib.countDrafts(chris, [chrisInbox])).toBe(1)
      // Emma's is filed on emma@, which Chris may read - and it stays hers.
      expect(await lib.listDrafts(chris, [emmaInbox])).toEqual([])
      // Narrowing to an address leaves out the one filed on no address at all.
      expect(await lib.countDrafts(chris, [chrisInbox, emmaInbox])).toBe(1)
    })

    it('counts them per address, this person\u2019s own only, unfiled ones left out', async () => {
      // What the rail asks before it decides whether the folder under a
      // colleague's name exists at all. Chris has one on chris@ and one filed
      // nowhere: the second has no folder to appear under, so it is not here.
      // Emma's, on an address Chris may read, is hers and stays out of his.
      expect(await lib.countDraftsByInbox(chris)).toEqual({ [chrisInbox]: 1 })
      expect(await lib.countDraftsByInbox(emma)).toEqual({ [emmaInbox]: 1 })
      // Nobody's drafts, and a GROUP BY that returns no rows at all - the shape
      // the rail sees on a site where nothing has been half-written.
      expect(await lib.countDraftsByInbox('user-nobody')).toEqual({})
    })

    it('lists nothing at all when the list of addresses is empty', async () => {
      expect(await lib.listDrafts(chris, [])).toEqual([])
      expect(await lib.countDrafts(chris, [])).toBe(0)
    })

    it('hands one back by id to its author, and to nobody else', async () => {
      const mine = (await lib.listDrafts(chris)).find((d) => d.inboxId === chrisInbox)!
      expect((await lib.getDraft(mine.id, chris))?.subject).toBe('Half-written, from Chris')
      expect(await lib.getDraft(mine.id, emma)).toBeNull()
    })
  })

  // The Scheduled folder: the same table, split the other side of a line that
  // only SQL draws. Every case here is a query nothing else in the suite runs,
  // and the split is the sort that a typecheck cannot see - `send_state` is
  // NULL on every ordinary draft, and one careless NOT ... IN would empty the
  // Drafts folder on every site in the world while staying perfectly green.
  describe('the scheduled folder', () => {
    /** Somebody's message with a time on it. Written through saveDraft, which is
     *  the only thing that ever writes one. */
    const schedule = async (
      author: string,
      inboxId: string | null,
      subject: string,
      sendAt: Date,
    ): Promise<string> => {
      const draft = await lib.saveDraft({
        authorUserId: author,
        inboxId,
        threadId: null,
        mode: 'new',
        to: ['someone@example.com'],
        cc: [],
        subject,
        body: 'written now, going later',
        attachments: [],
        sendAt,
      })
      return draft.id
    }

    let mondayId = ''
    let fridayId = ''

    beforeAll(async () => {
      fridayId = await schedule(chris, chrisInbox, 'Going out Friday', new Date('2026-10-02T08:00:00Z'))
      mondayId = await schedule(chris, chrisInbox, 'Going out Monday', new Date('2026-09-28T08:00:00Z'))
      await schedule(emma, emmaInbox, 'Emma\u2019s Monday', new Date('2026-09-28T09:00:00Z'))
    })

    it('takes a message with a time on it out of Drafts altogether', async () => {
      // The three half-written ones are still there and the scheduled ones are
      // not, which is the whole of the change: a Drafts count that included
      // them read as work outstanding when it was work already decided.
      const rows = await lib.listDrafts(chris)
      expect(rows.map((r) => r.subject).sort()).toEqual([
        'Half-written, filed nowhere',
        'Half-written, from Chris',
      ])
      expect(await lib.countDrafts(chris)).toBe(2)
      expect(await lib.countDraftsByInbox(chris)).toEqual({ [chrisInbox]: 1 })
    })

    it('lists them soonest first, this person\u2019s own and nobody else\u2019s', async () => {
      const rows = await lib.listScheduledDrafts(chris)
      // By when they leave rather than when they were last touched: Friday's
      // was written first and goes second.
      expect(rows.map((r) => r.subject)).toEqual(['Going out Monday', 'Going out Friday'])
      expect(await lib.countScheduledDrafts(chris)).toBe(2)
      expect((await lib.listScheduledDrafts(emma)).map((r) => r.subject)).toEqual(['Emma\u2019s Monday'])
      expect(await lib.countScheduledDrafts(emma)).toBe(1)
      expect(await lib.countScheduledDrafts('user-nobody')).toBe(0)
    })

    it('narrows to one address the same way the drafts folder does', async () => {
      expect(await lib.countScheduledDrafts(chris, [chrisInbox])).toBe(2)
      // Emma's is on emma@, which Chris may read, and it stays hers.
      expect(await lib.listScheduledDrafts(chris, [emmaInbox])).toEqual([])
      expect(await lib.listScheduledDrafts(chris, [])).toEqual([])
    })

    it('puts one whose send was refused back under Drafts, not here', async () => {
      // It is not going anywhere on its own any more, and it wants somebody to
      // look at it - so it belongs in the list people open, with its reason on
      // it, rather than in a folder of things that are still going to happen.
      await db.$executeRawUnsafe(
        `UPDATE "uin_drafts" SET "send_state" = 'failed', "send_error" = 'the server said no' WHERE "id" = $1`,
        fridayId,
      )
      expect((await lib.listDrafts(chris)).map((r) => r.subject)).toContain('Going out Friday')
      expect(await lib.countDrafts(chris)).toBe(3)
      expect((await lib.listScheduledDrafts(chris)).map((r) => r.subject)).toEqual(['Going out Monday'])
      // And back where it was, so the cases below start from a known shape.
      await db.$executeRawUnsafe(
        `UPDATE "uin_drafts" SET "send_state" = 'scheduled', "send_error" = NULL WHERE "id" = $1`,
        fridayId,
      )
    })

    it('takes the timer off for a send by hand, and puts the row back in Drafts', async () => {
      expect(await lib.standDownScheduledDraft(mondayId, chris)).toBe('ready')
      const back = await lib.getDraft(mondayId, chris)
      expect(back?.sendAt).toBeNull()
      expect(back?.sendState).toBeNull()
      expect((await lib.listDrafts(chris)).map((r) => r.subject)).toContain('Going out Monday')
      expect((await lib.listScheduledDrafts(chris)).map((r) => r.subject)).toEqual(['Going out Friday'])
    })

    it('refuses to stand down one a run is posting this second', async () => {
      // The one case that matters: the queue has claimed it and is talking to a
      // mail server. Clearing the state here would let Send now post the same
      // message a second time, under a different idempotency key.
      await db.$executeRawUnsafe(
        `UPDATE "uin_drafts" SET "send_state" = 'sending', "claimed_at" = now() WHERE "id" = $1`,
        fridayId,
      )
      expect(await lib.standDownScheduledDraft(fridayId, chris)).toBe('in-flight')
      // And it is left exactly as the run left it.
      expect((await lib.getDraft(fridayId, chris))?.sendState).toBe('sending')
    })

    it('leaves a colleague\u2019s scheduled message alone', async () => {
      const hers = (await lib.listScheduledDrafts(emma))[0]!
      expect(await lib.standDownScheduledDraft(hers.id, chris)).toBe('ready')
      // "ready" because there is nothing of Chris's by that id to stand down -
      // and the row itself is untouched, which is the half worth proving.
      expect((await lib.getDraft(hers.id, emma))?.sendState).toBe('scheduled')
    })
  })
})
