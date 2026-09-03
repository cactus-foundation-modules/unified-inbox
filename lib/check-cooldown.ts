// ---------------------------------------------------------------------------
// How long a mail account rests between checks, and what to do about the ones
// still resting.
//
// It lives here rather than in the route because it is the part that can be
// wrong in a way nobody notices until it is annoying: the old rule refused the
// whole request when ANY account had been visited in the last minute, so a
// press seconds after the page checked on its own came back as an error and
// the list did not refresh at all. Which is not what a person pressing refresh
// asked for, and not something a type check has an opinion about.
// ---------------------------------------------------------------------------

/** How long an account rests between checks that nobody asked for. */
export const COOLDOWN_MS = 60_000

/** And between one somebody pressed a button for. Shorter on purpose: a press
 *  seconds after an automatic round is a person asking to be sure, and telling
 *  them to wait most of a minute for an answer they asked for reads as broken.
 *  Not zero - the connection cap is real, and opening a mailbox again on every
 *  press helps nobody. */
export const PRESSED_COOLDOWN_MS = 10_000

export type RestingAccount = { id: string; lastSyncAt: Date | null }

export function cooldownFor(automatic: boolean): number {
  return automatic ? COOLDOWN_MS : PRESSED_COOLDOWN_MS
}

/**
 * Splits the accounts into the ones worth opening and how recently the freshest
 * of the rest was seen.
 *
 * An account never checked at all is always due. `restedSeconds` is only there
 * to tell somebody how recently their mail was looked at, so it is null when
 * anything is due and there is nothing to explain.
 */
export function dueForCheck<T extends RestingAccount>(
  accounts: T[],
  cooldownMs: number,
  now: number = Date.now(),
): { due: T[]; restedSeconds: number | null } {
  const restedFor = (a: RestingAccount) =>
    a.lastSyncAt ? now - a.lastSyncAt.getTime() : Number.POSITIVE_INFINITY
  const due = accounts.filter((a) => restedFor(a) >= cooldownMs)
  if (due.length > 0 || accounts.length === 0) return { due, restedSeconds: null }
  return { due, restedSeconds: Math.max(1, Math.round(Math.min(...accounts.map(restedFor)) / 1000)) }
}
