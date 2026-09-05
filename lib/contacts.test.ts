import { describe, it, expect } from 'vitest'
import {
  addressLines,
  buildImportTemplateCsv,
  contactDisplayName,
  CONTACT_FIELDS,
  CONTACT_FIELD_GROUPS,
  CONTACT_FIELD_LABELS,
  guessColumnMap,
  isContactField,
  isFullNameHeader,
  isWorthImporting,
  joinCategories,
  MAX_CATEGORIES_PER_CONTACT,
  parseCsv,
  rowToContact,
  splitCategories,
  splitName,
  type ColumnTarget,
} from './contacts'

// The address book's pure half. Everything here decides what a spreadsheet
// somebody else wrote means, which is the part that ruins a two thousand row
// import in one press if it is wrong and the part no amount of typechecking
// would notice.

describe('the field list', () => {
  it('covers every field exactly once across the groups', () => {
    const grouped = CONTACT_FIELD_GROUPS.flatMap((g) => g.fields)
    expect([...grouped].sort()).toEqual([...CONTACT_FIELDS].sort())
    expect(new Set(grouped).size).toBe(grouped.length)
  })

  it('has a label for every field', () => {
    for (const field of CONTACT_FIELDS) {
      expect(CONTACT_FIELD_LABELS[field]).toBeTruthy()
    }
  })

  it('refuses anything that is not one', () => {
    expect(isContactField('firstName')).toBe(true)
    expect(isContactField('mergedIntoId')).toBe(false)
    expect(isContactField('')).toBe(false)
    expect(isContactField(null)).toBe(false)
  })
})

describe('names', () => {
  it('joins the two boxes', () => {
    expect(contactDisplayName('Jane', 'Smith')).toBe('Jane Smith')
    expect(contactDisplayName('Jane', '')).toBe('Jane')
    expect(contactDisplayName('  ', ' Smith ')).toBe('Smith')
  })

  it('keeps the name it already had when both boxes are empty', () => {
    // Somebody who fills in a postcode and nothing else has not asked to be
    // anonymous.
    expect(contactDisplayName('', '', 'Acme Ltd')).toBe('Acme Ltd')
    expect(contactDisplayName(null, null, null)).toBeNull()
  })

  it('splits a name off its last word', () => {
    expect(splitName('Jane Smith')).toEqual({ firstName: 'Jane', lastName: 'Smith' })
    expect(splitName('Mary Jane Smith')).toEqual({ firstName: 'Mary Jane', lastName: 'Smith' })
    expect(splitName('  Jane   Smith ')).toEqual({ firstName: 'Jane', lastName: 'Smith' })
    expect(splitName('Cher')).toEqual({ firstName: 'Cher', lastName: '' })
  })

  it('never splits an address', () => {
    // "Sales" and "example.com" would be a worse answer than two empty boxes.
    expect(splitName('sales@example.com')).toEqual({ firstName: '', lastName: '' })
    expect(splitName('')).toEqual({ firstName: '', lastName: '' })
    expect(splitName(null)).toEqual({ firstName: '', lastName: '' })
  })
})

describe('a postal address', () => {
  it('drops the lines that are not there', () => {
    expect(addressLines({
      addressLine1: '12 High Street',
      addressLine2: '  ',
      addressCity: 'Leeds',
      addressCounty: null,
      addressPostcode: 'LS1 1AA',
      addressCountry: undefined,
    })).toEqual(['12 High Street', 'Leeds', 'LS1 1AA'])
  })

  it('comes back empty when nothing is known', () => {
    expect(addressLines({})).toEqual([])
  })
})

describe('categories', () => {
  it('splits on the four things a spreadsheet uses for a list in one cell', () => {
    expect(splitCategories('Supplier, Haulier; Trade|Retail\nWholesale'))
      .toEqual(['Supplier', 'Haulier', 'Trade', 'Retail', 'Wholesale'])
  })

  it('never splits on a space', () => {
    // Or "Trade customer" becomes two categories, which is the one thing that
    // would make the whole feature untrustworthy.
    expect(splitCategories('Trade customer')).toEqual(['Trade customer'])
    expect(splitCategories('  Trade   customer  ')).toEqual(['Trade customer'])
  })

  it('de-duplicates ignoring case, keeping the spelling that came first', () => {
    expect(splitCategories('Supplier, supplier, SUPPLIER')).toEqual(['Supplier'])
  })

  it('comes back empty for nothing', () => {
    expect(splitCategories('')).toEqual([])
    expect(splitCategories(null)).toEqual([])
    expect(splitCategories(' , ; | ')).toEqual([])
  })

  it('stops at the ceiling, so a mis-mapped notes column cannot invent hundreds', () => {
    const many = Array.from({ length: 40 }, (_, i) => `Cat ${i}`).join(',')
    expect(splitCategories(many)).toHaveLength(MAX_CATEGORIES_PER_CONTACT)
  })

  it('writes back the way the box reads', () => {
    expect(joinCategories(['Supplier', 'Haulier'])).toBe('Supplier, Haulier')
    expect(splitCategories(joinCategories(['Trade customer', 'Supplier'])))
      .toEqual(['Trade customer', 'Supplier'])
  })
})

describe('reading a CSV', () => {
  it('handles quotes, commas and newlines inside a field', () => {
    const text = 'name,notes\r\n"Smith, Jane","She said ""hello""\nand rang off"\r\n'
    expect(parseCsv(text)).toEqual([
      ['name', 'notes'],
      ['Smith, Jane', 'She said "hello"\nand rang off'],
    ])
  })

  it('strips the byte-order mark Excel writes', () => {
    // Left in, the first column's header matches nothing and a perfectly good
    // file arrives at the mapping step with its first column unrecognised.
    const rows = parseCsv('﻿First name,Last name\nJane,Smith\n')
    expect(rows[0]![0]).toBe('First name')
  })

  it('drops the blank trailing row every spreadsheet writes', () => {
    expect(parseCsv('a,b\n1,2\n\n')).toEqual([['a', 'b'], ['1', '2']])
  })
})

describe('guessing the columns', () => {
  it('reads a category column under any of the names an export gives it', () => {
    expect(guessColumnMap(['Category'])).toEqual(['categories'])
    expect(guessColumnMap(['Groups'])).toEqual(['categories'])
    expect(guessColumnMap(['Contact type'])).toEqual(['categories'])
    expect(guessColumnMap(['Tags'])).toEqual(['categories'])
  })

  it('recognises what Outlook exports', () => {
    const map = guessColumnMap([
      'First Name', 'Last Name', 'Company', 'Job Title', 'Business Street',
      'Business City', 'Business State', 'Business Postal Code', 'Business Country',
      'E-mail Address', 'Business Phone', 'Web Page', 'Notes',
    ])
    expect(map).toEqual([
      'firstName', 'lastName', 'organisation', 'jobTitle', 'addressLine1',
      'addressCity', 'addressCounty', 'addressPostcode', 'addressCountry',
      'email', 'phone', 'website', 'notes',
    ] satisfies ColumnTarget[])
  })

  it('reads a single Name column as a name to be split', () => {
    expect(guessColumnMap(['Name', 'Email'])).toEqual(['fullName', 'email'])
  })

  it('prefers the specific columns to the vague one', () => {
    // A file carrying both should use First/Last and leave "Name" out, or the
    // same person arrives with their name in twice.
    expect(guessColumnMap(['Name', 'First name', 'Surname']))
      .toEqual(['', 'firstName', 'lastName'])
  })

  it('leaves a second column for one field alone', () => {
    expect(guessColumnMap(['Email', 'Email 2'])).toEqual(['email', ''])
  })

  it('leaves out what it has never heard of', () => {
    expect(guessColumnMap(['Loyalty tier', 'Internal ref'])).toEqual(['', ''])
  })

  it('knows a whole-name header when it sees one', () => {
    expect(isFullNameHeader('Full Name')).toBe(true)
    expect(isFullNameHeader('First name')).toBe(false)
  })
})

describe('one row', () => {
  const map: ColumnTarget[] = ['fullName', 'organisation', 'email', '', 'addressPostcode']

  it('applies the mapping and leaves the unmapped columns out', () => {
    expect(rowToContact(['Jane Smith', 'Acme Ltd', 'jane@acme.co.uk', 'gold', 'LS1 1AA'], map))
      .toEqual({
        firstName: 'Jane',
        lastName: 'Smith',
        organisation: 'Acme Ltd',
        email: 'jane@acme.co.uk',
        addressPostcode: 'LS1 1AA',
      })
  })

  it('trims, and drops cells that were only ever whitespace', () => {
    expect(rowToContact(['  Jane Smith ', '   ', ' jane@acme.co.uk', '', ''], map))
      .toEqual({ firstName: 'Jane', lastName: 'Smith', email: 'jane@acme.co.uk' })
  })

  it('joins two columns mapped onto one field rather than dropping one', () => {
    // Visible in the preview, which is the point: a silently discarded column
    // is not.
    expect(rowToContact(['12 High Street', 'Unit 4'], ['addressLine1', 'addressLine1']))
      .toEqual({ addressLine1: '12 High Street Unit 4' })
  })

  it('joins two category columns with a comma rather than a space', () => {
    // A space would make "Supplier Haulier" one label nobody meant.
    expect(rowToContact(['Supplier', 'Haulier'], ['categories', 'categories']))
      .toEqual({ categories: 'Supplier, Haulier' })
  })

  it('copes with a row shorter than the header', () => {
    expect(rowToContact(['Jane Smith'], map)).toEqual({ firstName: 'Jane', lastName: 'Smith' })
  })
})

describe('whether a row is worth a record', () => {
  it('wants a name, a way of reaching them, or a company', () => {
    expect(isWorthImporting({ firstName: 'Jane' })).toBe(true)
    expect(isWorthImporting({ email: 'jane@acme.co.uk' })).toBe(true)
    expect(isWorthImporting({ phone: '01234 567890' })).toBe(true)
    expect(isWorthImporting({ organisation: 'Acme Ltd' })).toBe(true)
  })

  it('refuses a row that is only a country', () => {
    expect(isWorthImporting({ addressCountry: 'United Kingdom' })).toBe(false)
    expect(isWorthImporting({})).toBe(false)
  })
})

describe('the blank template', () => {
  it('is a header row of the labels, which guesses straight back to the fields', () => {
    const [header] = parseCsv(buildImportTemplateCsv())
    expect(header).toEqual(CONTACT_FIELDS.map((f) => CONTACT_FIELD_LABELS[f]))
    expect(guessColumnMap(header!)).toEqual([...CONTACT_FIELDS])
  })
})
