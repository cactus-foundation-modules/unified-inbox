import type { ConversationTextStyles } from '@/lib/conversations/types'

// Turning what somebody wrote into what the channel writes it as.
//
// A reply typed in the writing box is markup: <strong>, <em>, the browser's own
// tags. A channel another module owns takes one string, so that markup used to
// be flattened away entirely and a customer read a reply with the emphasis
// gone. WhatsApp, and every chat channel like it, does have emphasis - it is
// simply written with a marker on each side rather than with a tag.
//
// NOTHING HERE KNOWS WHICH CHANNEL IT IS SERVING. The markers arrive as data,
// declared by the provider through `capabilities.textStyles`, so this file
// wraps whatever it is handed: an asterisk, a pair of asterisks, an underscore.
// The day a second channel with different markers is published, nothing here
// changes. A style the channel did not declare is dropped as it always was,
// which is the honest outcome - a colour cannot be written on WhatsApp at all.
//
// Runs BEFORE the flattener rather than after, because it needs the tags: once
// htmlToText has been over it the emphasis is gone and there is nothing left to
// mark. What comes out of here is still markup, minus the tags it has turned
// into markers, and it is flattened next as it always was.

/** The tags each style is written with in the box. `strong`/`b` and `em`/`i`
 *  both occur: which one a browser produces for the Bold button depends on the
 *  browser, and a message opened from a draft carries whichever was stored. */
const TAGS: Record<keyof ConversationTextStyles, string[]> = {
  bold: ['strong', 'b'],
  italic: ['em', 'i'],
  strikethrough: ['s', 'strike', 'del'],
  monospace: ['code', 'tt'],
}

/** A ceiling on the unwrapping loop. Deeply nested emphasis is a paragraph of
 *  markup somebody pasted, not a reply somebody typed, and a message is worth
 *  more than perfect nesting inside it. */
const MAX_PASSES = 50

/**
 * One tag turned into its marker, innermost first.
 *
 * The pattern deliberately refuses to match across a tag of the same name, so
 * what it finds is always an innermost pair and `<b>a <b>c</b> d</b>` is not
 * mangled into a wrapper that ends halfway through itself. The loop then works
 * outwards.
 */
function markTag(html: string, tag: string, marker: string): string {
  const pattern = new RegExp(
    `<${tag}\\b[^>]*>((?:(?!</?${tag}\\b)[\\s\\S])*)</${tag}\\s*>`,
    'gi',
  )
  let out = html
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = out.replace(pattern, (_whole, inner: string) => wrap(inner, marker))
    if (next === out) return out
    out = next
  }
  return out
}

/**
 * The words inside a marker, with the spaces left outside it.
 *
 * `<b> hello </b>` has to become ` *hello* ` and not `* hello *`: a marker with
 * a space against the inside of it is not emphasis to WhatsApp, it is an
 * asterisk. Whitespace-only gets no markers at all, since there is nothing to
 * emphasise, and text already wrapped in the same marker is left alone rather
 * than wrapped twice.
 */
function wrap(inner: string, marker: string): string {
  const leading = inner.match(/^\s*/)?.[0] ?? ''
  const trailing = inner.match(/\s*$/)?.[0] ?? ''
  const core = inner.slice(leading.length, inner.length - trailing.length)
  if (!core) return inner
  if (core.startsWith(marker) && core.endsWith(marker) && core.length > marker.length * 2) {
    return inner
  }
  return `${leading}${marker}${core}${marker}${trailing}`
}

/**
 * A reply's markup, with the styles this channel carries written the way it
 * writes them.
 *
 * Handed the whole of `capabilities.textStyles`, so a channel that carries two
 * of the four gets two of the four and the rest are left as tags for the
 * flattener to take away - exactly as they were before any of this existed.
 * Null or empty means a channel that takes plain words, and the markup comes
 * back untouched.
 */
export function applyTextStyles(
  html: string,
  styles: ConversationTextStyles | null | undefined,
): string {
  if (!styles) return html
  let out = html
  for (const [style, tags] of Object.entries(TAGS) as Array<[keyof ConversationTextStyles, string[]]>) {
    const marker = styles[style]
    if (!marker) continue
    for (const tag of tags) out = markTag(out, tag, marker)
  }
  return out
}

/** Which styles a channel actually offers, for the buttons above the writing
 *  box. Names rather than markers: what a button says is "Bold", and what the
 *  message is wrapped in is this module's business at the moment it leaves. */
export function offeredStyles(
  styles: ConversationTextStyles | null | undefined,
): Array<keyof ConversationTextStyles> {
  if (!styles) return []
  return (Object.keys(TAGS) as Array<keyof ConversationTextStyles>).filter((name) => !!styles[name])
}
