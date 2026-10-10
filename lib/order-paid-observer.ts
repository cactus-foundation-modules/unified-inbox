// What this module does when a shop order is paid for: puts the customer in the
// address book, unless the owner has switched that off.
//
// Registered against the shop's `shop.order-paid` point. The event carries plain
// strings and no shop types, which is the whole reason this file can exist: the
// shop is not a dependency of this module, `requiresModules` is `[]`, and nothing
// here imports '@/modules/shop/...' - that path does not exist at build time on
// an install with no shop. An `orderId` is all it needs; the order itself is read
// by raw SQL, the same as the shop adapter in lib/adapters/shop.ts.
//
// A shop older than the point never gathers this and it simply never runs.
//
// The work is imported lazily. This file sits in the map of extension points the
// public pages read, and the address book, the colleague gate and the adapters
// behind it have no business being loaded to render a product page. A dynamic
// import is a chunk boundary: they are fetched the first time an order is paid,
// and never on a request that only draws a page.

/** The shop's payload, restated locally. Structural, so it stays compatible
 *  without a dependency: the shop passes more than this and nothing here minds. */
export type OrderPaidEvent = {
  orderId: string
  orderNumber: string
  paymentMethod: string
  clearedManually: boolean
}

/**
 * Add the customer on a just-paid order to the contacts.
 *
 * Never throws. The shop already swallows an observer's failure, but this is the
 * end of a payment webhook, and a module that leans on somebody else's catch is
 * a module one refactor away from failing payments. An address book entry that
 * did not get written is a nuisance; a payment that looked like it failed is a
 * customer paying twice.
 */
export async function unifiedInboxOrderPaidObserver(event: OrderPaidEvent): Promise<void> {
  try {
    const { addShopCustomerToContacts } = await import('./shop-customer-sync')
    await addShopCustomerToContacts(event.orderId)
  } catch (err) {
    console.error(`[unified-inbox] could not add the customer on paid order ${event.orderNumber} to contacts`, err)
  }
}

/** The shop's `shop.order-placed-unpaid` payload, restated locally for the
 *  same reason as OrderPaidEvent. */
export type OrderPlacedUnpaidEvent = {
  orderId: string
  orderNumber: string
  paymentMethod: string
}

/**
 * The same, for an order placed on bank transfer or another manual method and
 * not paid for yet.
 *
 * Somebody who emailed in, then ordered on bank transfer, used to stay a
 * stranger on their card - no number, no address, no Customers label - until
 * the money was marked as received, which can be a week. The order is real the
 * moment it is placed. The same order announces order-paid later and runs the
 * sync again; it only ever fills blanks and adds, so the second run is a no-op.
 *
 * Never throws, for the same reason as the paid observer.
 */
export async function unifiedInboxOrderPlacedUnpaidObserver(event: OrderPlacedUnpaidEvent): Promise<void> {
  try {
    const { addShopCustomerToContacts } = await import('./shop-customer-sync')
    await addShopCustomerToContacts(event.orderId)
  } catch (err) {
    console.error(`[unified-inbox] could not add the customer on order ${event.orderNumber} to contacts`, err)
  }
}
