// ---------------------------------------------------------------------------
// Matching a cid: address to the part of the message that answers to it.
//
// The markup names a Content-ID; the attachment rows carry one each (migration
// 048). Putting the two together is the whole job, and it is deliberately kept
// as a pure function over rows so it can be tested without a mailbox, a
// database or a session anywhere near it.
//
// Two things make it less trivial than an equality check.
//
//   Senders are sloppy about the brackets. The header is written
//   `Content-ID: <image001.png@01D9>` and the markup quotes it both with and
//   without the angle brackets, sometimes with the case changed on the way.
//
//   Every attachment recorded before migration 048 has no Content-ID at all,
//   including the ones already sitting in live mailboxes. Outlook and Apple
//   Mail both build the Content-ID out of the filename, so the filename is the
//   fallback - and only when exactly one attachment on that message answers to
//   it, because a guess between two candidates is worse than a missing picture.
// ---------------------------------------------------------------------------

/** What this module is prepared to hand back as a picture. Deliberately a list
 *  rather than a `image/*` test: SVG is markup with script in it, and serving
 *  one inline would put a stranger's document on this site's own origin. */
export const DISPLAYABLE_IMAGE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon',
])

/** True when a content type is one of the above, whatever charset or casing the
 *  sender wrote after it. */
export function isDisplayableImageType(contentType: string | null | undefined): boolean {
  if (!contentType) return false
  return DISPLAYABLE_IMAGE_TYPES.has(contentType.split(';')[0]!.trim().toLowerCase())
}

/** As much of an attachment row as matching a Content-ID needs. */
export type InlineImagePart = {
  id: string
  contentId: string | null
  filename: string
  contentType: string | null
}

/** The address the reading frame fetches one inline picture from. Built here so
 *  the route that serves it and the read path that writes it into the markup
 *  cannot drift apart. */
export function inlineImageHref(messageId: string, attachmentId: string): string {
  return `/api/m/unified-inbox/messages/${encodeURIComponent(messageId)}/inline/${encodeURIComponent(attachmentId)}`
}

/**
 * The part a cid: address names, or null when nothing on that message answers
 * to it.
 *
 * A part whose recorded content type is not a picture is never returned: a
 * message can point a cid: image at its own PDF attachment, and the answer to
 * that is an empty box rather than a route that hands a PDF to an img tag. A
 * part with no recorded type at all is still a candidate - the type is filled
 * in when the bytes are fetched, and the route checks it again then.
 */
export function matchInlinePart(cid: string, parts: readonly InlineImagePart[]): InlineImagePart | null {
  const wanted = normalise(cid)
  if (!wanted) return null

  const candidates = parts.filter((p) => p.contentType === null || isDisplayableImageType(p.contentType))

  const byContentId = candidates.find((p) => p.contentId && normalise(p.contentId) === wanted)
  if (byContentId) return byContentId

  // Nothing declared that name, which is every attachment on the site that
  // arrived before the Content-ID was recorded. Fall back to the filename, both
  // whole and against the part of the address in front of the @ - Outlook writes
  // `image001.png@01D9A2`, Apple Mail writes the filename on its own.
  const local = wanted.split('@')[0]!
  const byFilename = candidates.filter((p) => {
    const filename = normalise(p.filename)
    return filename !== '' && (filename === wanted || filename === local)
  })
  return byFilename.length === 1 ? byFilename[0]! : null
}

function normalise(value: string): string {
  return value.trim().replace(/^<|>$/g, '').trim().toLowerCase()
}
