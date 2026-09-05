import type { RecipientNames } from './types'

// ---------------------------------------------------------------------------
// Putting somebody's name in the message.
//
// The whole of the personalisation story, and it is deliberately small: five
// merge tags, each with a fallback typed beside it, and no expressions, no
// conditionals and no loops. A mailshot language is a language somebody has to
// learn and a language this module would then have to keep working for ever.
//
// THE FALLBACK IS THE POINT. Half an address book has no first name on it -
// contacts the mail pass invented from a From line, imports where the column
// was called "Contact", the ones that are a company rather than a person. A
// tag with nothing behind it and no fallback produces "Hi ," which is worse
// than not personalising at all, so the fallback is written into the tag
// itself: `{{first_name|there}}`. Typed once, in the body, where whoever is
// writing can see it.
//
// SUBSTITUTION HAPPENS ON THE TYPED TEXT, before it is turned into markup. A
// name with an ampersand or an angle bracket in it is therefore escaped by the
// same pass that escapes everything else somebody typed, rather than needing to
// be remembered about separately here.
// ---------------------------------------------------------------------------

/** The tags this understands. Nothing else is a tag, and the editor says so
 *  before a campaign can start rather than after it has sent four hundred
 *  emails saying "Dear {{firstname}}". */
export const MERGE_TAGS = ['first_name', 'last_name', 'full_name', 'company', 'email'] as const

export type MergeTag = (typeof MERGE_TAGS)[number]

/** What each one is for, on the little reference beside the editor. */
export const MERGE_TAG_HELP: Record<MergeTag, string> = {
  first_name: 'Their first name',
  last_name: 'Their surname',
  full_name: 'Their whole name, as the address book holds it',
  company: 'The company they are at',
  email: 'The address this is going to',
}

// A tag, and the fallback after the bar. The fallback deliberately cannot
// contain a brace: an unclosed tag inside a fallback is a puzzle nobody should
// have to solve, and refusing it here means the text on screen and the text
// that goes out cannot disagree.
const TAG_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|([^{}]*))?\}\}/g

function isMergeTag(name: string): name is MergeTag {
  return (MERGE_TAGS as readonly string[]).includes(name)
}

/** What one tag resolves to for one person, before the fallback is considered.
 *  Blank and null are the same answer: there is nothing to put here. */
function valueFor(tag: MergeTag, person: RecipientNames): string {
  const first = person.firstName?.trim() ?? ''
  const last = person.lastName?.trim() ?? ''
  switch (tag) {
    case 'first_name':
      // The display name's first word is a reasonable answer for somebody whose
      // name has never been split - "Jane Smith" collected off a From line -
      // and is the difference between personalising most of a list and
      // personalising the half of it that came from a spreadsheet.
      return first || (person.displayName?.trim().split(/\s+/)[0] ?? '')
    case 'last_name':
      return last
    case 'full_name':
      return [first, last].filter(Boolean).join(' ') || (person.displayName?.trim() ?? '')
    case 'company':
      return person.organisationName?.trim() ?? ''
    case 'email':
      return person.address
  }
}

/**
 * One piece of typed text with the tags filled in.
 *
 * An unknown tag becomes its fallback, or nothing at all. It is NOT left on the
 * page as `{{firstname}}`: the campaign screen refuses to start a campaign
 * whose text has one in it, so by the time anything is sent there are none -
 * and if one ever did get this far, a gap is a smaller embarrassment than a
 * pair of braces in a customer's inbox.
 */
export function personalise(text: string, person: RecipientNames): string {
  return text.replace(TAG_RE, (_match, rawName: string, rawFallback?: string) => {
    const fallback = (rawFallback ?? '').trim()
    const name = rawName.toLowerCase()
    if (!isMergeTag(name)) return fallback
    const value = valueFor(name, person).trim()
    return value || fallback
  })
}

/** Every tag written in a piece of text, in the order they appear. */
export function tagsIn(text: string): Array<{ name: string; fallback: string | null }> {
  const found: Array<{ name: string; fallback: string | null }> = []
  for (const match of text.matchAll(TAG_RE)) {
    found.push({
      name: (match[1] ?? '').toLowerCase(),
      fallback: match[2] === undefined ? null : match[2].trim(),
    })
  }
  return found
}

/** The tags that are not tags: `{{firstname}}`, `{{ First Name }}`, whatever
 *  somebody has typed from memory. Shown in the editor as a warning and
 *  refused at the point of starting. */
export function unknownTags(text: string): string[] {
  const bad = tagsIn(text).filter((t) => !isMergeTag(t.name)).map((t) => t.name)
  return [...new Set(bad)]
}

/** Tags that will leave a hole for somebody with nothing in that field, because
 *  no fallback was typed beside them. A warning rather than a refusal: a
 *  campaign to a list where every row genuinely has a first name is entitled to
 *  say so. */
export function tagsWithoutFallback(text: string): string[] {
  const bare = tagsIn(text)
    .filter((t) => isMergeTag(t.name) && !t.fallback && t.name !== 'email')
    .map((t) => t.name)
  return [...new Set(bare)]
}

/** Whether anything in this text is personalised at all, for the line on the
 *  review step that says whether every recipient is getting the same words. */
export function hasPersonalisation(text: string): boolean {
  return tagsIn(text).some((t) => isMergeTag(t.name))
}

/**
 * How the message reads for a handful of real people.
 *
 * Real ones, off the actual list, rather than a made-up Jane Smith: the entire
 * value of a preview here is spotting the contact whose first name is "Accounts
 * Dept" or is missing altogether, and a fictional example never has that
 * problem.
 */
export function previewFor(
  parts: { subject: string; body: string },
  person: RecipientNames,
): { subject: string; body: string } {
  return {
    subject: personalise(parts.subject, person),
    body: personalise(parts.body, person),
  }
}
