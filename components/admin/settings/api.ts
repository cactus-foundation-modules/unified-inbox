// Talking to the settings API, and the one sentence to say when the request
// never arrived at all.

export const API = '/api/m/unified-inbox/admin'

/** What to say when the request never landed. Every caller in the folder says
 *  the same thing, because from the screen's point of view it is the same
 *  thing. */
export const OFFLINE = 'Could not reach the site. Check your connection and try again.'

/** Ask a mail account what its folders are called. The answer is kept against
 *  the account server-side, so every caller finishes with a reload rather than
 *  holding a list of its own - the two folder pickers and the mail account list
 *  all draw the same one, and only one of them used to. */
export async function fetchFolders(connectionId: string): Promise<
  { ok: true; count: number } | { ok: false; error: string }
> {
  try {
    const res = await fetch(`${API}/connections/${connectionId}/test`, { method: 'POST' })
    const body = await res.json().catch(() => ({}))
    // Both: the request has to have been answered at all, and the answer has to
    // say the mailbox opened. Reading only the second one meant a refusal was
    // told apart from a bad password by luck rather than by asking.
    if (res.ok && body.ok) {
      return { ok: true, count: Array.isArray(body.folders) ? body.folders.length : 0 }
    }
    return { ok: false, error: (body as { error?: string }).error ?? 'That did not work.' }
  } catch {
    return { ok: false, error: OFFLINE }
  }
}

/** How many slices the walk may take before it gives up. A fortnight on a busy
 *  address is a handful; this many means something is going round in circles. */
const MAX_OFFER_SLICES = 50

/**
 * Offer an inbox's last fortnight to the modules listening for post, one slice
 * per request, until the site says it is done. See the offer-again route.
 */
export async function offerInboxAgain(inboxId: string): Promise<
  { ok: true; offered: number } | { ok: false; error: string }
> {
  let offered = 0
  let after: string | null = null
  try {
    for (let slice = 0; slice < MAX_OFFER_SLICES; slice++) {
      const res: Response = await fetch(`${API}/inboxes/${inboxId}/offer-again`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ after }),
      })
      const body = await res.json().catch(() => ({})) as {
        offered?: unknown; next?: unknown; done?: unknown; error?: unknown
      }
      if (!res.ok) return { ok: false, error: typeof body.error === 'string' ? body.error : 'That did not work.' }
      offered += typeof body.offered === 'number' ? body.offered : 0
      // Finished only when the site says so. A null cursor alone is "from the
      // beginning again": the first message was handed back to be retried.
      if (body.done !== false) return { ok: true, offered }
      after = typeof body.next === 'string' ? body.next : null
    }
    return { ok: false, error: `Offered ${offered} and then stopped: the walk was taking far longer than a fortnight of post should.` }
  } catch {
    return { ok: false, error: OFFLINE }
  }
}
