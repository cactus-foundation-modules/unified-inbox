// ---------------------------------------------------------------------------
// How often an open admin tab checks the mail on its own.
//
// The interval in Settings is the pace for somebody actually reading mail: the
// Unified Inbox's mail view on screen, in the tab they are looking at. Anywhere
// else - Settings, an order, a tab left behind another window - nobody is
// watching the list fill up, so the tab only needs to keep collection ticking
// over. Every round is a function call that logs in to every mailbox, and on a
// live install (measured 2026-09-21) tabs left open overnight at a one-minute
// interval were the second largest use of server time on the whole site.
// ---------------------------------------------------------------------------

/** The longest a tab where nobody is reading mail waits between checks - or
 *  the Settings interval, when that asks for something slower still. */
export const BACKGROUND_CHECK_SECONDS = 300

/** Seconds between automatic checks, for a tab that is or is not showing the mail view. */
export function autoCheckSeconds(configured: number, watching: boolean): number {
  return watching ? configured : Math.max(configured, BACKGROUND_CHECK_SECONDS)
}

// A browser timer set for a minute can fire a few milliseconds short of one.
// Without this, that tick would be judged not yet due and the round would wait
// for the next one - a one-minute setting quietly checking every two.
const TIMER_SLACK_MS = 1_000

/** Whether a round is due, given when any tab in this browser last started one. */
export function checkDue(lastCheckAt: number, seconds: number, now: number): boolean {
  return now - lastCheckAt >= seconds * 1000 - TIMER_SLACK_MS
}
