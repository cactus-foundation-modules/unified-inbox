// ---------------------------------------------------------------------------
// Which files on an arriving email are put in the media library before anybody
// opens them, for the modules listening on `unified-inbox.message-received`.
//
// Ordinarily nothing is: an attachment's bytes stay on the mail server until
// somebody opens it. A listener that reads paperwork needs the file in hand,
// so it may ask for files of certain kinds - and the inbox then stores those,
// and only those, as they arrive. Three rules keep that from becoming "the
// site hosts whatever a stranger emails it":
//
//   - Opt-in. Only the kinds a listener asked for are stored, and nothing at
//     all when no listener asked.
//   - The file is judged by its first bytes, never by the type the sender
//     wrote on it. A web page labelled "application/pdf" is a web page, and is
//     not stored. The stored copy carries the type its bytes prove.
//   - Only kinds that can be proved that way are storable at all: PDFs and the
//     plain picture formats. Web pages, SVG (which can carry script), and
//     anything executable are never stored eagerly whatever is asked for,
//     because a file on the site's own media domain is served as the site's
//     own. Somebody opening one in the conversation still can, as ever.
//
// Pure, so it is tested without a mail server or storage.
// ---------------------------------------------------------------------------

/** A total per message, so one email with forty scans cannot take the
 *  collecting pass's slice or a gigabyte of storage with it. */
export const MAX_EAGER_BYTES_PER_MESSAGE = 30 * 1024 * 1024

type Sniffer = (bytes: Uint8Array) => boolean

const startsWith = (bytes: Uint8Array, signature: number[], at = 0): boolean =>
  bytes.length >= at + signature.length && signature.every((b, i) => bytes[at + i] === b)

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0))

/**
 * The only kinds ever stored eagerly, each with the test its bytes must pass.
 * Adding one here is a decision about what the site will host unasked, and
 * belongs only to a format whose signature cannot be forged into markup.
 */
const SNIFFERS: Record<string, Sniffer> = {
  // "%PDF-", after nothing but blank bytes. Readers tolerate a kilobyte of any
  // junk in front, but "any junk" is how a web page could carry the signature
  // halfway down and be stored as a PDF, so only whitespace and NULs - which
  // is what the odd producer actually puts there - are let past.
  'application/pdf': (b) => {
    let at = 0
    while (at < b.length && at < 1024 && (b[at] === 0x20 || b[at] === 0x09 || b[at] === 0x0a
      || b[at] === 0x0d || b[at] === 0x0c || b[at] === 0x00)) at++
    return startsWith(b, ascii('%PDF-'), at)
  },
  'image/png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/gif': (b) => startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a')),
  'image/webp': (b) => startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8),
}

/** Every kind a listener may ask for. Anything else it names is ignored. */
export const STORABLE_TYPES: ReadonlySet<string> = new Set(Object.keys(SNIFFERS))

/**
 * What a list of kinds a listener asked for comes to: lower-cased, trimmed,
 * and cut down to the storable ones. Anything that is not an array of strings
 * is nothing asked for.
 */
export function storableTypesFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const type = item.trim().toLowerCase()
    if (STORABLE_TYPES.has(type)) out.add(type)
  }
  return [...out]
}

/** The storable kind these bytes prove themselves to be, or null. */
export function sniffStorableType(bytes: Uint8Array): string | null {
  for (const [type, sniff] of Object.entries(SNIFFERS)) {
    if (sniff(bytes)) return type
  }
  return null
}

/**
 * The cheap first cut, from what the row says before any bytes are fetched:
 * worth fetching only when the sender's own label is one of the kinds asked
 * for and the size is known to fit. The bytes still decide afterwards - a
 * label is the sender's word, and only rules a file OUT.
 */
export function worthFetching(
  row: { contentType: string | null; sizeBytes: number | null },
  wanted: ReadonlySet<string>,
  budgetLeft: number,
): boolean {
  if (wanted.size === 0) return false
  const labelled = (row.contentType ?? '').split(';')[0]!.trim().toLowerCase()
  // Mail programs label PDFs "application/octet-stream" often enough that the
  // generic label is let through to be sniffed.
  if (!wanted.has(labelled) && labelled !== 'application/octet-stream') return false
  if (row.sizeBytes !== null && row.sizeBytes > budgetLeft) return false
  return true
}

/**
 * Whether one file's bytes may be stored: the kind they prove is one that was
 * asked for, and they fit in what is left of the message's allowance. Returns
 * the proved kind, which is what the stored copy is labelled with.
 */
export function storableAs(
  bytes: Uint8Array,
  wanted: ReadonlySet<string>,
  budgetLeft: number,
): string | null {
  if (wanted.size === 0 || bytes.length === 0 || bytes.length > budgetLeft) return null
  const proved = sniffStorableType(bytes)
  return proved && wanted.has(proved) ? proved : null
}
