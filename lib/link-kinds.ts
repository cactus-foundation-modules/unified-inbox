import type { LinkKind } from './linking'

// Which kinds of record a conversation may have attached to it, and which one
// the picker should be showing when it opens.
//
// Nothing here touches a database or a module: the list of kinds is worked out
// from the adapters that can actually run for this viewer, and the choice
// between them is made from the modules the open inbox sends for. Keeping the
// choosing separate from the fetching is what lets it be tested without a shop.

export type LinkKindOption = {
  id: LinkKind
  /** What somebody calls it out loud: 'Order', 'Purchase order'. */
  label: string
  /** The module that owns it, which is how an inbox is matched to a kind. */
  moduleName: string
}

/**
 * The kind to start on.
 *
 * `moduleNames` is what the open inbox is used for - the modules whose own post
 * leaves as that address, so an inbox purchasing sends from opens on purchase
 * orders and the shop's opens on orders. First module with an offered kind
 * wins, which puts the answer in the site's hands: the order of that list is
 * the order the site set its sending addresses in.
 *
 * No module claiming the inbox, or the one that does having no records to
 * offer, falls back to the first kind on the list rather than to nothing. A
 * picker that opens on an empty choice is a picker somebody has to work out.
 */
export function defaultLinkKind(
  options: readonly LinkKindOption[],
  moduleNames: readonly string[],
): LinkKind | null {
  if (options.length === 0) return null
  for (const moduleName of moduleNames) {
    const match = options.find((o) => o.moduleName === moduleName)
    if (match) return match.id
  }
  return options[0]?.id ?? null
}
