import type { LinkKind } from '../linking'

// The context rail's adapter interface. S7 and anything after it should add a
// channel or a record source by writing one of these and nothing else.
//
// Three rules run through every adapter in this folder, and none of them is
// negotiable:
//
//   1. READS ONLY. Never a write, never a schema change, never a UI branch in
//      somebody else's module. A conversation hub that repairs another module's
//      data is a conversation hub nobody can uninstall safely.
//   2. RAW SQL ONLY. No import of another module's code, ever. An import drags
//      that module's dependencies into our graph and stops the build the day it
//      is removed; a query merely returns nothing.
//   3. GATED BEFORE IT COSTS ANYTHING. An adapter whose module is absent must
//      render nothing and spend one cheap check working that out - which is why
//      `moduleName`, `tables` and `permission` are declared rather than
//      discovered inside `load`.
//
// The permission is the viewer's, not the module's. Somebody who may read the
// inbox but may not see the shop must not learn what a customer has ordered
// from a panel beside a conversation, and the check belongs here rather than in
// each adapter so that forgetting it is not possible.

/** One record, as the rail draws it. */
export type ContextItem = {
  /** Unique within the section. */
  id: string
  /** What somebody would say out loud: an order number, a quote reference. */
  title: string
  /** One line under the title. Money, dates, a supplier - no jargon. */
  detail: string | null
  /** A short word rendered as a tag, or null for nothing to say. */
  status: string | null
  /** For ordering, newest first. Null sorts last. */
  at: Date | null
  /**
   * ADMIN-ROOT RELATIVE, with no leading slash: `shop/orders/abc123`.
   * The admin path is per site and only the rendering page knows it, which is
   * the same rule core's own conversation summaries follow.
   */
  href: string
}

/** One module's worth of context, as one block in the rail. */
export type ContextSection = {
  moduleName: string
  /** The heading, in plain English for somebody who has never read a manual. */
  label: string
  items: ContextItem[]
  /** How many there are altogether, when only the first few are shown. */
  total: number
  /** Where "see the rest" goes. Admin-root relative, or null for nowhere. */
  moreHref: string | null
}

/** Everything we know about the person, for an adapter to match on. */
export type ContextQuery = {
  /** Their addresses, plus-stripped and lower cased. Never empty in practice. */
  emails: string[]
  /** Their numbers, digits only. */
  phones: string[]
  /** The mail domains of those addresses, minus the free providers. */
  domains: string[]
  /** The organisation's name, when we have worked one out. */
  organisationName: string | null
}

/** A record a pattern proposed and the owning module confirmed it holds. */
export type LinkTarget = {
  moduleName: string
  /** 'order' | 'purchase-order' | 'bill' | 'quote' - the adapter's own word. */
  recordType: string
  recordId: string
  /** What the link says on the screen. */
  label: string
  /** Admin-root relative, no leading slash. */
  href: string
}

export type ContextAdapter = {
  /** The module this reads, exactly as it appears in the module list. */
  moduleName: string
  /** What the viewer must hold before anything at all is fetched. */
  permission: string
  /** Every table `load` and `lookup` touch. All must exist or neither runs. */
  tables: string[]
  /** The records this person has here, or null for "nothing worth a block". */
  load(query: ContextQuery): Promise<ContextSection | null>
  /**
   * Confirm a reference a pattern proposed (auto-linking). Returning null is
   * the normal answer and means the pattern matched something that is not one
   * of ours - which is exactly why a pattern is allowed to be generous.
   */
  lookup?(kind: LinkKind, reference: string): Promise<LinkTarget | null>
}

/** How many rows a section shows before it stops and offers a link to the rest. */
export const SECTION_LIMIT = 5
