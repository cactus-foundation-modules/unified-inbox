import type { ZodError } from 'zod'

// ---------------------------------------------------------------------------
// Why the campaign would not save, in a sentence somebody can act on.
//
// The schema knows perfectly well that interval_seconds has to be at least
// twenty. "That change could not be saved" throws that away and hands back a
// sentence whose only possible next move is to try the same thing again -
// which is what happened: a gap of ten seconds was refused with no hint that
// twenty was the floor, and nothing on the screen said so either.
//
// So every box the schema can refuse gets a line here, written the way the
// person typing would say it, with the actual limit in it. Anything unmapped
// falls back to the old sentence rather than to Zod's own wording, which talks
// about numbers being too small and paths being invalid.
// ---------------------------------------------------------------------------

const BY_PATH: Record<string, string> = {
  'name': 'Give the campaign a name - it can be anything, only you see it.',
  'window.startTime': 'The time it starts each day has to be written as 09:00.',
  'window.endTime': 'The time it stops each day has to be written as 17:00.',
  'window.intervalSeconds': 'The gap between messages has to be between 20 seconds and an hour. '
    + 'Twenty is the floor on purpose - faster than that is a burst with extra steps.',
  'window.jitterSeconds': 'The gap can be varied by up to ten minutes, no more.',
  'window.dailyCap': 'The most to send in a day has to be at least one. Leave it empty for no limit.',
  'window.rampStart': 'The first day of the warm-up has to be at least one.',
  'window.skipDates': 'Days to sit out have to be written as 2026-12-25, separated by commas - '
    + 'and there is a limit of sixty of them.',
  'steps.subject': 'That subject line is too long. Five hundred characters is the limit.',
  'steps.body': 'That message is too long to save.',
  'steps.waitDays': 'Days to wait before a follow-up has to be between 1 and 90.',
  'steps': 'A campaign has the message and up to three follow-ups, no more.',
  'categoryIds': 'That is more labels than a campaign can be built from.',
  'startAt': 'The date it may start was not one this understands.',
}

/**
 * The first thing wrong with a campaign body, said plainly.
 *
 * First rather than all of them: the boxes are on one screen and fixing the one
 * named almost always fixes the rest, whereas a paragraph of four complaints is
 * a paragraph nobody reads.
 */
export function describeCampaignFault(error: ZodError): string {
  for (const issue of error.issues) {
    // "steps.2.body" is the same complaint as "steps.0.body" - which one of the
    // follow-ups it was is obvious from the screen, and the number in the path
    // is an array index rather than anything a person would recognise.
    const path = issue.path.filter((part) => typeof part !== 'number').join('.')
    const said = BY_PATH[path]
    if (said) return said
  }
  return 'That change could not be saved.'
}
