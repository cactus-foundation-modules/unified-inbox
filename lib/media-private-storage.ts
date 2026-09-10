// Contribution to the core.media-private-storage extension point.
//
// Attachments are written under this module's own folder with no media library
// row at all - see the long note at the top of attachments.ts for why a
// customer's invoice must never appear in the media picker. Declaring the folder
// here is the other half of that: core's storage check then files these objects
// as "kept outside the library on purpose", rather than as files missing a
// library entry that an admin is invited to put right.
//
// A bare literal, and deliberately not imported from attachments.ts. Everything
// contributed to an extension point is statically imported by the generated
// public map, and attachments.ts drags in the mail parser and the IMAP client -
// which is a lot of server-only code to hang off a single folder name.
export const unifiedInboxPrivateStorage: readonly string[] = ['unified-inbox']
