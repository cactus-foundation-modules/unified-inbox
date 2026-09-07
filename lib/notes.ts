import { replaceSlots } from './products/slots'
import type { ProductRef } from './products/types'

// An internal note is typed as plain text and stored as both. The HTML half is
// built here rather than trusted from the browser: a colleague pasting markup
// into a note has no reason to have it rendered, and running it through a
// sanitiser would only invite the argument about which tags are allowed.

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]!)
}

/**
 * A product slot, while the words around it are being escaped.
 *
 * Letters and digits only, so escaping the note cannot touch it, and nothing
 * anybody types by hand looks like one. The index is only ever an index this
 * function handed out - a note that happens to contain the marker for a product
 * that is not there gets its own words back rather than somebody else's chair.
 */
const MARK = 'uinnoteproduct'
const MARK_RE = new RegExp(`(?:<br>)?${MARK}(\\d+)${MARK}(?:<br>)?`, 'g')

/**
 * Plain text as safe markup: escaped, with line breaks kept.
 *
 * `renderProduct` is how a catalogue item gets into a note. The catalogue goes
 * into the writing box as a SLOT (see products/slots.ts) exactly as it does on
 * an email, so by the time a note reaches here it is words with the odd block of
 * markup in it - and escaping that block would put a div on the screen instead
 * of a chair. So the slots come out first, the words are escaped as they always
 * were, and each product's own markup goes back where its slot was. Returning
 * null for a product takes it out altogether, which is what a product withdrawn
 * between writing the note and saving it wants.
 *
 * Left out, nothing is rendered and a slot is escaped along with everything
 * else, which is what every caller that has no catalogue means.
 */
export function noteHtml(
  text: string,
  renderProduct?: (ref: ProductRef) => string | null,
): string {
  const escape = (value: string) => escapeHtml(value).replace(/\r?\n/g, '<br>')
  if (!renderProduct) return escape(text)

  const blocks: string[] = []
  const marked = replaceSlots(text, (ref) => {
    const html = renderProduct(ref)
    if (html === null) return ''
    blocks.push(html)
    return `\n${MARK}${blocks.length - 1}${MARK}\n`
  })
  // The line breaks either side of the marker become <br> like any other, and
  // are taken back off here: a product prints as a block of its own and does not
  // want a blank line welded to it.
  return escape(marked).replace(MARK_RE, (whole, index) => blocks[Number(index)] ?? whole)
}
