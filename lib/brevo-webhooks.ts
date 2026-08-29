import { getSiteUrlOrNull } from '@/lib/config/env'
import { brevoSendingKeys, ensureBrevoWebhookSecret } from './db'
import { BREVO_SUBSCRIBED_EVENTS } from './receipts'

// ---------------------------------------------------------------------------
// Telling Brevo where to send its events, and telling it to stop.
//
// A webhook belongs to a Brevo ACCOUNT, not to an address, so a site whose
// inboxes each carry their own key needs one registration per key. They are
// reconciled rather than remembered: we ask Brevo what it already has, and put
// it right. No stored ids to go stale, no orphan left pointing at a site that
// has since been rebuilt, and a site restored from a backup sorts itself out
// the first time somebody saves the settings.
//
// Nothing in here is allowed to take a settings save down with it. An expired
// key means events do not arrive, which is a disappointment; a settings screen
// that will not save because of it is a fault.
// ---------------------------------------------------------------------------

const BREVO_API = 'https://api.brevo.com/v3'
const TIMEOUT_MS = 10_000

/** Where Brevo pushes its events. The token is the only thing standing between
 *  this address and anybody who guesses it, which is why it is long. */
export function brevoWebhookUrl(siteUrl: string, secret: string): string {
  return `${siteUrl.replace(/\/$/, '')}/api/m/unified-inbox/webhooks/brevo?token=${secret}`
}

/** How one account got on. Shown on the settings screen, because a site owner
 *  who has switched this on deserves to know it did not take. */
export type AccountRegistration = {
  label: string
  ok: boolean
  message: string
}

type BrevoWebhook = { id?: unknown; url?: unknown; type?: unknown }

type BrevoOutcome = { ok: true; body: unknown } | { ok: false; status: number | null; error: string }

async function brevoRequest(
  path: string,
  apiKey: string,
  init?: { method?: string; body?: unknown },
): Promise<BrevoOutcome> {
  try {
    const res = await fetch(`${BREVO_API}/${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      if (res.status === 401) return { ok: false, status: res.status, error: 'That email account key was not accepted.' }
      return { ok: false, status: res.status, error: `The email service refused (${res.status}). ${text.slice(0, 200)}` }
    }
    const body = await res.json().catch(() => ({}))
    return { ok: true, body }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false, status: null, error: `The email service could not be reached. ${reason.slice(0, 160)}` }
  }
}

/**
 * Whether a failed request means the webhook we were pointing at is simply not
 * there any more.
 *
 * Brevo answers a delete or an update against an id it no longer holds with a
 * 400 carrying `document_not_found` rather than a 404, so status alone will
 * not catch it. Worth telling apart from a real failure: for a DELETE it means
 * we already have what we wanted, and for a PUT it means the row to update is
 * gone and a fresh one is needed instead - either way it is not something to
 * show a site owner as a fault.
 */
function isGone(outcome: { ok: true; body: unknown } | { ok: false; status: number | null; error: string }): boolean {
  return !outcome.ok && (outcome.status === 404 || outcome.error.includes('document_not_found'))
}

/** The webhooks on this account that belong to this site, whatever token they
 *  were registered with - a token that has since been replaced still leaves one
 *  behind, and leaving it there means every event arrives twice. */
function oursAmong(body: unknown, siteUrl: string): string[] {
  const list = (body as { webhooks?: BrevoWebhook[] })?.webhooks
  if (!Array.isArray(list)) return []
  const prefix = `${siteUrl.replace(/\/$/, '')}/api/m/unified-inbox/webhooks/brevo`
  return list
    .filter((hook) => typeof hook.url === 'string' && hook.url.startsWith(prefix))
    .map((hook) => String(hook.id))
    .filter((id) => id && id !== 'undefined')
}

/**
 * Puts every Brevo account this site sends through into the state the settings
 * ask for: watching, or not.
 *
 * Returns one line per account rather than throwing, so the screen can show
 * which key worked and which did not instead of a single unhelpful failure.
 */
export async function reconcileBrevoWebhooks(enabled: boolean): Promise<AccountRegistration[]> {
  const siteUrl = getSiteUrlOrNull()
  if (!siteUrl) {
    return [{
      label: 'This site',
      ok: false,
      message: 'This site does not know its own web address yet, so the email service has nowhere to send its updates.',
    }]
  }

  const keys = await brevoSendingKeys()
  if (keys.length === 0) {
    return enabled
      ? [{
          label: 'This site',
          ok: false,
          message: 'Nothing here sends through Brevo, so there are no delivery updates to collect. Replies sent through your own mail server cannot be tracked this way.',
        }]
      : []
  }

  // Minted whether we are switching on or off: the address has to be the same
  // one next time, or turning it back on registers a second webhook and leaves
  // the first pointing at a token nothing accepts.
  const secret = await ensureBrevoWebhookSecret()
  const wanted = brevoWebhookUrl(siteUrl, secret)

  const results: AccountRegistration[] = []
  for (const key of keys) {
    const listed = await brevoRequest('webhooks?type=transactional', key.apiKey)
    // An account with no webhooks on it is answered with a 400 and
    // document_not_found rather than an empty list. Treating that as a failure
    // is a deadlock: the account that has never had a webhook is exactly the
    // account that needs its first one, and it would never get past this line.
    if (!listed.ok && !isGone(listed)) {
      results.push({ label: key.label, ok: false, message: listed.error })
      continue
    }
    const existing = listed.ok ? oursAmong(listed.body, siteUrl) : []

    if (!enabled) {
      let failure: string | null = null
      for (const id of existing) {
        const removed = await brevoRequest(`webhooks/${id}`, key.apiKey, { method: 'DELETE' })
        // Already gone is the goal state, not a failure - Brevo answers a
        // second delete of the same id (two settings saves close together,
        // say) with document_not_found rather than treating it as a no-op.
        if (!removed.ok && !isGone(removed)) failure = removed.error
      }
      results.push(failure
        ? { label: key.label, ok: false, message: failure }
        : { label: key.label, ok: true, message: 'No longer sending us delivery updates.' })
      continue
    }

    const payload = {
      url: wanted,
      description: 'Unified Inbox delivery receipts',
      events: [...BREVO_SUBSCRIBED_EVENTS],
      type: 'transactional',
    }

    // One is updated in place; any others are duplicates from an earlier
    // address and are removed, because two webhooks means two of every event.
    let outcome = existing.length
      ? await brevoRequest(`webhooks/${existing[0]}`, key.apiKey, { method: 'PUT', body: payload })
      : await brevoRequest('webhooks', key.apiKey, { method: 'POST', body: payload })

    if (!outcome.ok && existing.length) {
      // The webhook we thought we were updating has been deleted at their end.
      // Make a new one rather than reporting a failure nobody can act on.
      outcome = await brevoRequest('webhooks', key.apiKey, { method: 'POST', body: payload })
    }

    for (const id of existing.slice(1)) {
      await brevoRequest(`webhooks/${id}`, key.apiKey, { method: 'DELETE' })
    }

    results.push(outcome.ok
      ? { label: key.label, ok: true, message: 'Sending us delivery updates.' }
      : { label: key.label, ok: false, message: outcome.error })
  }

  return results
}
