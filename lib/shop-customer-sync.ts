import { prisma } from '@/lib/db/prisma'
import {
  addPersonAddressIfMissing, addPersonCategories, findOrCreateCategory, findPersonByIdentity, getPerson,
  getSettings, listIdentities, mergePeople, recordMarketingConsent, updatePerson,
} from './db'
import { attachContactIdentities, resolveOrganisation, saveContact } from './contact-store'
import { buildResolutionContext } from './identity'
import { identityKey, phoneKey, shouldBecomePerson } from './people'
import { siteDiallingCode } from '@/lib/phone.server'
import {
  BILLING_LABEL, fillInBlanks, isEmptyFillIn, shopCustomerDraft, shopCustomerExtras, shopOrderConsent,
  type ShopOrderCustomer,
} from './shop-customers'
import { addressLines } from './contacts'

// ---------------------------------------------------------------------------
// Somebody ordered: put them in the address book.
//
// Runs off two of the shop's own announcements (see lib/order-paid-observer.ts):
// `shop.order-paid`, made exactly once per order however the money arrived, and
// `shop.order-placed-unpaid`, made once when a shopper finishes checking out on
// bank transfer or another manual method. Nothing in the shop knows this file
// exists, and a site running the shop without this module never loads it.
//
// Placed as well as paid, learned the hard way: somebody emailed in, ordered on
// bank transfer, and their card sat there without the number, the address or
// the Customers label for as long as the transfer took. A bank-transfer order is
// a real customer from the moment it is placed. Card orders announce paid
// seconds after placing, so they come through the paid one. A bank-transfer
// order announces both, and the second run changes nothing - see below.
//
// Three rules, each of which is the difference between an address book that
// helps and one somebody has to tidy up after:
//
//   Nobody already here is copied. They are found by their email address and
//   filled in, and only where their card is blank - see fillInBlanks.
//
//   Nobody who is one of us becomes a contact. The same gate the post goes
//   through: an order placed by a colleague testing the checkout from their
//   work address is not a customer.
//
//   An address or a number somebody else already holds stays where it is. Two
//   contacts claiming one phone number is a merge for a person to decide on -
//   with one exception: a holder that is only a number the phone assistant or a
//   text once came from (no name, no address, nothing else on the card) has
//   nobody to disagree with. The customer absorbs it, so the call history comes
//   with the number instead of the number being refused.
//
// Every one of them is filed under Customers, new or already known: somebody
// who emailed in March and ordered in April is as much a customer as somebody who
// arrived through the checkout, and a Customers category missing everybody who
// wrote in first would be a list nobody could trust for a campaign. Only ever
// added - a label somebody else put on them stays on.
// ---------------------------------------------------------------------------

/** The category every ordering customer is filed under. Found by name, however
 *  it was typed, and made the first time it is needed. Renamed, it stops being
 *  found and the next paid order makes a fresh one - the name is the handle. */
export const SHOP_CUSTOMER_CATEGORY = 'Customers'

/** What happened, for the tests. 'existing' is somebody already in the
 *  address book, filled in where their card was blank - which may be nowhere. */
export type ShopCustomerOutcome =
  | 'created'
  | 'existing'
  | 'switched-off'
  | 'colleague'
  | 'no-order'
  | 'no-address'

/** Somebody a call or text from this number created, and nothing more: no
 *  name of their own, no address, nothing but phone numbers. */
async function isNumberOnlyContact(personId: string): Promise<boolean> {
  const person = await getPerson(personId)
  if (!person || person.mergedIntoId || person.origin !== 'mail') return false
  if (person.primaryEmail || person.firstName || person.lastName || person.organisationId || person.notes) return false
  const identities = await listIdentities(personId)
  if (identities.length === 0 || identities.some((identity) => identity.kind !== 'phone')) return false
  return !person.displayName || identities.some((identity) => identity.value === person.displayName)
}

/** Numbers this customer was refused because a number-only contact holds them:
 *  that contact is folded into the customer (a merge that can be undone). */
async function absorbNumberOnlyHolders(personId: string, refused: string[]): Promise<void> {
  if (refused.length === 0) return
  const diallingCode = await siteDiallingCode()
  for (const phone of refused) {
    const key = phoneKey(phone, diallingCode)
    const holderId = key ? await findPersonByIdentity([key]) : null
    if (!holderId || holderId === personId || !(await isNumberOnlyContact(holderId))) continue
    await mergePeople(personId, holderId, null)
  }
}

export async function readOrderCustomer(orderId: string): Promise<ShopOrderCustomer | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT o."customer_name", o."customer_email", o."customer_organisation", o."customer_phone",
           o."billing_address", o."shipping_address", o."order_number", o."created_at",
           -- Through the row's JSON rather than by name: a shop older than its
           -- marketing question has no such column, and naming one that is not
           -- there would fail the whole read instead of leaving the answer out.
           to_jsonb(o) -> 'marketing_consent' AS marketing_consent
      FROM "shp_orders" o
     WHERE o."id" = ${orderId}
     LIMIT 1
  `
  const r = rows[0]
  if (!r) return null
  return {
    customerName: (r.customer_name as string | null) ?? null,
    customerEmail: (r.customer_email as string | null) ?? null,
    customerOrganisation: (r.customer_organisation as string | null) ?? null,
    customerPhone: (r.customer_phone as string | null) ?? null,
    billingAddress: r.billing_address ?? null,
    shippingAddress: r.shipping_address ?? null,
    marketingConsent: typeof r.marketing_consent === 'boolean' ? r.marketing_consent : null,
    orderNumber: (r.order_number as string | null) ?? null,
    createdAt: r.created_at instanceof Date ? r.created_at : null,
  }
}

/**
 * The customer on one order, created as a contact or filled in on the one
 * they already have. Safe to run more than once on the same order: it only
 * fills blanks and adds what the card does not already hold.
 *
 * Throws on a database failure; the observer that calls it is what makes sure
 * that can never reach a payment webhook.
 */
export async function addShopCustomerToContacts(orderId: string): Promise<ShopCustomerOutcome> {
  // The cheapest question first, and the only one asked on a site that has
  // switched this off.
  const settings = await getSettings()
  if (!settings.shopCustomerContacts) return 'switched-off'

  const order = await readOrderCustomer(orderId)
  if (!order) return 'no-order'
  const draft = shopCustomerDraft(order)
  const key = identityKey(draft?.email)
  if (!draft?.email || !key) return 'no-address'

  const { gate } = await buildResolutionContext()
  if (!shouldBecomePerson(draft.email, gate)) return 'colleague'

  const categoryId = await findOrCreateCategory(SHOP_CUSTOMER_CATEGORY)
  const extras = shopCustomerExtras(order)
  const existingId = await findPersonByIdentity([key])
  if (!existingId) {
    const created = await saveContact(null, draft, {
      origin: 'order', categoryMode: 'add', extraCategoryIds: [categoryId],
    })
    const { personId } = created
    // The delivery number and the delivery address, beside the order's own.
    const refused = [...created.refused]
    for (const phone of extras.phones) {
      refused.push(...await attachContactIdentities(personId, { phone: phone.value, phoneLabel: phone.label }, 'order'))
    }
    await absorbNumberOnlyHolders(personId, refused)
    for (const address of extras.addresses) {
      await addPersonAddressIfMissing(personId, {
        label: address.label ?? null,
        addressLine1: address.addressLine1 ?? null,
        addressLine2: address.addressLine2 ?? null,
        addressCity: address.addressCity ?? null,
        addressCounty: address.addressCounty ?? null,
        addressPostcode: address.addressPostcode ?? null,
        addressCountry: address.addressCountry ?? null,
      })
    }
    const consent = shopOrderConsent(order)
    if (consent) await recordMarketingConsent(personId, consent)
    return 'created'
  }

  // A person merged away resolves to whoever they were merged into, so this is
  // the card somebody will actually open.
  const person = await getPerson(existingId)
  if (!person) return 'existing'

  const fill = fillInBlanks(person, draft)
  const organisationId = fill.organisationName
    ? (await resolveOrganisation(fill.organisationName, 'order')).id
    : undefined
  if (!isEmptyFillIn(fill)) {
    await updatePerson(person.id, {
      ...fill.details,
      ...(fill.displayName === undefined ? {} : { displayName: fill.displayName }),
      ...(fill.primaryEmail === undefined ? {} : { primaryEmail: fill.primaryEmail }),
      ...(organisationId ? { organisationId } : {}),
    })
  }

  // The number only. Added rather than filled in: somebody can have several,
  // and the one they gave the shop is how they will be recognised when they
  // ring about the order. One already held by somebody else is left there.
  // The address is not attached again - it is how they were found, and the
  // same one typed in capitals this time would otherwise sit on the card twice.
  const refused = await attachContactIdentities(person.id, { phone: draft.phone, phoneLabel: draft.phoneLabel }, 'order')
  for (const phone of extras.phones) {
    refused.push(...await attachContactIdentities(person.id, { phone: phone.value, phoneLabel: phone.label }, 'order'))
  }
  await absorbNumberOnlyHolders(person.id, refused)
  // Their billing and delivery addresses, each added only where the card does
  // not already hold it. The billing one is not a "further" address when the
  // card was blank and has just taken it as its own, so it is offered too and
  // the same-address check turns it away.
  const orderAddresses = [
    ...(addressLines(draft).length > 0 ? [{
      label: draft.addressLabel ?? BILLING_LABEL,
      addressLine1: draft.addressLine1 ?? null,
      addressLine2: draft.addressLine2 ?? null,
      addressCity: draft.addressCity ?? null,
      addressCounty: draft.addressCounty ?? null,
      addressPostcode: draft.addressPostcode ?? null,
      addressCountry: draft.addressCountry ?? null,
    }] : []),
    ...extras.addresses.map((a) => ({
      label: a.label ?? null,
      addressLine1: a.addressLine1 ?? null,
      addressLine2: a.addressLine2 ?? null,
      addressCity: a.addressCity ?? null,
      addressCounty: a.addressCounty ?? null,
      addressPostcode: a.addressPostcode ?? null,
      addressCountry: a.addressCountry ?? null,
    })),
  ]
  for (const address of orderAddresses) await addPersonAddressIfMissing(person.id, address)
  await addPersonCategories(person.id, [categoryId])
  // Their answer about marketing, if this order asked - and only if it is newer
  // than whatever the card already holds.
  const consent = shopOrderConsent(order)
  if (consent) await recordMarketingConsent(person.id, consent)
  return 'existing'
}
