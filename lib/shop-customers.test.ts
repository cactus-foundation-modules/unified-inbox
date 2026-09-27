import { describe, it, expect } from 'vitest'
import {
  billingAddressOf,
  countryName,
  fillInBlanks,
  isEmptyFillIn,
  shopCustomerDraft,
  type ShopOrderCustomer,
} from './shop-customers'
import type { Person } from './types'

// A shop order read as a contact card. The part worth pinning is what comes
// off which address - the billing one, never the delivery one when there is a
// billing one - and that an existing card only ever has its blanks filled in.

const ADDRESS = {
  firstName: 'Jane',
  lastName: 'Smith',
  line1: '12 High Street',
  line2: 'Unit 4',
  city: 'Leeds',
  county: 'West Yorkshire',
  postcode: 'LS1 1AA',
  country: 'GB',
  phone: '0113 496 0000',
}

function order(overrides: Partial<ShopOrderCustomer> = {}): ShopOrderCustomer {
  return {
    customerName: 'Jane Smith',
    customerEmail: 'jane@acme.co.uk',
    customerOrganisation: 'Acme Ltd',
    customerPhone: '07700 900123',
    billingAddress: ADDRESS,
    shippingAddress: { ...ADDRESS, line1: 'Goods In', line2: 'Dock 3', postcode: 'LS9 9ZZ', phone: '0113 000 0000' },
    ...overrides,
  }
}

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: 'p1',
    displayName: 'jane',
    firstName: null,
    lastName: null,
    jobTitle: null,
    website: null,
    primaryEmail: 'jane@acme.co.uk',
    organisationId: null,
    organisationName: null,
    notes: null,
    origin: 'mail',
    mergedIntoId: null,
    addressLine1: null,
    addressLine2: null,
    addressCity: null,
    addressCounty: null,
    addressPostcode: null,
    addressCountry: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  }
}

describe('the card an order makes', () => {
  it('takes the name, address, number, company and billing address', () => {
    expect(shopCustomerDraft(order())).toEqual({
      firstName: 'Jane',
      lastName: 'Smith',
      email: 'jane@acme.co.uk',
      phone: '07700 900123',
      organisation: 'Acme Ltd',
      addressLine1: '12 High Street',
      addressLine2: 'Unit 4',
      addressCity: 'Leeds',
      addressCounty: 'West Yorkshire',
      addressPostcode: 'LS1 1AA',
      addressCountry: 'United Kingdom',
    })
  })

  it('bills to the delivery address on an order with no billing address of its own', () => {
    const draft = shopCustomerDraft(order({ billingAddress: null }))
    expect(draft).toMatchObject({ addressLine1: 'Goods In', addressPostcode: 'LS9 9ZZ' })
  })

  it('never falls back to the delivery address when the billing one cannot be read', () => {
    // That address describes a site office or a reception desk. Putting it on
    // the card as where somebody is billed would be making something up.
    expect(billingAddressOf({ billingAddress: 'nonsense', shippingAddress: ADDRESS })).toBeNull()
    const draft = shopCustomerDraft(order({ billingAddress: 'nonsense' }))
    expect(draft?.addressLine1).toBeUndefined()
    expect(draft?.email).toBe('jane@acme.co.uk')
  })

  it('uses the billing number when no contact number was given, and never the delivery one', () => {
    expect(shopCustomerDraft(order({ customerPhone: null }))?.phone).toBe('0113 496 0000')
    const noNumbers = shopCustomerDraft(order({
      customerPhone: null,
      billingAddress: { ...ADDRESS, phone: undefined },
    }))
    expect(noNumbers?.phone).toBeUndefined()
  })

  it('reads the company off the billing address on an order written before it was its own question', () => {
    const draft = shopCustomerDraft(order({
      customerOrganisation: null,
      billingAddress: { ...ADDRESS, company: 'Old Style Ltd' },
    }))
    expect(draft?.organisation).toBe('Old Style Ltd')
  })

  it('keeps a first name of two words together when the billing address has it split', () => {
    const draft = shopCustomerDraft(order({
      customerName: 'Mary Ann Jones',
      billingAddress: { ...ADDRESS, firstName: 'Mary Ann', lastName: 'Jones' },
    }))
    expect(draft).toMatchObject({ firstName: 'Mary Ann', lastName: 'Jones' })
  })

  it('names the person who placed the order, not whoever the invoice is addressed to', () => {
    const draft = shopCustomerDraft(order({
      customerName: 'Tom Baker',
      billingAddress: { ...ADDRESS, firstName: 'Sue', lastName: 'Accounts' },
    }))
    expect(draft).toMatchObject({ firstName: 'Tom', lastName: 'Baker' })
  })

  it('makes no card without an email address to file it under', () => {
    expect(shopCustomerDraft(order({ customerEmail: '   ' }))).toBeNull()
    expect(shopCustomerDraft(order({ customerEmail: 'not an address' }))).toBeNull()
  })

  it('leaves out what the order does not say rather than sending it empty', () => {
    const draft = shopCustomerDraft(order({
      customerOrganisation: '  ',
      billingAddress: { ...ADDRESS, line2: '', county: undefined },
    }))
    expect(draft).not.toHaveProperty('organisation', expect.anything())
    expect(draft?.addressLine2).toBeUndefined()
    expect(draft?.addressCounty).toBeUndefined()
  })
})

describe('a country as an envelope has it', () => {
  it('turns a two-letter code into its name', () => {
    expect(countryName('GB')).toBe('United Kingdom')
    expect(countryName('ie')).toBe('Ireland')
  })

  it('leaves a name that is already a name alone', () => {
    expect(countryName('United Kingdom')).toBe('United Kingdom')
    expect(countryName('')).toBeNull()
    expect(countryName(null)).toBeNull()
  })
})

describe('filling in somebody already here', () => {
  const draft = shopCustomerDraft(order())!

  it('fills in every blank box on a card the post made', () => {
    const fill = fillInBlanks(person(), draft)
    expect(fill.details).toEqual({
      firstName: 'Jane',
      lastName: 'Smith',
      addressLine1: '12 High Street',
      addressLine2: 'Unit 4',
      addressCity: 'Leeds',
      addressCounty: 'West Yorkshire',
      addressPostcode: 'LS1 1AA',
      addressCountry: 'United Kingdom',
    })
    expect(fill.displayName).toBe('Jane Smith')
    expect(fill.organisationName).toBe('Acme Ltd')
    expect(fill.primaryEmail).toBeUndefined()
  })

  it('never replaces anything somebody already wrote', () => {
    const fill = fillInBlanks(person({
      firstName: 'J',
      lastName: 'Smith-Jones',
      displayName: 'J Smith-Jones',
      addressPostcode: 'YO1 9TL',
      organisationId: 'org-1',
    }), draft)
    expect(fill.details).toEqual({})
    expect(fill.displayName).toBeUndefined()
    expect(fill.organisationName).toBeUndefined()
    expect(isEmptyFillIn(fill)).toBe(true)
  })

  it('puts the address on whole or not at all', () => {
    // One line already there means the card has an address, and a postcode
    // from the order under somebody else's street is an address that does not
    // exist.
    const fill = fillInBlanks(person({ addressCity: 'York' }), draft)
    expect(fill.details).not.toHaveProperty('addressLine1')
    expect(fill.details).not.toHaveProperty('addressPostcode')
  })

  it('gives an address to a card that had none', () => {
    const fill = fillInBlanks(person({ primaryEmail: null }), draft)
    expect(fill.primaryEmail).toBe('jane@acme.co.uk')
  })
})
