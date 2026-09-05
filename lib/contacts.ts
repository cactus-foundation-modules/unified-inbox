// ---------------------------------------------------------------------------
// The address book's pure half: what a contact is called, what a postal address
// reads like, and how a column in somebody else's spreadsheet becomes a field
// in ours.
//
// All of it is here rather than in a component or a route for the usual two
// reasons. It is the part worth testing - a header-guesser that quietly maps
// "Company" onto the wrong field ruins a two thousand row import in one press -
// and both halves of the import need it: the browser to draw the mapping step,
// the server to apply it. Nothing in this file touches a database or a session.
// ---------------------------------------------------------------------------

/** Every field the address book holds, in the order the form shows them.
 *
 *  `phone` and `email` are stored as identities rather than as columns on the
 *  person (see migrations/025_contacts.sql), which is invisible here on
 *  purpose: to somebody filling in a card, a number is a field like any other.
 */
export const CONTACT_FIELDS = [
  'firstName', 'lastName', 'jobTitle', 'organisation', 'categories',
  'email', 'phone', 'website',
  'addressLine1', 'addressLine2', 'addressCity', 'addressCounty', 'addressPostcode', 'addressCountry',
  'notes',
] as const

export type ContactField = (typeof CONTACT_FIELDS)[number]

export function isContactField(value: unknown): value is ContactField {
  return typeof value === 'string' && (CONTACT_FIELDS as readonly string[]).includes(value)
}

/** What each field is called in front of somebody who is looking at their own
 *  spreadsheet on the other monitor. British throughout: a county, a postcode. */
export const CONTACT_FIELD_LABELS: Record<ContactField, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  jobTitle: 'Job title',
  organisation: 'Organisation',
  categories: 'Categories',
  email: 'Email address',
  phone: 'Phone number',
  website: 'Website',
  addressLine1: 'Address line 1',
  addressLine2: 'Address line 2',
  addressCity: 'Town or city',
  addressCounty: 'County',
  addressPostcode: 'Postcode',
  addressCountry: 'Country',
  notes: 'Notes',
}

export type ContactFieldGroup = { label: string; fields: readonly ContactField[] }

/** The form's own shape, used by the card and by the mapping step so the two
 *  read in the same order. Covers every field exactly once - contacts.test.ts
 *  asserts that, so a field added later cannot go missing from either screen. */
export const CONTACT_FIELD_GROUPS: readonly ContactFieldGroup[] = [
  { label: 'Who they are', fields: ['firstName', 'lastName', 'jobTitle', 'organisation', 'categories'] },
  { label: 'How to reach them', fields: ['email', 'phone', 'website'] },
  {
    label: 'Where they are',
    fields: ['addressLine1', 'addressLine2', 'addressCity', 'addressCounty', 'addressPostcode', 'addressCountry'],
  },
  { label: 'Anything else', fields: ['notes'] },
]

/** One contact as the form and the importer both hand it over. Every field
 *  optional: a card with nothing but a phone number on it is a perfectly good
 *  contact, and an import sheet with three columns is a perfectly good sheet. */
export type ContactDraft = Partial<Record<ContactField, string>>

// ---------------------------------------------------------------------------
// Names.
// ---------------------------------------------------------------------------

/**
 * The one name everything shows, built from the two boxes somebody typed in.
 *
 * `fallback` is what the record already had - a name read off a From line, or
 * an address. It is kept when the boxes are empty rather than blanking a
 * perfectly good name: somebody who fills in a postcode and nothing else has
 * not asked to be anonymous.
 */
export function contactDisplayName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  fallback: string | null = null,
): string | null {
  const parts = [firstName?.trim(), lastName?.trim()].filter((p): p is string => !!p)
  if (parts.length > 0) return parts.join(' ')
  return fallback?.trim() || null
}

/**
 * A name that arrived as one string, split into the two boxes.
 *
 * Used to fill the form in for somebody the mail pass met before this screen
 * existed, and for an import sheet with a single "Name" column. The last word
 * is the surname and everything before it is not, which is right for the great
 * majority of British names and wrong in a way anybody can see and correct.
 *
 * An address is never split: `sales@example.com` has no surname, and "Sales"
 * and "example.com" would be a worse answer than leaving the boxes alone.
 */
export function splitName(full: string | null | undefined): { firstName: string; lastName: string } {
  const trimmed = (full ?? '').trim().replace(/\s+/g, ' ')
  if (!trimmed || trimmed.includes('@')) return { firstName: '', lastName: '' }
  const words = trimmed.split(' ')
  if (words.length === 1) return { firstName: words[0]!, lastName: '' }
  return { firstName: words.slice(0, -1).join(' '), lastName: words[words.length - 1]! }
}

/** A postal address on the lines it is posted on, with the empty ones left out
 *  rather than showing as blank rows. */
export function addressLines(contact: {
  addressLine1?: string | null
  addressLine2?: string | null
  addressCity?: string | null
  addressCounty?: string | null
  addressPostcode?: string | null
  addressCountry?: string | null
}): string[] {
  return [
    contact.addressLine1, contact.addressLine2, contact.addressCity,
    contact.addressCounty, contact.addressPostcode, contact.addressCountry,
  ].map((line) => line?.trim() ?? '').filter(Boolean)
}

// ---------------------------------------------------------------------------
// Categories.
// ---------------------------------------------------------------------------

/** How many labels one contact may wear. High enough that nobody sensible
 *  meets it, low enough that a mis-mapped notes column does not create four
 *  hundred categories out of one sentence. */
export const MAX_CATEGORIES_PER_CONTACT = 20

/**
 * One cell, or one box, read as a list of category names.
 *
 * Split on commas, semicolons, pipes and newlines - the four things every
 * export in the world uses for a list in one cell - and never on a space, or
 * "Trade customer" becomes two categories. De-duplicated ignoring case, so a
 * file saying "Supplier, supplier" means one, and the first spelling wins
 * because that is the one somebody typed on purpose.
 */
export function splitCategories(value: string | null | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of (value ?? '').split(/[,;|\n]+/)) {
    const name = part.trim().replace(/\s+/g, ' ')
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= MAX_CATEGORIES_PER_CONTACT) break
  }
  return out
}

/** The other way round: a list of names as the one box shows them. */
export function joinCategories(names: readonly string[]): string {
  return names.join(', ')
}

// ---------------------------------------------------------------------------
// Reading somebody else's file.
//
// A hand-rolled parser rather than a dependency, the same as the shop's: a
// module that pulls a CSV library in pulls it into every install that has the
// module, and this is sixty lines.
// ---------------------------------------------------------------------------

/** How many rows one import will take. High enough for anybody's address book
 *  and low enough that the route finishes inside its own time. */
export const MAX_IMPORT_ROWS = 5000

/**
 * RFC4180-ish: quoted fields with embedded commas and newlines, and doubled
 * quotes for a literal one. Returns one array of cells per row, blank rows
 * dropped - a spreadsheet exported from anywhere has a trailing one.
 *
 * A leading byte-order mark is stripped. Excel writes one on every CSV it saves
 * as UTF-8, and left in place it makes the first column's header "﻿First
 * name", which matches nothing and sends a perfectly good file to the manual
 * mapping step with its first column unrecognised.
 */
export function parseCsv(text: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0

  while (i < source.length) {
    const char = source[i]
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i += 1; continue
      }
      field += char; i += 1; continue
    }
    if (char === '"') { inQuotes = true; i += 1; continue }
    if (char === ',') { row.push(field); field = ''; i += 1; continue }
    if (char === '\r') { i += 1; continue }
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue }
    field += char; i += 1
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

function toCsvField(value: string): string {
  // A cell starting with = + - @ is run as a formula by Excel and Sheets. A
  // single quote in front makes it text again; a plain number is left alone so
  // an export that goes back in is unchanged.
  let field = value
  if (/^[=+\-@\t\r]/.test(field) && !/^-?\d+(\.\d+)?$/.test(field)) field = `'${field}`
  if (/[",\n\r]/.test(field)) return `"${field.replace(/"/g, '""')}"`
  return field
}

/** The empty file somebody downloads when they would rather start from ours
 *  than map their own. Headers are the labels, not the field names: a person
 *  fills in "First name", not "firstName". */
export function buildImportTemplateCsv(): string {
  return CONTACT_FIELDS.map((f) => toCsvField(CONTACT_FIELD_LABELS[f])).join(',') + '\r\n'
}

// ---------------------------------------------------------------------------
// Guessing which column is which.
//
// Every export in the world calls these something slightly different, and the
// guess is only ever a starting point - the mapping step shows what it decided
// and lets every one of them be changed, including to "do not import". Getting
// one wrong costs a moment; refusing to guess at all costs fifteen columns of
// hand-picking on every file.
// ---------------------------------------------------------------------------

/** What a header has to look like, reduced to letters and digits so that
 *  "E-mail Address", "email_address" and "Email address" are one thing. */
function normaliseHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** Headers seen in the wild, by field. Outlook, Google Contacts, Apple
 *  Contacts, Mailchimp and every accounts package that has ever exported a
 *  customer list. First match wins, so the list is ordered by how sure it is. */
const HEADER_ALIASES: Record<ContactField, readonly string[]> = {
  firstName: ['firstname', 'givenname', 'forename', 'first', 'contactfirstname'],
  lastName: ['lastname', 'surname', 'familyname', 'last', 'contactlastname'],
  jobTitle: ['jobtitle', 'title', 'position', 'role', 'jobposition'],
  organisation: [
    'organisation', 'organization', 'company', 'companyname', 'organisationname',
    'organizationname', 'business', 'businessname', 'account', 'accountname', 'employer',
  ],
  // "Type" and "Group" are here rather than under job title because in a
  // contacts export they almost always say what KIND of contact this is -
  // supplier, trade, retail - which is exactly what a category is.
  categories: [
    'category', 'categories', 'group', 'groups', 'type', 'contacttype', 'customertype',
    'tag', 'tags', 'labels', 'label', 'segment', 'segments', 'list', 'lists', 'classification',
  ],
  email: ['email', 'emailaddress', 'email1', 'emailaddress1', 'primaryemail', 'workemail', 'mail'],
  phone: [
    'phone', 'phonenumber', 'telephone', 'tel', 'mobile', 'mobilephone', 'mobilenumber',
    'businessphone', 'workphone', 'homephone', 'phone1', 'contactnumber', 'primaryphone',
  ],
  website: ['website', 'web', 'url', 'homepage', 'webpage', 'websiteaddress'],
  addressLine1: [
    'addressline1', 'address1', 'address', 'street', 'streetaddress', 'businessstreet',
    'homestreet', 'addressline', 'line1',
  ],
  addressLine2: ['addressline2', 'address2', 'street2', 'businessstreet2', 'line2'],
  addressCity: ['city', 'town', 'towncity', 'townorcity', 'businesscity', 'homecity', 'locality'],
  addressCounty: [
    'county', 'state', 'region', 'province', 'countystate', 'stateprovince',
    'businessstate', 'homestate',
  ],
  addressPostcode: [
    'postcode', 'postalcode', 'zip', 'zipcode', 'postcodezip', 'businesspostalcode',
    'homepostalcode',
  ],
  addressCountry: ['country', 'countryregion', 'businesscountry', 'homecountry', 'countryorregion'],
  notes: ['notes', 'note', 'comments', 'comment', 'description', 'remarks'],
}

/** Headers that hold a whole name in one column, which becomes first and last.
 *  Kept apart from the aliases above because it maps onto two fields, and
 *  because a file with "Name" AND "First name" wants the specific one. */
const FULL_NAME_ALIASES: readonly string[] = [
  'name', 'fullname', 'contact', 'contactname', 'displayname', 'person', 'personname',
]

/** The field a single header most likely means, or null for one we have never
 *  seen. `taken` keeps two columns off one field: an export with "Email" and
 *  "Email 2" should fill the email box once and leave the second alone rather
 *  than have the two fight over it. */
function guessField(header: string, taken: ReadonlySet<ContactField>): ContactField | null {
  const key = normaliseHeader(header)
  if (!key) return null
  for (const field of CONTACT_FIELDS) {
    if (taken.has(field)) continue
    if (HEADER_ALIASES[field].includes(key)) return field
  }
  return null
}

/** The special case: one column holding the whole name. */
export function isFullNameHeader(header: string): boolean {
  return FULL_NAME_ALIASES.includes(normaliseHeader(header))
}

/** What a column maps onto. A field, the whole name, or nothing at all -
 *  "leave this column out" being a perfectly ordinary answer for the thirty
 *  columns Outlook exports that an address book has no use for. */
export type ColumnTarget = ContactField | 'fullName' | ''

/**
 * A first guess at the whole header row, index by index.
 *
 * Two passes on purpose. The named fields go first so that a file carrying both
 * "Name" and "First name" uses the specific columns and drops the vague one;
 * only if nothing has claimed first or last does a "Name" column get to fill
 * them both.
 */
export function guessColumnMap(headers: readonly string[]): ColumnTarget[] {
  const taken = new Set<ContactField>()
  const map: ColumnTarget[] = headers.map(() => '')

  headers.forEach((header, index) => {
    const field = guessField(header, taken)
    if (!field) return
    taken.add(field)
    map[index] = field
  })

  if (!taken.has('firstName') && !taken.has('lastName')) {
    const index = headers.findIndex((h, i) => map[i] === '' && isFullNameHeader(h))
    if (index >= 0) map[index] = 'fullName'
  }

  return map
}

// ---------------------------------------------------------------------------
// One row, applied.
// ---------------------------------------------------------------------------

/**
 * A row of cells and a mapping, turned into a contact.
 *
 * Every value is trimmed, and a column mapped onto a field it has already
 * filled is appended to it rather than dropped - two "Address line 1" columns
 * in one sheet is a mis-mapping somebody can see in the preview, whereas a
 * silently discarded column is not.
 */
export function rowToContact(row: readonly string[], map: readonly ColumnTarget[]): ContactDraft {
  const draft: ContactDraft = {}
  const put = (field: ContactField, value: string) => {
    const clean = value.trim()
    if (!clean) return
    const existing = draft[field]
    if (!existing) {
      draft[field] = clean
      return
    }
    // Two columns onto one field are joined rather than dropped. Categories
    // join with a comma because that is how the field itself is written and
    // read; everything else joins with a space, which is what a second address
    // line mapped onto the first actually wants.
    draft[field] = field === 'categories' ? `${existing}, ${clean}` : `${existing} ${clean}`
  }

  map.forEach((target, index) => {
    const cell = row[index]
    if (!target || cell === undefined) return
    if (target === 'fullName') {
      const { firstName, lastName } = splitName(cell)
      if (firstName) put('firstName', firstName)
      if (lastName) put('lastName', lastName)
      return
    }
    put(target, cell)
  })

  return draft
}

/** Whether there is enough on a row to be worth a record. A row with nothing
 *  but a country on it is a blank line in somebody's spreadsheet. */
export function isWorthImporting(draft: ContactDraft): boolean {
  return !!(draft.firstName || draft.lastName || draft.email || draft.phone || draft.organisation)
}

/** Why a row was left out, in a sentence the person who chose the file can act
 *  on. Only ever one reason: the first thing wrong with a row is the thing to
 *  fix, and a list of five per row is a list nobody reads. */
export type ImportProblem = { row: number; reason: string }

export type ImportSummary = {
  created: number
  updated: number
  skipped: number
  organisationsCreated: number
  categoriesCreated: number
  problems: ImportProblem[]
}

/** How many problems come back. The file is the place to fix a thousand of
 *  them, and a response listing every one is a response nobody can read. */
export const MAX_REPORTED_PROBLEMS = 50
