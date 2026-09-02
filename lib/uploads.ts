import { MAX_UPLOAD_BYTES } from '@/lib/media/limits'

// ---------------------------------------------------------------------------
// Dropping a file onto a message you are writing.
//
// The picker beside this one lists what is already in the media library and
// attaches it by where it lives. That is still how a photograph from the
// library gets onto a message, and it is still the only way anything reaches
// the send route - an attachment is described by its place in storage, never by
// bytes in a send request.
//
// What was missing was the other half: the quote that is on your desktop and
// nowhere else. Dragging it in puts it into storage first, under this module's
// own prefix with no library row, exactly where an inbound attachment goes, and
// what comes back is an ordinary reference the composer can then attach. So the
// send path is untouched, and a file dropped on a message is invisible to the
// media picker for the same reason a customer's invoice is (see attachments.ts).
//
// Everything in this file is pure and free of server imports on purpose: the
// browser refuses a file before uploading it and the route refuses it again on
// arrival, and both have to give the same answer for the same reason. One set
// of rules, read from two places.
// ---------------------------------------------------------------------------

/**
 * The most one dropped file may weigh.
 *
 * Not a rule about email - a message may carry 8MB of attachments and does so
 * happily when they come out of the library. It is the hosting platform: a
 * serverless function's request body is capped, and a bigger file is refused by
 * the edge before this module's route ever runs, with a reply that is not even
 * JSON. So the drop is bounded at the same number core's own uploader uses, and
 * anything larger is sent to the library, which has a direct-to-storage path
 * this one does not.
 */
export const MAX_DROPPED_BYTES = MAX_UPLOAD_BYTES

/** How many files one drop may carry. The composer's own ceiling is twenty
 *  attachments (see validation.ts), and a folder emptied onto the box by
 *  accident should be refused as a whole rather than half-uploaded. */
export const MAX_DROPPED_FILES = 20

/**
 * What must not be uploaded, by the extension it ends in.
 *
 * Every mail service in existence refuses to deliver most of these, so a person
 * who attaches one is writing a message that will bounce, and finding that out
 * at Send is finding it out too late. The rest are here because these bytes go
 * into the same object storage the site serves its pictures from: a page of
 * markup stored there and opened later is a script running on the media origin,
 * whatever the Worker's content-disposition says today.
 *
 * Read off the LAST extension only. "invoice.pdf.exe" is an exe, and that is
 * the whole trick it is trying to play.
 */
export const BLOCKED_EXTENSIONS = new Set([
  // Windows executables and installers
  'exe', 'com', 'bat', 'cmd', 'msi', 'msp', 'scr', 'pif', 'cpl', 'msc', 'gadget',
  'dll', 'sys', 'drv', 'reg', 'lnk', 'scf', 'inf', 'ins', 'isp', 'hta', 'chm',
  // macOS, Linux and mobile packages
  'app', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'iso', 'vhd',
  // Scripts of every persuasion
  'js', 'mjs', 'cjs', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1',
  'sh', 'bash', 'zsh', 'py', 'rb', 'php', 'pl', 'jar', 'jnlp', 'swf',
  // Markup, which is a script wearing a hat
  'htm', 'html', 'xhtml', 'shtml', 'svg', 'xht',
])

/** The extension a name ends in, lower case, or '' when it has none. */
export function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

/**
 * The type to store a dropped file under.
 *
 * The browser's own answer whenever it has one, because for the everyday cases
 * - a PDF, a photograph, a spreadsheet - it is right and it is what the far end
 * needs to see on the attachment. Safari and Windows both hand back an empty
 * string for anything they do not recognise, and an attachment with no type at
 * all arrives as something the recipient's mail program will not offer to open,
 * so the common office extensions are filled in here and everything else falls
 * back to the generic "some bytes" type, which every mail client understands as
 * "download it".
 */
const EXTENSION_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  zip: 'application/zip',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
}

export function typeForUpload(filename: string, declaredType: string | null): string {
  const declared = (declaredType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (declared) return declared
  return EXTENSION_TYPES[extensionOf(filename)] ?? 'application/octet-stream'
}

/** How big it is, in the units a person uses. Its own copy rather than a shared
 *  one, because compose.ts is server code and this is read in the browser. */
export function describeBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes} bytes`
}

/**
 * The name to travel with the attachment, kept inside what the send route will
 * accept. Clipped in the middle rather than at the end, because the extension
 * is the part a recipient's computer reads to decide what to open it with, and
 * a name is truncated far less often than it is long.
 */
export function clampFilename(filename: string, max = 200): string {
  const name = (filename.split(/[\\/]/).pop() ?? filename).trim()
  if (name.length <= max) return name
  const ext = extensionOf(name)
  const tail = ext ? `.${ext}` : ''
  return `${name.slice(0, Math.max(1, max - tail.length))}${tail}`
}

/**
 * Why this file cannot be attached, or null when it can.
 *
 * A sentence rather than a code, because it is shown to the person who dropped
 * it and their next move depends on which of these it was.
 */
export function refuseDroppedFile(file: { name: string; type: string; size: number }): string | null {
  const name = file.name.trim()
  if (!name) return 'That does not appear to be a file.'

  // A folder arrives as a nameless, typeless, sizeless thing on every browser
  // that lets one be dropped at all, and uploading it would send an empty file
  // named after the folder. Said plainly, because "0 bytes" is not an answer.
  if (file.size === 0) {
    return `"${name}" is empty, or it is a folder. Drop the files inside it instead.`
  }
  if (BLOCKED_EXTENSIONS.has(extensionOf(name))) {
    return `"${name}" is a kind of file email services refuse to deliver, so it cannot be attached. Put it in a zip, or send a link to it.`
  }
  if (file.size > MAX_DROPPED_BYTES) {
    return `"${name}" is ${describeBytes(file.size)}. Files dropped onto a message have to be under ${describeBytes(MAX_DROPPED_BYTES)}. Add it to your files first, then use Attach a file.`
  }
  return null
}
