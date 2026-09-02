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
