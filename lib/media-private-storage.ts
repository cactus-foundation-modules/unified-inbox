// Contribution to the core.media-private-storage extension point.
//
// Most attachments are ordinary media library items, filed under whoever the
// correspondence was with - see lib/attachment-filing.ts. What stays in this
// module's own folder with no library row is the rest: inline parts (a
// signature logo, a pasted screenshot), anything with no correspondent to file
// it under, and a file dropped onto a message that has not been sent yet.
// Declaring the folder here is what tells core's storage check those objects are
// kept outside the library on purpose, rather than being files missing a library
// entry that an admin is invited to put right.
//
// A bare literal, and deliberately not imported from attachments.ts. Everything
// contributed to an extension point is statically imported by the generated
// public map, and attachments.ts drags in the mail parser and the IMAP client -
// which is a lot of server-only code to hang off a single folder name.
export const unifiedInboxPrivateStorage: readonly string[] = ['unified-inbox']
