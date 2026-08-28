import { listAttachmentStorageRefs } from './db'

// Provider for the core.media-usage-providers extension point.
//
// Email attachments are stored under this module's own key prefix with NO media
// library row, on purpose: a customer's invoice from accounts@ appearing in the
// media picker for anybody holding media permission would undo per-inbox access
// entirely.
//
// The consequence is that core's storage check sees objects in the bucket that
// no row owns, and an object with no row and nothing pointing at it is
// classified as orphaned - which the storage repair will happily delete. That
// would wipe every email attachment on the site, months later, with nothing to
// restore from.
//
// So this vouches for them. Core folds these strings into the same haystack it
// scans page and module content with, the objects come back as claimed rather
// than orphaned, and nothing offers them up for deletion. Returning the raw
// column values is the whole contract: core matches an item's url, key and id
// against the lot, so there is nothing to resolve here.
export async function unifiedInboxMediaUsageProvider(): Promise<string[]> {
  return listAttachmentStorageRefs()
}
