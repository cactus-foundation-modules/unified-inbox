import { prisma } from '@/lib/db/prisma'
import {
  addPersonCategories, findOrCreateCategory, findPersonByIdentity, getPerson, getSettings, updatePerson,
} from './db'
import { attachContactIdentities, resolveOrganisation, saveContact } from './contact-store'
import { buildResolutionContext } from './identity'
import { identityKey, shouldBecomePerson } from './people'
import { fillInBlanks, isEmptyFillIn, shopCustomerDraft, type ShopOrderCustomer } from './shop-customers'

// ---------------------------------------------------------------------------
// Somebody paid for an order: put them in the address book.
//
// Runs off the shop's own `shop.order-paid` announcement (see
// lib/order-paid-observer.ts), which the shop makes exactly once per order
// however the money arrived. Nothing in the shop knows this file exists, and a
// site running the shop without this module never loads it.
//
// Paid rather than placed, on purpose and because it is the announcement the
// shop makes. An order sitting on a bank transfer nobody has sent is not yet a
// customer, and the day the payment is marked as received is the day they
// become one - that is when this runs for them.
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
//   contacts claiming one phone number is a merge for a person to decide on.
//
// Every one of them is filed under Customers, new or already known: somebody
// who emailed in March and paid in April is as much a customer as somebody who
// arrived through the checkout, and a Customers category missing everybody who
// wrote in first would be a list nobody could trust for a campaign. Only ever
// added - a label somebody else put on them stays on.
// ---------------------------------------------------------------------------

/** The category every paying customer is filed under. Found by name, however
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

async function readOrderCustomer(orderId: string): Promise<ShopOrderCustomer | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "customer_name", "customer_email", "customer_organisation", "customer_phone",
           "billing_address", "shipping_address"
      FROM "shp_orders"
     WHERE "id" = ${orderId}
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
  }
}

/**
 * The customer on one paid order, created as a contact or filled in on the one
 * they already have.
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
  const existingId = await findPersonByIdentity([key])
  if (!existingId) {
    await saveContact(null, draft, { origin: 'order', categoryMode: 'add', extraCategoryIds: [categoryId] })
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
  await attachContactIdentities(person.id, { phone: draft.phone }, 'order')
  await addPersonCategories(person.id, [categoryId])
  return 'existing'
}
