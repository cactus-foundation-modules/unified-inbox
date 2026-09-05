import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
// Type only, and the module's own db layer is imported inside beforeAll: the
// shared Prisma client is built the first time it is imported and reads
// DATABASE_URL as it goes.
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
// The address book, executed.
//
// `migrations/025_contacts.sql` and everything that reads or writes the columns
// it adds are raw SQL, and nothing else in this repository runs them: tsc sees
// a template string, eslint sees a template string, and a build never executes
// a query. Two things here would pass every other gate and fail in front of a
// customer - the CHECK constraint on `origin`, and the ORDER BY that a contacts
// list is nothing without.
//
// A real throwaway database on the Postgres VPS, built from the core schema and
// this module's own migrations, in order. Named `cactus_rt_*` and dropped
// afterwards; the live site's database sits on the same server and is never
// named, opened or altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_CONTACTS=1 npx vitest run \
//     modules/unified-inbox/lib/contacts.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_CONTACTS === '1'
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
type Store = typeof import('./contact-store')

describe.runIf(shouldRun)('the address book, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db
  let store: Store

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
    database = await createTestDatabase(vps, `cactus_rt_uincon_${stamp}`, role)
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
    store = await import('./contact-store')
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('holds every field a card has, and gives them all back', async () => {
    const id = await lib.createPerson({
      displayName: 'Jane Smith',
      primaryEmail: 'jane@acme.co.uk',
      organisationId: null,
      notes: 'Rings on Fridays.',
      origin: 'hand',
      details: {
        firstName: 'Jane',
        lastName: 'Smith',
        jobTitle: 'Buyer',
        website: 'https://acme.co.uk',
        addressLine1: '12 High Street',
        addressLine2: 'Unit 4',
        addressCity: 'Leeds',
        addressCounty: 'West Yorkshire',
        addressPostcode: 'LS1 1AA',
        addressCountry: 'United Kingdom',
      },
    })
    const person = await lib.getPerson(id)
    expect(person).toMatchObject({
      firstName: 'Jane',
      lastName: 'Smith',
      jobTitle: 'Buyer',
      website: 'https://acme.co.uk',
      addressLine1: '12 High Street',
      addressLine2: 'Unit 4',
      addressCity: 'Leeds',
      addressCounty: 'West Yorkshire',
      addressPostcode: 'LS1 1AA',
      addressCountry: 'United Kingdom',
      origin: 'hand',
      notes: 'Rings on Fridays.',
    })
  })

  it('refuses an origin nobody defined', async () => {
    // The CHECK is the claim. Nothing else in the codebase would ever run it,
    // and a typo'd origin would otherwise sit in the column for ever.
    await expect(
      db.$executeRawUnsafe(`INSERT INTO "uin_people" ("display_name", "origin") VALUES ('Nobody', 'guessed')`),
    ).rejects.toThrow()
  })

  it('changes one field and leaves the other twelve alone', async () => {
    const id = await lib.createPerson({
      displayName: 'Marcus Webb',
      primaryEmail: 'marcus@example.com',
      organisationId: null,
      details: { firstName: 'Marcus', lastName: 'Webb', addressPostcode: 'YO1 9TL' },
    })
    await lib.updatePerson(id, { jobTitle: 'Warehouse' })
    expect(await lib.getPerson(id)).toMatchObject({
      firstName: 'Marcus',
      lastName: 'Webb',
      jobTitle: 'Warehouse',
      addressPostcode: 'YO1 9TL',
    })
  })

  it('clears a field that is set to null, which is not the same as leaving it out', async () => {
    const id = await lib.createPerson({
      displayName: 'Ann Patel',
      primaryEmail: null,
      organisationId: null,
      details: { firstName: 'Ann', lastName: 'Patel', jobTitle: 'Accounts' },
    })
    await lib.updatePerson(id, { jobTitle: null })
    expect((await lib.getPerson(id))?.jobTitle).toBeNull()
  })

  it('orders the list by surname, with the nameless last', async () => {
    // A contacts list that opens on twenty blanks looks broken, and the ones
    // with no name yet are the ones nobody is looking for.
    await lib.createPerson({
      displayName: 'sales@nowhere.test',
      primaryEmail: 'sales@nowhere.test',
      organisationId: null,
    })
    const { rows } = await lib.listPeople({ page: 1, perPage: 50, sort: 'name' })
    const surnames = rows.map((r) => r.lastName)
    expect(surnames.slice(0, 3)).toEqual(['Patel', 'Smith', 'Webb'])
    expect(surnames[surnames.length - 1]).toBeNull()
  })

  it('searches a postcode, a job title and a surname', async () => {
    expect((await lib.listPeople({ search: 'LS1 1AA', page: 1, perPage: 20 })).total).toBe(1)
    expect((await lib.listPeople({ search: 'warehouse', page: 1, perPage: 20 })).total).toBe(1)
    expect((await lib.listPeople({ search: 'patel', page: 1, perPage: 20 })).total).toBe(1)
  })

  it('counts the contacts, and never the merged-away', async () => {
    const before = (await lib.peopleCount()).people
    const ghost = await lib.createPerson({ displayName: 'A Ghost', primaryEmail: null, organisationId: null })
    await db.$executeRawUnsafe(
      `UPDATE "uin_people" SET "merged_into_id" = (SELECT "id" FROM "uin_people" WHERE "display_name" = 'Jane Smith') WHERE "id" = $1`,
      ghost,
    )
    expect((await lib.peopleCount()).people).toBe(before)
  })

  it('matches an organisation on its name however it was typed', async () => {
    const id = await lib.createOrganisation({
      name: 'Acme Ltd',
      domain: 'acme.co.uk',
      phone: '0113 496 0000',
      addressPostcode: 'LS1 1AA',
      origin: 'hand',
    })
    expect((await lib.findOrganisationByName('  acme ltd  '))?.id).toBe(id)
    expect(await lib.findOrganisationByName('Acme Limited')).toBeNull()
    expect(await lib.getOrganisation(id)).toMatchObject({
      domain: 'acme.co.uk', phone: '0113 496 0000', addressPostcode: 'LS1 1AA', origin: 'hand',
    })
    expect((await lib.peopleCount()).organisations).toBe(1)
  })

  it('lists organisations with how many contacts are in each', async () => {
    const acme = (await lib.findOrganisationByName('Acme Ltd'))!
    const jane = (await lib.listPeople({ search: 'smith', page: 1, perPage: 5 })).rows[0]!
    await lib.updatePerson(jane.id, { organisationId: acme.id })

    const { rows } = await lib.listOrganisations({ page: 1, perPage: 20 })
    expect(rows[0]).toMatchObject({ name: 'Acme Ltd', peopleCount: 1 })
    expect((await lib.listPeople({ page: 1, perPage: 20, organisationId: acme.id })).total).toBe(1)
  })

  it('keeps everybody when an organisation is removed', async () => {
    const acme = (await lib.findOrganisationByName('Acme Ltd'))!
    await lib.deleteOrganisation(acme.id)
    const jane = (await lib.listPeople({ search: 'smith', page: 1, perPage: 5 })).rows[0]!
    expect(jane.organisationId).toBeNull()
    expect(jane.displayName).toBe('Jane Smith')
  })

  it('leaves an address with whoever already holds it', async () => {
    const jane = (await lib.listPeople({ search: 'smith', page: 1, perPage: 5 })).rows[0]!
    const marcus = (await lib.listPeople({ search: 'webb', page: 1, perPage: 5 })).rows[0]!
    expect(await lib.addIdentity({
      personId: jane.id, kind: 'email', value: 'jane@acme.co.uk',
      matchValue: 'jane@acme.co.uk', source: 'manual',
    })).toBe(true)
    expect(await lib.addIdentity({
      personId: marcus.id, kind: 'email', value: 'jane@acme.co.uk',
      matchValue: 'jane@acme.co.uk', source: 'manual',
    })).toBe(false)
    expect(await lib.findPersonByIdentity(['jane@acme.co.uk'])).toBe(jane.id)
  })

  it('will not let one contact take an address off another', async () => {
    const jane = (await lib.listPeople({ search: 'smith', page: 1, perPage: 5 })).rows[0]!
    const marcus = (await lib.listPeople({ search: 'webb', page: 1, perPage: 5 })).rows[0]!
    const identity = (await lib.listIdentities(jane.id))[0]!
    expect(await lib.deleteIdentityForPerson(marcus.id, identity.id)).toBe(false)
    expect(await lib.deleteIdentityForPerson(jane.id, identity.id)).toBe(true)
  })

  it('tells no conversations apart from none this reader may see', async () => {
    const jane = (await lib.listPeople({ search: 'smith', page: 1, perPage: 5 })).rows[0]!
    expect(await lib.countThreadsForPerson(jane.id)).toBe(0)
  })

  it('saves a card, creating the organisation it names', async () => {
    const { personId, refused } = await store.saveContact(null, {
      firstName: 'Priya',
      lastName: 'Raman',
      organisation: 'Bramble Joinery',
      email: 'priya@bramble.test',
      phone: '0113 496 1111',
      addressPostcode: 'BD1 2AA',
    }, { origin: 'hand' })
    expect(refused).toEqual([])
    const person = await lib.getPerson(personId)
    expect(person).toMatchObject({ displayName: 'Priya Raman', organisationName: 'Bramble Joinery' })
    const identities = await lib.listIdentities(personId)
    expect(identities.map((i) => i.kind).sort()).toEqual(['email', 'phone'])
  })

  it('reports an address that belongs to somebody else rather than moving it', async () => {
    const { refused } = await store.saveContact(null, {
      firstName: 'Someone',
      lastName: 'Else',
      email: 'priya@bramble.test',
    }, { origin: 'hand' })
    expect(refused).toEqual(['priya@bramble.test'])
  })

  it('imports a file, matching one organisation once', async () => {
    const summary = await store.importContacts(
      [
        ['Ade Fox', 'Cobble Supplies', 'ade@cobble.test', '0113 496 2222', 'HD1 3BB'],
        ['Bea Nolan', 'cobble supplies', 'bea@cobble.test', '', 'HD1 3BB'],
        ['', '', '', '', 'United Kingdom'],
      ],
      ['fullName', 'organisation', 'email', 'phone', 'addressPostcode'],
      { updateExisting: false },
    )
    expect(summary).toMatchObject({ created: 2, updated: 0, skipped: 1, organisationsCreated: 1 })
    expect(summary.problems).toHaveLength(1)
    expect(summary.problems[0]!.row).toBe(4)

    const { rows } = await lib.listOrganisations({ search: 'cobble', page: 1, perPage: 5 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'Cobble Supplies', peopleCount: 2, origin: 'import' })
  })

  it('run again, brings nothing in twice', async () => {
    const summary = await store.importContacts(
      [['Ade Fox', 'Cobble Supplies', 'ade@cobble.test', '0113 496 2222', 'HD1 3BB']],
      ['fullName', 'organisation', 'email', 'phone', 'addressPostcode'],
      { updateExisting: false },
    )
    expect(summary).toMatchObject({ created: 0, updated: 0, skipped: 1 })
  })

  it('fills existing contacts in when it is asked to, and not before', async () => {
    const summary = await store.importContacts(
      [['Ade Fox', 'Cobble Supplies', 'ade@cobble.test', '', 'HD1 3BB', 'Yard manager']],
      ['fullName', 'organisation', 'email', 'phone', 'addressPostcode', 'jobTitle'],
      { updateExisting: true },
    )
    expect(summary).toMatchObject({ created: 0, updated: 1, skipped: 0 })
    const ade = (await lib.listPeople({ search: 'ade@cobble.test', page: 1, perPage: 5 })).rows[0]!
    expect(ade.jobTitle).toBe('Yard manager')
    // The number the first run brought in is still there: a blank column fills
    // nothing in rather than blanking what is already known.
    expect((await lib.listIdentities(ade.id)).some((i) => i.kind === 'phone')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Categories. The unique index is an EXPRESSION index, and the upsert has to
  // name the expression rather than the column - `ON CONFLICT ("name")` is a
  // syntax error against it. Nothing but a real database would ever say so.
  // -------------------------------------------------------------------------

  it('holds one category per name, however it was typed', async () => {
    const first = await lib.findOrCreateCategory('Supplier')
    expect(await lib.findOrCreateCategory('  supplier ')).toBe(first)
    expect(await lib.findOrCreateCategory('SUPPLIER')).toBe(first)
    expect((await lib.findCategoryByName('supplier'))?.id).toBe(first)
    expect(await lib.findCategoryByName('Suppliers')).toBeNull()
  })

  it('refuses a second category with the same name outright', async () => {
    await expect(
      db.$executeRawUnsafe(`INSERT INTO "uin_contact_categories" ("name") VALUES (' Supplier ')`),
    ).rejects.toThrow()
  })

  it('puts them in the order they were made, and moves them', async () => {
    await lib.createCategory('Trade customer')
    await lib.createCategory('Haulier')
    const before = await lib.listCategories()
    expect(before.map((c) => c.name)).toEqual(['Supplier', 'Trade customer', 'Haulier'])

    await lib.reorderCategories([before[2]!.id, before[0]!.id, before[1]!.id])
    expect((await lib.listCategories()).map((c) => c.name))
      .toEqual(['Haulier', 'Supplier', 'Trade customer'])
  })

  it('sets what somebody is in, and setting it again changes nothing', async () => {
    const jane = (await lib.listPeople({ search: 'smith', page: 1, perPage: 5 })).rows[0]!
    const all = await lib.listCategories()
    const haulier = all.find((c) => c.name === 'Haulier')!
    const supplier = all.find((c) => c.name === 'Supplier')!

    await lib.setPersonCategories(jane.id, [supplier.id, haulier.id])
    expect((await lib.categoriesForPerson(jane.id)).map((c) => c.name))
      .toEqual(['Haulier', 'Supplier'])

    // Idempotent: the pair is the primary key, so a second save is not a second
    // row - which is what an import run twice does on every line.
    await lib.setPersonCategories(jane.id, [supplier.id, haulier.id])
    expect(await lib.categoriesForPerson(jane.id)).toHaveLength(2)
  })

  it('replaces the set rather than adding to it, when told to set', async () => {
    const jane = (await lib.listPeople({ search: 'smith', page: 1, perPage: 5 })).rows[0]!
    const supplier = (await lib.findCategoryByName('Supplier'))!
    await lib.setPersonCategories(jane.id, [supplier.id])
    expect((await lib.categoriesForPerson(jane.id)).map((c) => c.name)).toEqual(['Supplier'])

    await lib.setPersonCategories(jane.id, [])
    expect(await lib.categoriesForPerson(jane.id)).toEqual([])
  })

  it('narrows the contacts list to one label', async () => {
    const jane = (await lib.listPeople({ search: 'smith', page: 1, perPage: 5 })).rows[0]!
    const supplier = (await lib.findCategoryByName('Supplier'))!
    await lib.setPersonCategories(jane.id, [supplier.id])

    const { rows, total } = await lib.listPeople({ page: 1, perPage: 50, categoryId: supplier.id })
    expect(total).toBe(1)
    expect(rows[0]!.id).toBe(jane.id)
    expect((await lib.listCategories()).find((c) => c.name === 'Supplier')?.peopleCount).toBe(1)
  })

  it('fetches a whole page of labels in one go', async () => {
    const { rows } = await lib.listPeople({ page: 1, perPage: 50, sort: 'name' })
    const byPerson = await lib.categoriesForPeople(rows.map((r) => r.id))
    const jane = rows.find((r) => r.displayName === 'Jane Smith')!
    expect(byPerson[jane.id]).toEqual(['Supplier'])
    // Nobody else is in one, and an empty answer is an absent key rather than
    // an empty array - which is what the caller's `?? []` is for.
    expect(Object.keys(byPerson)).toEqual([jane.id])
  })

  it('saves the labels named on a card, replacing what was there', async () => {
    const jane = (await lib.listPeople({ search: 'smith', page: 1, perPage: 5 })).rows[0]!
    await store.saveContact(jane.id, { categories: 'Haulier, Trade customer' }, { origin: 'hand' })
    expect((await lib.categoriesForPerson(jane.id)).map((c) => c.name))
      .toEqual(['Haulier', 'Trade customer'])

    // A card that names none at all - the field left out of the request - does
    // not touch them. A card that sends the box empty means "none of them".
    await store.saveContact(jane.id, { jobTitle: 'Buyer' }, { origin: 'hand' })
    expect(await lib.categoriesForPerson(jane.id)).toHaveLength(2)
    await store.saveContact(jane.id, { categories: '' }, { origin: 'hand' })
    expect(await lib.categoriesForPerson(jane.id)).toEqual([])
  })

  it('creates a category named on a card that has never existed', async () => {
    const { personId } = await store.saveContact(null, {
      firstName: 'Nia', lastName: 'Okafor', categories: 'Architect',
    }, { origin: 'hand' })
    expect((await lib.findCategoryByName('architect'))).not.toBeNull()
    expect((await lib.categoriesForPerson(personId)).map((c) => c.name)).toEqual(['Architect'])
  })

  it('imports a category column, and one for the whole file', async () => {
    const summary = await store.importContacts(
      [
        ['Rhys Lloyd', 'rhys@quarry.test', 'Supplier; Stone'],
        ['Tess Byrne', 'tess@quarry.test', 'supplier'],
      ],
      ['fullName', 'email', 'categories'],
      { updateExisting: false, categoryName: 'Quarry trade' },
    )
    // "Supplier" already exists, "Stone" and "Quarry trade" do not.
    expect(summary).toMatchObject({ created: 2, categoriesCreated: 2 })

    const rhys = (await lib.listPeople({ search: 'rhys@quarry.test', page: 1, perPage: 5 })).rows[0]!
    expect((await lib.categoriesForPerson(rhys.id)).map((c) => c.name).sort())
      .toEqual(['Quarry trade', 'Stone', 'Supplier'])
    const tess = (await lib.listPeople({ search: 'tess@quarry.test', page: 1, perPage: 5 })).rows[0]!
    // Matched however it was typed: one Supplier, not a second one lower case.
    expect((await lib.categoriesForPerson(tess.id)).map((c) => c.name).sort())
      .toEqual(['Quarry trade', 'Supplier'])
  })

  it('adds labels on an import rather than replacing them', async () => {
    // A sheet saying "Supplier" is adding a fact about somebody, not stating
    // the whole of what they are.
    const summary = await store.importContacts(
      [['Rhys Lloyd', 'rhys@quarry.test', 'Haulier']],
      ['fullName', 'email', 'categories'],
      { updateExisting: true },
    )
    expect(summary).toMatchObject({ created: 0, updated: 1 })
    const rhys = (await lib.listPeople({ search: 'rhys@quarry.test', page: 1, perPage: 5 })).rows[0]!
    expect((await lib.categoriesForPerson(rhys.id)).map((c) => c.name).sort())
      .toEqual(['Haulier', 'Quarry trade', 'Stone', 'Supplier'])
  })

  it('keeps everybody when a category is removed', async () => {
    const stone = (await lib.findCategoryByName('Stone'))!
    await lib.deleteCategory(stone.id)
    const rhys = (await lib.listPeople({ search: 'rhys@quarry.test', page: 1, perPage: 5 })).rows[0]!
    expect(rhys.displayName).toBe('Rhys Lloyd')
    expect((await lib.categoriesForPerson(rhys.id)).map((c) => c.name).sort())
      .toEqual(['Haulier', 'Quarry trade', 'Supplier'])
  })

  it('lets go of the labels when the contact goes', async () => {
    const rhys = (await lib.listPeople({ search: 'rhys@quarry.test', page: 1, perPage: 5 })).rows[0]!
    const supplier = (await lib.findCategoryByName('Supplier'))!
    const before = (await lib.listCategories()).find((c) => c.id === supplier.id)!.peopleCount
    await db.$executeRawUnsafe(`DELETE FROM "uin_people" WHERE "id" = $1`, rhys.id)
    expect((await lib.listCategories()).find((c) => c.id === supplier.id)!.peopleCount).toBe(before - 1)
  })
})
