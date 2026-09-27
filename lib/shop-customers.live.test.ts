import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
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
// Shop customers into the address book, executed.
//
// Everything this feature does is raw SQL against two modules' tables - the
// shop's `shp_orders`, read by column name, and this module's own people - plus
// a migration that widens a CHECK constraint. tsc sees template strings, eslint
// sees template strings and a build never runs a query, so a misspelt column on
// the shop's side would pass every other gate and fail at the end of a payment.
//
// A real throwaway database on the Postgres VPS, built from the core schema, the
// shop's migrations and this module's own, in order. Named `cactus_rt_*` and
// dropped afterwards; the live site's database sits on the same server and is
// never named, opened or altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_SHOP_CONTACTS=1 npx vitest run \
//     modules/unified-inbox/lib/shop-customers.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_SHOP_CONTACTS === '1'
if (shouldRun) {
  try {
    ;(process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - the guard below fails the suite loudly rather than skipping.
  }
}

const CORE_SCHEMA = path.join(process.cwd(), 'prisma/migrations/20260626000000_init/migration.sql')
const SHOP_MIGRATIONS = path.join(process.cwd(), 'modules/shop/migrations')
const INBOX_MIGRATIONS = path.join(process.cwd(), 'modules/unified-inbox/migrations')

const KEY = 'a'.repeat(64)

const BILLING = {
  firstName: 'Jane',
  lastName: 'Smith',
  line1: '12 High Street',
  line2: 'Unit 4',
  city: 'Leeds',
  county: 'West Yorkshire',
  postcode: 'LS1 1AA',
  country: 'GB',
}

type Sync = typeof import('./shop-customer-sync')
type Observer = typeof import('./order-paid-observer')
type Db = typeof import('./db')

describe.runIf(shouldRun)('shop customers into the address book, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let client: Client
  let sync: Sync
  let observer: Observer
  let lib: Db
  let orderSeq = 0

  async function placeOrder(fields: {
    email: string
    name?: string
    organisation?: string | null
    phone?: string | null
    billing?: Record<string, string> | null
    shipping?: Record<string, string>
  }): Promise<string> {
    orderSeq += 1
    const id = `order-${orderSeq}`
    await client.query(
      `INSERT INTO "shp_orders" (
         "id","order_number","customer_email","customer_name","customer_organisation","customer_phone",
         "shipping_address","billing_address","subtotal","total","tax_mode","payment_method"
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,'10.00','12.00','EXCLUSIVE','SQUARE')`,
      [
        id,
        `TST${String(orderSeq).padStart(6, '0')}`,
        fields.email,
        fields.name ?? 'Jane Smith',
        fields.organisation ?? null,
        fields.phone ?? null,
        JSON.stringify(fields.shipping ?? { ...BILLING, line1: 'Goods In', postcode: 'LS9 9ZZ' }),
        fields.billing === null ? null : JSON.stringify(fields.billing ?? BILLING),
      ],
    )
    return id
  }

  async function personFor(email: string) {
    const { rows } = await client.query(
      `SELECT p.* FROM "uin_people" p
         JOIN "uin_person_identities" i ON i."person_id" = p."id"
        WHERE i."match_value" = $1`,
      [email.toLowerCase()],
    )
    return rows as Record<string, unknown>[]
  }

  async function categoriesOf(personId: unknown): Promise<string[]> {
    const { rows } = await client.query(
      `SELECT c."name" FROM "uin_person_categories" pc
         JOIN "uin_contact_categories" c ON c."id" = pc."category_id"
        WHERE pc."person_id" = $1`,
      [personId],
    )
    // Sorted here rather than in SQL, so the answer does not hang on the
    // server's collation putting capitals first or not.
    return rows.map((r) => r.name as string).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  }

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
    database = await createTestDatabase(vps, `cactus_rt_uinshop_${stamp}`, role)
    process.env.DATABASE_URL = database.connectionUri
    process.env.ENCRYPTION_KEY = KEY

    // libpq's reading of sslmode, as the shop's own live suites connect: the
    // certificate names the database host, not the machine it is reached on.
    client = new Client({ connectionString: `${database.connectionUri}&uselibpqcompat=true` })
    await client.connect()
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')

    // Whole files, as the shop's own live suites apply them: the shop's
    // migrations carry dollar-quoted trigger bodies that a statement splitter
    // would cut in half.
    await client.query(readFileSync(CORE_SCHEMA, 'utf8'))
    for (const dir of [SHOP_MIGRATIONS, INBOX_MIGRATIONS]) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
        await client.query(readFileSync(path.join(dir, file), 'utf8'))
      }
    }

    sync = await import('./shop-customer-sync')
    observer = await import('./order-paid-observer')
    lib = await import('./db')
  }, 600_000)

  afterAll(async () => {
    await import('@/lib/db/prisma')
      .then((module) => module.prisma.$disconnect())
      .catch(() => undefined)
    await client?.end().catch(() => undefined)
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('arrives switched on, on a fresh install and an updated one', async () => {
    expect((await lib.getSettings()).shopCustomerContacts).toBe(true)
  })

  it('files them under a Customers category already there, however it was typed', async () => {
    // Made by hand before the first order, in lower case. The checkout must
    // find it rather than make a second one beside it.
    await lib.createCategory(' customers ')
    const id = await placeOrder({ email: 'first@buyer.co.uk', name: 'First Buyer' })
    expect(await sync.addShopCustomerToContacts(id)).toBe('created')
    const [row] = await personFor('first@buyer.co.uk')
    expect(await categoriesOf(row!.id)).toEqual(['customers'])
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM "uin_contact_categories" WHERE lower(btrim("name")) = 'customers'`,
    )
    expect(rows[0].n).toBe(1)
  })

  it('turns a paid order into a contact with everything the checkout was told', async () => {
    const id = await placeOrder({
      email: 'jane@acme.co.uk',
      organisation: 'Acme Ltd',
      phone: '07700 900123',
    })
    expect(await sync.addShopCustomerToContacts(id)).toBe('created')

    const [row] = await personFor('jane@acme.co.uk')
    expect(row).toMatchObject({
      display_name: 'Jane Smith',
      first_name: 'Jane',
      last_name: 'Smith',
      primary_email: 'jane@acme.co.uk',
      address_line1: '12 High Street',
      address_line2: 'Unit 4',
      address_city: 'Leeds',
      address_county: 'West Yorkshire',
      address_postcode: 'LS1 1AA',
      address_country: 'United Kingdom',
      origin: 'order',
    })

    const { rows: numbers } = await client.query(
      `SELECT "value" FROM "uin_person_identities" WHERE "person_id" = $1 AND "kind" = 'phone'`,
      [row!.id],
    )
    expect(numbers.map((n) => n.value)).toEqual(['07700 900123'])

    const { rows: orgs } = await client.query(
      `SELECT "name", "origin" FROM "uin_organisations" WHERE "id" = $1`,
      [row!.organisation_id],
    )
    expect(orgs[0]).toMatchObject({ name: 'Acme Ltd', origin: 'order' })
    expect(await categoriesOf(row!.id)).toEqual(['customers'])
  })

  it('never makes a second copy of somebody who orders again, nor moves their address', async () => {
    const id = await placeOrder({
      email: 'JANE@acme.co.uk',
      billing: { ...BILLING, line1: '1 New Road', postcode: 'LS2 2BB' },
    })
    expect(await sync.addShopCustomerToContacts(id)).toBe('existing')

    const rows = await personFor('jane@acme.co.uk')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ address_line1: '12 High Street', address_postcode: 'LS1 1AA' })
  })

  it('fills in the blanks on somebody the post already met', async () => {
    const personId = await lib.createPerson({
      displayName: 'marcus.webb',
      primaryEmail: 'marcus@webb-haulage.co.uk',
      organisationId: null,
    })
    await lib.addIdentity({
      personId,
      kind: 'email',
      value: 'marcus@webb-haulage.co.uk',
      matchValue: 'marcus@webb-haulage.co.uk',
      source: 'imap',
    })
    // A label somebody already put on him stays on.
    const supplier = await lib.createCategory('Supplier')
    await lib.addPersonCategories(personId, [supplier])

    const id = await placeOrder({
      email: 'marcus@webb-haulage.co.uk',
      name: 'Marcus Webb',
      organisation: 'Webb Haulage',
      phone: '01904 000111',
      billing: { ...BILLING, firstName: 'Marcus', lastName: 'Webb', city: 'York', postcode: 'YO1 9TL' },
    })
    expect(await sync.addShopCustomerToContacts(id)).toBe('existing')

    const rows = await personFor('marcus@webb-haulage.co.uk')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: personId,
      display_name: 'Marcus Webb',
      first_name: 'Marcus',
      last_name: 'Webb',
      address_city: 'York',
      address_postcode: 'YO1 9TL',
      // Still the post's: where a record came from is not rewritten by a
      // later source filling it in.
      origin: 'mail',
    })
    expect(rows[0]!.organisation_id).not.toBeNull()

    const { rows: numbers } = await client.query(
      `SELECT "value" FROM "uin_person_identities" WHERE "person_id" = $1 AND "kind" = 'phone'`,
      [personId],
    )
    expect(numbers.map((n) => n.value)).toEqual(['01904 000111'])
    expect(await categoriesOf(personId)).toEqual(['customers', 'Supplier'])
  })

  it('leaves a number somebody else already holds where it is', async () => {
    const id = await placeOrder({ email: 'ann@patel.co.uk', name: 'Ann Patel', phone: '07700 900123' })
    expect(await sync.addShopCustomerToContacts(id)).toBe('created')

    const [ann] = await personFor('ann@patel.co.uk')
    expect(ann).toBeDefined()
    const { rows } = await client.query(
      `SELECT p."primary_email" FROM "uin_person_identities" i
         JOIN "uin_people" p ON p."id" = i."person_id"
        WHERE i."value" = '07700 900123'`,
    )
    expect(rows).toEqual([{ primary_email: 'jane@acme.co.uk' }])
  })

  it('never makes a contact of a colleague', async () => {
    await lib.updateSettings({ ownDomains: ['deskwell.test'] })
    const id = await placeOrder({ email: 'tester@deskwell.test', name: 'Test Order' })
    expect(await sync.addShopCustomerToContacts(id)).toBe('colleague')
    expect(await personFor('tester@deskwell.test')).toHaveLength(0)
    await lib.updateSettings({ ownDomains: null })
  })

  it('does nothing at all once switched off', async () => {
    await lib.updateSettings({ shopCustomerContacts: false })
    expect((await lib.getSettings()).shopCustomerContacts).toBe(false)
    const id = await placeOrder({ email: 'nobody@example.org', name: 'No Body' })
    expect(await sync.addShopCustomerToContacts(id)).toBe('switched-off')
    expect(await personFor('nobody@example.org')).toHaveLength(0)
    await lib.updateSettings({ shopCustomerContacts: true })
  })

  it('bills to the delivery address when the order has none of its own, through the observer', async () => {
    const id = await placeOrder({
      email: 'olu@example.org',
      name: 'Olu Adeyemi',
      billing: null,
      shipping: { ...BILLING, firstName: 'Olu', lastName: 'Adeyemi', line1: '3 Mill Lane', postcode: 'M1 1AA', city: 'Manchester' },
    })
    await observer.unifiedInboxOrderPaidObserver({
      orderId: id, orderNumber: 'TST-OBS', paymentMethod: 'SQUARE', clearedManually: false,
    })
    const [row] = await personFor('olu@example.org')
    expect(row).toMatchObject({ first_name: 'Olu', address_line1: '3 Mill Lane', address_city: 'Manchester' })
  })

  it('never throws out of the observer, even for an order that is not there', async () => {
    await expect(observer.unifiedInboxOrderPaidObserver({
      orderId: 'no-such-order', orderNumber: 'TST-NONE', paymentMethod: 'SQUARE', clearedManually: false,
    })).resolves.toBeUndefined()
    expect(await sync.addShopCustomerToContacts('no-such-order')).toBe('no-order')
  })

  it('still refuses an origin nobody defined, now there are four', async () => {
    await expect(
      client.query(`INSERT INTO "uin_people" ("display_name", "origin") VALUES ('Nobody', 'guessed')`),
    ).rejects.toThrow()
  })
})
