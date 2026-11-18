// The delivery services a product can be bought with, read from whichever
// module publishes them at `shop.product-delivery-timing` - Advanced Shipping
// today, anything else tomorrow.
//
// An OPTIONAL companion, never a dependency, and looked up through core's
// generated registry rather than imported: the registry is built from the
// manifests of the modules actually installed, so on a site without one the
// point is empty and nothing here names a module that is not there. Naming
// '@/modules/advanced-shipping-for-shop/...' would break the build on every
// install that has not got it. Google Shopping and the shop's own structured
// data read the same point the same way.
//
// What comes back is RAW: a service's name and its price in major units, on the
// same side of tax as the product's stored price. Turning that into a figure a
// customer reads is the product source's job (./shop.ts), because only it knows
// the product's tax rate and how the shop prints money.

const POINT = 'shop.product-delivery-timing'

/** Stops a key reaching a class token or a query string with anything in it
 *  either would need escaping for. Restated in ./slots.ts, which is built into
 *  the browser and cannot import this file's registry edge. */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/

/** One service off the provider's menu, before anybody has priced it for a
 *  customer. */
export type RawDeliveryOption = {
  key: string
  label: string
  description: string | null
  /** NET, in major units, on the product's own side of tax. */
  price: number
}

type TimingProvider = (productIds: string[]) => Promise<Map<string, unknown>>

/** The registered provider, or null where no module publishes delivery timing.
 *
 *  Dynamic on purpose, as in the shop's own reader: a static edge to the
 *  generated registry from a file the inbox screens import would put every
 *  module's public components in their graph for the sake of one function. */
async function provider(): Promise<TimingProvider | null> {
  const { modulePublicExtensionPointComponents } = await import('@/lib/modules/extension-points.public')
  const registered: Record<string, unknown> = modulePublicExtensionPointComponents[POINT] ?? {}
  return Object.values(registered).find((entry): entry is TimingProvider => typeof entry === 'function') ?? null
}

/** Whether any installed module publishes delivery services at all - which is
 *  what decides whether the composer offers to add one. */
export async function hasDeliveryProvider(): Promise<boolean> {
  try {
    return (await provider()) !== null
  } catch {
    return false
  }
}

// One service, checked rather than trusted: it crosses a registry seam with no
// shared types, so a shape that has drifted costs that one service and not the
// menu. A key this module could not carry in a slot is dropped the same way.
function readOption(value: unknown): RawDeliveryOption | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  const key = typeof row.key === 'string' ? row.key.trim() : ''
  const label = typeof row.label === 'string' ? row.label.trim() : ''
  if (!KEY_PATTERN.test(key) || !label) return null
  const price = row.price
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) return null
  const description = typeof row.description === 'string' ? row.description.trim() : ''
  return { key, label, description: description || null, price }
}

/**
 * The services each of these products can be bought with, keyed by product id,
 * in the order the basket lists them. A product the provider will not deliver is
 * absent; so is everything when no module publishes delivery, or it fails - a
 * message never fails over a delivery line.
 */
export async function deliveryOptionsFor(productIds: readonly string[]): Promise<Map<string, RawDeliveryOption[]>> {
  const out = new Map<string, RawDeliveryOption[]>()
  const ids = [...new Set(productIds)].filter(Boolean)
  if (ids.length === 0) return out
  try {
    const timing = await provider()
    if (!timing) return out
    const answered = await timing(ids)
    if (!(answered instanceof Map)) return out
    for (const [productId, value] of answered) {
      if (typeof productId !== 'string' || typeof value !== 'object' || value === null) continue
      const seen = new Set<string>()
      const options: RawDeliveryOption[] = []
      const list = (value as Record<string, unknown>).options
      for (const entry of Array.isArray(list) ? list : []) {
        const option = readOption(entry)
        if (!option || seen.has(option.key)) continue
        seen.add(option.key)
        options.push(option)
      }
      if (options.length > 0) out.set(productId, options)
    }
  } catch (err) {
    console.error('[unified-inbox] could not read the delivery services for a message:', err)
  }
  return out
}
