import { z } from 'zod'
import {
  addressKey, addressLines, contactDisplayName, splitName,
  type ContactDraft, type LabelledAddress, type LabelledPhone,
} from './contacts'
import type { MarketingConsentRecord, PersonDetails } from './db'
import type { Person } from './types'

// ---------------------------------------------------------------------------
// A shop order, read as a contact card: the pure half.
//
// Somebody who places an order has told the site their name, their email
// address, usually a phone number, sometimes the company they are buying for,
// and where the invoice goes. That is an address book entry in all but name,
// and lib/shop-customer-sync.ts is what writes it down. This file only answers
// "what would the card say" and "which of those boxes may we fill in", so both
// can be tested without a database.
//
// The shop's own code is deliberately not imported. It is not a dependency of
// this module and on a site without it the path does not exist at build time.
// The order is read by raw SQL, the same as every adapter in lib/adapters/, and
// the address shape is restated here as the little of it that is needed.
// ---------------------------------------------------------------------------

/** The customer half of one `shp_orders` row, as read by raw SQL. The two
 *  addresses are JSON the shop wrote and are parsed rather than trusted. */
export type ShopOrderCustomer = {
  customerName: string | null
  customerEmail: string | null
  customerOrganisation: string | null
  customerPhone: string | null
  billingAddress: unknown
  shippingAddress: unknown
  /** The shopper's answer about marketing email at the checkout: true happy,
   *  false asked not to be, null never asked. Optional, with the two below, so
   *  an order read without them (a test, an older shop) simply says nothing. */
  marketingConsent?: boolean | null
  orderNumber?: string | null
  createdAt?: Date | null
}

/** The shop's address, as much of it as a contact card holds. Every part
 *  optional: an order written by an older shop, or by hand in the admin, may be
 *  missing any of them, and a missing county is not a reason to lose the rest. */
const OrderAddress = z.object({
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  company: z.string().nullish(),
  line1: z.string().nullish(),
  line2: z.string().nullish(),
  city: z.string().nullish(),
  county: z.string().nullish(),
  postcode: z.string().nullish(),
  country: z.string().nullish(),
  phone: z.string().nullish(),
})

type OrderAddress = z.infer<typeof OrderAddress>

/** A value with its spacing tidied, or null for one that was only whitespace. */
function tidy(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/\s+/g, ' ')
  return trimmed ? trimmed : null
}

/** The same, in the shape a card wants: a missing field is left out rather
 *  than sent empty. */
function field(value: string | null | undefined): string | undefined {
  return tidy(value) ?? undefined
}

function readAddress(value: unknown): OrderAddress | null {
  if (value === null || value === undefined) return null
  const parsed = OrderAddress.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * Where the paperwork goes: the billing address, or the delivery address on an
 * order that has no billing address of its own.
 *
 * The same reading the shop's own invoice makes. An order placed without a
 * separate billing address means "bill me where you deliver", not "bill me
 * nowhere". A billing address that is there but cannot be read is NOT replaced
 * by the delivery one - that address describes a site office or a reception
 * desk, and putting it on the card as where somebody is billed would be making
 * something up.
 */
export function billingAddressOf(order: Pick<ShopOrderCustomer, 'billingAddress' | 'shippingAddress'>): OrderAddress | null {
  if (order.billingAddress !== null && order.billingAddress !== undefined) return readAddress(order.billingAddress)
  return readAddress(order.shippingAddress)
}

let regionNames: Intl.DisplayNames | null | undefined

/**
 * A country as an envelope has it.
 *
 * The shop stores a two-letter code, "GB", and an address book shows "United
 * Kingdom" - which is what somebody typing a card by hand writes, and what the
 * contacts search will be asked for. Anything that is not a two-letter code is
 * taken to be a name already and left alone.
 */
export function countryName(value: string | null | undefined): string | null {
  const code = tidy(value)
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return code
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['en-GB'], { type: 'region' })
    } catch {
      // A runtime without the region data. The code is still an answer.
      regionNames = null
    }
  }
  try {
    return regionNames?.of(code.toUpperCase()) ?? code.toUpperCase()
  } catch {
    return code.toUpperCase()
  }
}

/** Two names compared the way somebody reading them would: case and spacing
 *  are not a difference. */
function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Who the customer is called, in the two boxes a card has.
 *
 * The name on the order is the one given with the email address, so it is the
 * one that belongs to this contact. The billing address carries a first and a
 * last name already split, which is better than guessing at a split - but only
 * when it names the same person. An invoice addressed to "Sue in Accounts"
 * says who opens the post, not who placed the order.
 */
function nameOf(order: ShopOrderCustomer, billing: OrderAddress | null): { firstName?: string; lastName?: string } {
  const full = tidy(order.customerName)
  const first = tidy(billing?.firstName)
  const last = tidy(billing?.lastName)
  const joined = [first, last].filter((part): part is string => !!part).join(' ')
  if (joined && (!full || sameName(joined, full))) {
    return { firstName: first ?? undefined, lastName: last ?? undefined }
  }
  const split = splitName(full)
  return { firstName: field(split.firstName), lastName: field(split.lastName) }
}

/**
 * The card an order would make: name, email address, phone number, company and
 * billing address.
 *
 * Null for an order with no address to file it under. `customer_email` is NOT
 * NULL in the shop's own table, so this is belt and braces - but an address is
 * what the whole address book is keyed on, and a card without one is a card
 * nothing will ever find again.
 *
 * The phone number is the one given as a contact detail, falling back to the
 * one on the billing address. The delivery address's number is never used: it
 * is very often whoever is on site to sign for the parcel.
 */
export function shopCustomerDraft(order: ShopOrderCustomer): ContactDraft | null {
  const email = tidy(order.customerEmail)
  if (!email || !email.includes('@')) return null
  const billing = billingAddressOf(order)
  return {
    ...nameOf(order, billing),
    email,
    phone: field(order.customerPhone) ?? field(billing?.phone),
    phoneLabel: ORDER_PHONE_LABEL,
    // Which of the two this is. An order with no billing address of its own
    // means "bill me where you deliver", so what is on the card is the delivery
    // address and is called that - calling it billing would be making it up.
    addressLabel: hasOwnBilling(order) ? BILLING_LABEL : DELIVERY_LABEL,
    // The company as the shop's own invoice names it: the one given at the
    // checkout, or one left on the address by an order written before that
    // was a separate question.
    organisation: field(order.customerOrganisation) ?? field(billing?.company),
    addressLine1: field(billing?.line1),
    addressLine2: field(billing?.line2),
    addressCity: field(billing?.city),
    addressCounty: field(billing?.county),
    addressPostcode: field(billing?.postcode),
    addressCountry: field(countryName(billing?.country)),
  }
}

export const ORDER_PHONE_LABEL = 'Order'
export const DELIVERY_PHONE_LABEL = 'Delivery'
export const BILLING_LABEL = 'Billing'
export const DELIVERY_LABEL = 'Delivery'

/** Whether the order has a billing address of its own that can be read. */
/**
 * Whether two numbers as typed are the same line.
 *
 * The checkout keeps the contact number as the shopper typed it and the
 * delivery one in international form, so `07311 351565` and `+447311351565`
 * arrive on one order meaning one phone. Digits alone call those different and
 * put the number on the card twice. A national number's leading 0 stands in for
 * a one-to-three digit country code, so that is the only gap allowed: the
 * international digits must end with the national ones after their 0.
 */
export function samePhoneNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = (a ?? '').replace(/\D/g, '')
  const db = (b ?? '').replace(/\D/g, '')
  if (!da || !db) return false
  if (da === db) return true
  const [national, international] = da.startsWith('0') && !db.startsWith('0') ? [da, db]
    : db.startsWith('0') && !da.startsWith('0') ? [db, da]
    : [null, null]
  if (!national || !international) return false
  const rest = national.replace(/^0+/, '')
  const codeLength = international.length - rest.length
  return rest.length >= 6 && codeLength >= 1 && codeLength <= 3 && international.endsWith(rest)
}

function hasOwnBilling(order: Pick<ShopOrderCustomer, 'billingAddress'>): boolean {
  return order.billingAddress !== null && order.billingAddress !== undefined
    && readAddress(order.billingAddress) !== null
}

/** What an order says beyond the one number and one address the card has room
 *  for in its ordinary boxes: the number of whoever is on site for the
 *  delivery, and the delivery address where it is not the billing one. Each
 *  labelled, because "Delivery" is the whole of why they are kept apart. */
export type ShopCustomerExtras = { phones: LabelledPhone[]; addresses: LabelledAddress[] }

export function shopCustomerExtras(order: ShopOrderCustomer): ShopCustomerExtras {
  const shipping = readAddress(order.shippingAddress)
  const extras: ShopCustomerExtras = { phones: [], addresses: [] }
  if (!shipping) return extras

  const orderPhone = field(order.customerPhone) ?? field(billingAddressOf(order)?.phone)
  const deliveryPhone = field(shipping.phone)
  if (deliveryPhone && !samePhoneNumber(deliveryPhone, orderPhone)) {
    extras.phones.push({ label: DELIVERY_PHONE_LABEL, value: deliveryPhone })
  }

  // Only worth saying separately when billing is its own address and this is a
  // different place - otherwise it is already on the card as the address.
  if (hasOwnBilling(order)) {
    const delivery: LabelledAddress = {
      label: DELIVERY_LABEL,
      addressLine1: field(shipping.line1),
      addressLine2: field(shipping.line2),
      addressCity: field(shipping.city),
      addressCounty: field(shipping.county),
      addressPostcode: field(shipping.postcode),
      addressCountry: field(countryName(shipping.country)),
    }
    const billing = billingAddressOf(order)
    const sameAsBilling = addressKey(delivery) !== null
      && addressKey(delivery) === addressKey({
        addressLine1: billing?.line1, addressPostcode: billing?.postcode,
      })
    if (addressKey(delivery) !== null && !sameAsBilling) extras.addresses.push(delivery)
  }
  return extras
}

/** What an order may write onto somebody who is already in the address book. */
export type ContactFillIn = {
  /** The person's own columns to write, and only those. */
  details: PersonDetails
  /** Rebuilt only when the name boxes are being filled in. */
  displayName?: string | null
  primaryEmail?: string
  /** A company to find or create, only when they have none. */
  organisationName?: string
}

/**
 * The boxes on an existing card that an order may fill in: the empty ones.
 *
 * Nothing already written is ever replaced. Whoever typed a contact's address
 * by hand knows something the order does not - that the invoice address is the
 * head office and the card is for the branch, say - and a checkout quietly
 * rewriting it would be the address book changing under somebody's feet. An
 * order that knows better than the card is a thing for a person to notice and
 * correct, one click away on the card.
 *
 * The name and the address go in whole or not at all. Half a name from one
 * source and half from another is nobody's name, and a postcode from one order
 * under a street from somewhere else is an address that does not exist.
 */
export function fillInBlanks(person: Person, draft: ContactDraft): ContactFillIn {
  const fill: ContactFillIn = { details: {} }

  const hasName = !!(tidy(person.firstName) || tidy(person.lastName))
  if (!hasName && (draft.firstName || draft.lastName)) {
    fill.details.firstName = draft.firstName ?? null
    fill.details.lastName = draft.lastName ?? null
    fill.displayName = contactDisplayName(draft.firstName, draft.lastName, person.displayName)
  }

  const draftAddress = {
    addressLine1: draft.addressLine1 ?? null,
    addressLine2: draft.addressLine2 ?? null,
    addressCity: draft.addressCity ?? null,
    addressCounty: draft.addressCounty ?? null,
    addressPostcode: draft.addressPostcode ?? null,
    addressCountry: draft.addressCountry ?? null,
  }
  if (addressLines(person).length === 0 && addressLines(draftAddress).length > 0) {
    Object.assign(fill.details, draftAddress, { addressLabel: draft.addressLabel ?? null })
  }

  if (!person.primaryEmail && draft.email) fill.primaryEmail = draft.email
  if (!person.organisationId && draft.organisation) fill.organisationName = draft.organisation

  return fill
}

/** Whether a fill-in would write anything at all. */
export function isEmptyFillIn(fill: ContactFillIn): boolean {
  return Object.keys(fill.details).length === 0
    && fill.displayName === undefined
    && fill.primaryEmail === undefined
    && fill.organisationName === undefined
}

/**
 * The order's answer about marketing email, as a record for the card - or null
 * when the checkout never asked, which tells the card nothing and so changes
 * nothing on it.
 *
 * Dated by when the order was placed, which is when they answered.
 */
export function shopOrderConsent(order: ShopOrderCustomer): MarketingConsentRecord | null {
  if (typeof order.marketingConsent !== 'boolean') return null
  if (!order.createdAt || !Number.isFinite(order.createdAt.getTime())) return null
  const number = tidy(order.orderNumber)
  return {
    consent: order.marketingConsent,
    at: order.createdAt,
    source: number ? `Order ${number}` : 'An order',
  }
}
