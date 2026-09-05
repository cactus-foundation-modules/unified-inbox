// ---------------------------------------------------------------------------
// Finding the web addresses in a message that arrived as plain text.
//
// Pure, and apart from the component that draws them, because every awkward
// case here is a sentence rather than a screen: a full stop at the end of a
// sentence is not part of the address, a bracket sometimes is, and a false
// positive turns ordinary prose into something that looks pressable.
//
// Deliberately narrow. http, https, and a bare www., and nothing else - no bare
// domains, because "e.g" and "Ltd.co" are not websites and a reader who has to
// second-guess which underlined words are real is worse off than one with no
// links at all.
// ---------------------------------------------------------------------------

const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi

/** Punctuation that ends a sentence rather than an address. */
const TRAILING = '.,;:!?"\''

export type TextPiece =
  | { kind: 'text'; value: string }
  | { kind: 'link'; value: string; href: string }

/**
 * The text broken into the bits that are addresses and the bits that are not.
 *
 * Nothing here builds markup. The caller turns these into elements, so a
 * message full of angle brackets stays a message full of angle brackets rather
 * than becoming something a browser parses.
 */
export function splitLinks(text: string): TextPiece[] {
  const pieces: TextPiece[] = []
  let at = 0

  for (const match of text.matchAll(URL_IN_TEXT)) {
    const found = trimTrailing(match[0])
    // Trimming can eat the whole match if it was only punctuation after the
    // scheme - "https://." is not an address anybody meant.
    if (!found || /^(?:https?:\/\/|www\.)$/i.test(found)) continue

    const start = match.index
    if (start > at) pieces.push({ kind: 'text', value: text.slice(at, start) })
    pieces.push({ kind: 'link', value: found, href: hrefFor(found) })
    at = start + found.length
  }

  if (at < text.length) pieces.push({ kind: 'text', value: text.slice(at) })
  return pieces
}

/** What the browser should be pointed at. A bare www. is written by somebody
 *  who means https and has left it off. */
export function hrefFor(found: string): string {
  return /^www\./i.test(found) ? `https://${found}` : found
}

/**
 * The address without the sentence's punctuation on the end.
 *
 * "See https://example.co.uk." ends in a full stop; the site does not.
 *
 * Brackets are COUNTED rather than looked for, and that is the whole of the
 * difficulty. "(see https://en.wikipedia.org/wiki/Chair_(furniture))" ends in
 * two closing brackets, one of which belongs to the address and one to the
 * sentence - so asking merely whether the address contains a "(" keeps both and
 * links to a page that does not exist. A closer is dropped only while there are
 * more of them than there are openers.
 */
export function trimTrailing(url: string): string {
  let out = url
  for (;;) {
    const last = out.slice(-1)
    if (last === '') return out
    if (TRAILING.includes(last)) { out = out.slice(0, -1); continue }
    if (last === ')' && count(out, ')') > count(out, '(')) { out = out.slice(0, -1); continue }
    if (last === ']' && count(out, ']') > count(out, '[')) { out = out.slice(0, -1); continue }
    return out
  }
}

function count(value: string, character: string): number {
  let found = 0
  for (const c of value) if (c === character) found += 1
  return found
}
