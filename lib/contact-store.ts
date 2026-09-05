import {
  addIdentity,
  addPersonCategories,
  createOrganisation,
  createPerson,
  findCategoryByName,
  findOrCreateCategory,
  findOrganisationByName,
  findPersonByIdentity,
  getPerson,
  setPersonCategories,
  updatePerson,
  type PersonDetails,
} from './db'
import { identityKey, phoneKey } from './people'
import {
  contactDisplayName,
  isWorthImporting,
  rowToContact,
  splitCategories,
  MAX_REPORTED_PROBLEMS,
  type ColumnTarget,
  type ContactDraft,
  type ImportProblem,
  type ImportSummary,
} from './contacts'
import type { ContactOrigin } from './types'

// ---------------------------------------------------------------------------
// Writing an address book down: one card typed by hand, or two thousand rows
// out of somebody's spreadsheet.
//
// Both go through the same function, which is the whole point of the file. An
// importer with its own idea of what a contact is drifts from the form within a
// release, and the drift shows up as a field that saves when you type it and
// vanishes when you import it.
//
// Two rules worth stating out loud, because both are the difference between an
// import that helps and one that has to be undone by hand:
//
//   An address that already belongs to somebody else is LEFT WHERE IT IS. Two
//   people claiming one mailbox is a merge for a person to decide on, not
//   something to settle by overwriting - so the row is reported rather than
//   applied, and the merge screen is where it gets settled.
//
//   An organisation is matched on its name, case and spacing ignored, before
//   one is created. A sheet says "Acme Ltd" in two thousand rows and means one
//   company; the classic failure of every contacts import is two thousand of
//   them.
// ---------------------------------------------------------------------------

/** A trimmed value, or null for one that was only ever whitespace. */
function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/** What a save does to the labels on a contact.
 *
 *  'replace' is what a card full of ticks means: what is ticked is what they
 *  are in. 'add' is what a file means: a sheet saying "Supplier" is adding a
 *  fact about somebody, not stating the whole of what they are, and an import
 *  that quietly took every other label off would be an import nobody could
 *  undo. */
export type CategoryMode = 'replace' | 'add'

export type SaveContactOutcome = {
  personId: string
  /** Addresses and numbers that were not attached because somebody else already
   *  holds them. Named rather than counted: "somebody else already has
   *  jane@acme.co.uk" is actionable and "1 was not saved" is not. */
  refused: string[]
}

/**
 * The organisation a card names, found or created.
 *
 * No domain is set on one created here. `domain` is what the mail pass matches
 * on and it is unique across the table, so guessing one from an address would
 * quietly claim every future correspondent at that domain for whichever company
 * somebody happened to type first.
 */
async function resolveOrganisation(
  name: string | null,
  origin: ContactOrigin,
): Promise<{ id: string | null; created: boolean }> {
  if (!name) return { id: null, created: false }
  const existing = await findOrganisationByName(name)
  if (existing) return { id: existing.id, created: false }
  return { id: await createOrganisation({ name, origin }), created: true }
}

/** Attach an address and a number, and say which of them somebody else had. */
async function attachContactIdentities(
  personId: string,
  draft: ContactDraft,
  source: string,
): Promise<string[]> {
  const refused: string[] = []

  const email = clean(draft.email)
  const emailKey = identityKey(email)
  if (email && emailKey) {
    const written = await addIdentity({
      personId, kind: 'email', value: email, matchValue: emailKey, source,
    })
    // Already ours is not a refusal - re-saving a card must not report the
    // address it was already carrying.
    if (!written && (await findPersonByIdentity([emailKey])) !== personId) refused.push(email)
  }

  const phone = clean(draft.phone)
  const numberKey = phoneKey(phone)
  if (phone && numberKey) {
    const written = await addIdentity({
      personId, kind: 'phone', value: phone, matchValue: numberKey, source,
    })
    if (!written && (await findPersonByIdentity([numberKey])) !== personId) refused.push(phone)
  }

  return refused
}

/** What goes in the person's own columns, from the card's fields. */
function detailsFrom(draft: ContactDraft): PersonDetails {
  return {
    firstName: clean(draft.firstName),
    lastName: clean(draft.lastName),
    jobTitle: clean(draft.jobTitle),
    website: clean(draft.website),
    addressLine1: clean(draft.addressLine1),
    addressLine2: clean(draft.addressLine2),
    addressCity: clean(draft.addressCity),
    addressCounty: clean(draft.addressCounty),
    addressPostcode: clean(draft.addressPostcode),
    addressCountry: clean(draft.addressCountry),
  }
}

/**
 * One contact card, saved.
 *
 * `personId` null creates; anything else updates the person it names. The name
 * everything shows is rebuilt from the two boxes on every save, falling back to
 * whatever the record already had - somebody who fills in a postcode and
 * nothing else has not asked to be anonymous.
 */
export async function saveContact(
  personId: string | null,
  draft: ContactDraft,
  opts: {
    origin: ContactOrigin
    /** The organisation already resolved by the caller, for a bulk run that has
     *  looked the same company up once for two thousand rows. `undefined` means
     *  "work it out from the name on the card", which is what one card does. */
    organisationId?: string | null
    /** How the labels on the card meet the labels already on the record.
     *  Defaults to 'replace', which is what a form does. */
    categoryMode?: CategoryMode
    /** Categories the caller has already resolved to ids, applied on top of
     *  whatever the card names. The importer's "give everybody in this file a
     *  category" box, resolved once for the run rather than per row. */
    extraCategoryIds?: readonly string[]
  },
): Promise<SaveContactOutcome> {
  const existing = personId ? await getPerson(personId) : null
  const organisation = opts.organisationId !== undefined
    ? { id: opts.organisationId, created: false }
    : await resolveOrganisation(clean(draft.organisation), opts.origin)

  const email = clean(draft.email)
  const displayName = contactDisplayName(
    draft.firstName,
    draft.lastName,
    existing?.displayName ?? email,
  )
  const details = detailsFrom(draft)
  const notes = draft.notes === undefined ? undefined : clean(draft.notes)

  if (existing) {
    await updatePerson(existing.id, {
      ...details,
      displayName,
      // Only ever filled in, never cleared: the address the site has been
      // writing to for two years is not something a blank box on a form should
      // take away. Taking one off is what the addresses list on the card does.
      primaryEmail: email ?? existing.primaryEmail,
      // Same for the badge. An organisation that is not named on this save is
      // one the form was not asked about.
      organisationId: organisation.id ?? existing.organisationId,
      ...(notes === undefined ? {} : { notes }),
    })
    const refused = await attachContactIdentities(existing.id, draft, opts.origin)
    await applyCategories(existing.id, draft, opts)
    return { personId: existing.id, refused }
  }

  const id = await createPerson({
    displayName,
    primaryEmail: email,
    organisationId: organisation.id,
    notes: notes ?? null,
    origin: opts.origin,
    details,
  })
  const refused = await attachContactIdentities(id, draft, opts.origin)
  await applyCategories(id, draft, opts)
  return { personId: id, refused }
}

/**
 * The labels on one contact, put on.
 *
 * A card that names no categories at all - the field left out of the request
 * rather than sent empty - leaves whatever is there alone. Sent empty, on a
 * form, means "none of them", which is a thing somebody can mean. An import
 * only ever adds.
 */
async function applyCategories(
  personId: string,
  draft: ContactDraft,
  opts: { categoryMode?: CategoryMode; extraCategoryIds?: readonly string[] },
): Promise<void> {
  const named = draft.categories === undefined ? null : splitCategories(draft.categories)
  const extra = [...(opts.extraCategoryIds ?? [])]
  if (named === null && extra.length === 0) return

  const ids = [...extra]
  for (const name of named ?? []) {
    const id = await findOrCreateCategory(name)
    if (!ids.includes(id)) ids.push(id)
  }

  if ((opts.categoryMode ?? 'replace') === 'add') {
    await addPersonCategories(personId, ids)
    return
  }
  await setPersonCategories(personId, ids)
}

/**
 * Whoever already holds one of the ways of reaching this contact.
 *
 * What makes an import that is run twice add nothing the second time, and what
 * makes a spreadsheet of people the site has already been emailing fill in
 * their details rather than build a second copy of each of them.
 */
async function existingContactFor(draft: ContactDraft): Promise<string | null> {
  const keys = [identityKey(clean(draft.email)), phoneKey(clean(draft.phone))]
    .filter((k): k is string => !!k)
  if (keys.length === 0) return null
  return findPersonByIdentity(keys)
}

export type ImportOptions = {
  /** Whether a row matching somebody already here fills their card in, or is
   *  counted and left alone. Off is the safe answer and the one the screen
   *  opens on: a file with a blank column would otherwise blank that field for
   *  everybody in it. */
  updateExisting: boolean
  /** A category to put every contact in the file into, on top of whatever a
   *  category column on the row says. "These four hundred are all hauliers" is
   *  a thing somebody knows about the file rather than something written in it,
   *  and typing it into four hundred rows first is not a reasonable ask. */
  categoryName?: string | null
}

/**
 * A parsed file, applied.
 *
 * Row by row rather than in one transaction, on purpose. Two thousand rows is
 * longer than a serverless function's patience, and a failure halfway through
 * an all-or-nothing import gives back nothing at all - whereas a failure
 * halfway through this one leaves the first half imported and names the row it
 * stopped being able to read. Every row that cannot be applied is reported and
 * the rest go in.
 *
 * The row numbers reported are the ones in the file, header included, so they
 * match what the spreadsheet shows down its left-hand side.
 */
export async function importContacts(
  rows: readonly (readonly string[])[],
  map: readonly ColumnTarget[],
  opts: ImportOptions,
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    created: 0, updated: 0, skipped: 0, organisationsCreated: 0, categoriesCreated: 0, problems: [],
  }

  // The one that goes on every row, resolved once for the whole run.
  const blanket: string[] = []
  const blanketName = clean(opts.categoryName ?? null)
  if (blanketName) {
    const before = await findCategoryByName(blanketName)
    blanket.push(await findOrCreateCategory(blanketName))
    if (!before) summary.categoriesCreated += 1
  }

  const note = (row: number, reason: string) => {
    summary.skipped += 1
    if (summary.problems.length < MAX_REPORTED_PROBLEMS) summary.problems.push({ row, reason })
  }

  // Organisations and categories seen in this run, so a two thousand row sheet
  // naming one company asks the database once rather than two thousand times.
  const organisations = new Map<string, string | null>()
  const categories = new Map<string, string>()

  for (const [index, row] of rows.entries()) {
    // +2: the header is row one, and a spreadsheet counts from one.
    const number = index + 2
    const draft = rowToContact(row, map)

    if (!isWorthImporting(draft)) {
      note(number, 'There was no name, address, number or organisation on this row.')
      continue
    }

    try {
      const organisationName = clean(draft.organisation)
      let organisationId: string | null = null
      if (organisationName) {
        const key = organisationName.toLowerCase()
        const known = organisations.get(key)
        if (known === undefined) {
          const resolved = await resolveOrganisation(organisationName, 'import')
          if (resolved.created) summary.organisationsCreated += 1
          organisations.set(key, resolved.id)
          organisationId = resolved.id
        } else {
          organisationId = known
        }
      }

      const existingId = await existingContactFor(draft)
      if (existingId && !opts.updateExisting) {
        note(number, 'Somebody with that address or number is already here, and filling in existing contacts was switched off.')
        continue
      }

      // Named on the row, resolved through the run's own cache. Done here rather
      // than inside saveContact so that a file naming three categories over two
      // thousand rows asks the database three times.
      const rowCategories: string[] = []
      for (const name of splitCategories(draft.categories)) {
        const key = name.toLowerCase()
        let id = categories.get(key)
        if (id === undefined) {
          const before = await findCategoryByName(name)
          id = await findOrCreateCategory(name)
          if (!before) summary.categoriesCreated += 1
          categories.set(key, id)
        }
        if (!rowCategories.includes(id)) rowCategories.push(id)
      }

      const outcome = await saveContact(existingId, { ...draft, categories: undefined }, {
        origin: 'import',
        // A row with no company named leaves the badge alone rather than
        // clearing it: an import that takes an organisation off everybody it
        // touches is an import nobody can undo.
        organisationId: organisationId ?? undefined,
        // Adding, never replacing - see CategoryMode. The names on the row are
        // already ids by now, so the draft's own field is not read again.
        categoryMode: 'add',
        extraCategoryIds: [...blanket, ...rowCategories],
      })
      if (existingId) summary.updated += 1
      else summary.created += 1

      for (const value of outcome.refused) {
        if (summary.problems.length < MAX_REPORTED_PROBLEMS) {
          summary.problems.push({
            row: number,
            reason: `${value} belongs to somebody else here, so it was left where it is. The rest of the row went in.`,
          })
        }
      }
    } catch (err) {
      console.error('[unified-inbox] a contact row could not be imported:', err)
      note(number, 'This row could not be saved.')
    }
  }

  return summary
}

export type { ImportProblem, ImportSummary }
