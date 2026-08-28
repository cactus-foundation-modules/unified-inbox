// Spotting a reference to one of the site's own records in something somebody
// wrote, so a conversation about PO-1234 can show PO-1234 beside it.
//
// The whole design rests on one division of labour, and it is what makes an
// automatic link safe:
//
//   A PATTERN ONLY PROPOSES. It says "that looked like an order number".
//   THE OWNING MODULE DISPOSES. Nothing is linked until a lookup finds a record
//   with exactly that number.
//
// So a pattern that matches too much costs a failed lookup, never a wrong link,
// and the patterns can stay generic enough to suit a site nobody here has seen.
// Every pattern is a setting with a default rather than a constant, because a
// pattern written into the code would be one site's pattern shipped to all of
// them.

export type LinkKind = 'order' | 'po' | 'quote'

export type ReferenceCandidate = {
  kind: LinkKind
  /** Exactly as written, because that is what the lookup compares against. */
  reference: string
}

/**
 * The defaults: a short run of letters, an optional hyphen, then a run of
 * digits. That is what a numbering scheme with a prefix and a counter looks
 * like almost everywhere, which is what both the shop and purchasing generate.
 *
 * Deliberately not tied to any one site's prefix. A site whose numbers look
 * different replaces the pattern in settings; a site that never opens the
 * screen still gets its orders linked.
 */
export const DEFAULT_PATTERNS: Record<LinkKind, string> = {
  order: '\\b([A-Z]{1,6}-?\\d{4,12})\\b',
  po: '\\b([A-Z]{1,6}-?\\d{4,12})\\b',
  quote: '\\b([A-Z]{1,6}-?\\d{4,12})\\b',
}

/** How much of a message is scanned. A pattern out of settings is somebody
 *  else's regular expression running over somebody else's email, and the two
 *  together are a fine way to spend a cron slice. The reference, when there is
 *  one, is in the subject or near the top of the message. */
const MAX_SCAN_CHARS = 20_000

/** Beyond this many hits the pattern is matching something structural rather
 *  than a reference, and running a lookup for each one helps nobody. */
const MAX_CANDIDATES_PER_KIND = 10

/**
 * Compile one pattern. A regular expression typed into a settings box is
 * user input, so a broken one must degrade to "this kind is not linked" rather
 * than throw somewhere in the middle of collecting the morning's mail.
 *
 * An empty string is a deliberate "do not link this kind" and returns null
 * without complaint; only something that will not compile is worth a line in
 * the log.
 */
export function compilePattern(source: string | null | undefined, kind: LinkKind): RegExp | null {
  const raw = source === null || source === undefined ? DEFAULT_PATTERNS[kind] : source
  if (!raw.trim()) return null
  try {
    return new RegExp(raw, 'gi')
  } catch {
    console.error(`[unified-inbox] the ${kind} reference pattern in settings will not compile; nothing of that kind will be linked automatically`)
    return null
  }
}

export type CompiledPatterns = Partial<Record<LinkKind, RegExp | null>>

export function compilePatterns(sources: Partial<Record<LinkKind, string | null>>): CompiledPatterns {
  return {
    order: compilePattern(sources.order, 'order'),
    po: compilePattern(sources.po, 'po'),
    quote: compilePattern(sources.quote, 'quote'),
  }
}

/**
 * Every reference the patterns can find in a message, deduplicated.
 *
 * The subject is scanned first and in full, because that is where a reference
 * is put deliberately; the body follows and is cut off, because that is where
 * one appears by accident inside a quoted footer.
 */
export function extractReferences(
  parts: { subject?: string | null; body?: string | null },
  patterns: CompiledPatterns,
): ReferenceCandidate[] {
  const haystack = [
    (parts.subject ?? '').slice(0, 500),
    (parts.body ?? '').slice(0, MAX_SCAN_CHARS),
  ].join('\n')
  if (!haystack.trim()) return []

  const out: ReferenceCandidate[] = []
  const seen = new Set<string>()

  for (const kind of ['order', 'po', 'quote'] as const) {
    const pattern = patterns[kind]
    if (!pattern) continue
    let found = 0
    // A fresh regex per pass: lastIndex is state, and sharing one across two
    // messages means the second starts reading halfway down the first.
    const scanner = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    let match: RegExpExecArray | null
    while ((match = scanner.exec(haystack)) !== null) {
      // A pattern that can match the empty string would loop here for ever.
      if (match[0] === '') { scanner.lastIndex += 1; continue }
      const reference = (match[1] ?? match[0]).trim()
      if (!reference) continue
      const key = `${kind}:${reference.toUpperCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ kind, reference })
      if (++found >= MAX_CANDIDATES_PER_KIND) break
    }
  }

  return out
}
