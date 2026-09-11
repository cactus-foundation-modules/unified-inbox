import { listAttachmentStorageRefs } from './db'

// Provider for the core.media-usage-providers extension point.
//
// Two quite different sets of objects are vouched for here, and both would be
// classified as orphaned without it - an object with no library row and nothing
// pointing at it is the exact shape of a leftover, and the storage repair
// deletes leftovers.
//
// The first is everything still kept outside the library on purpose: inline
// parts, anything with no correspondent to file it under, and a dropped file
// waiting for its message to be sent. Those have no row at all.
//
// The second is the files somebody attached FROM the library, whose key this
// module holds without owning. Those have a row already, and listing them here
// is what stops the library offering a product photograph for deletion on the
// grounds that nothing appears to use it when an email does.
//
// So this vouches for them. Core folds these strings into the same haystack it
// scans page and module content with, the objects come back as claimed rather
// than orphaned, and nothing offers them up for deletion. Returning the raw
// column values is the whole contract: core matches an item's url, key and id
// against the lot, so there is nothing to resolve here.
export async function unifiedInboxMediaUsageProvider(): Promise<string[]> {
  return listAttachmentStorageRefs()
}
