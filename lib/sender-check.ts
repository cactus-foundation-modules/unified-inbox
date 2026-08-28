import { addressDomain, normaliseAddress } from './addresses'

// ---------------------------------------------------------------------------
// Will the email service actually send as this address? (E15)
//
// Brevo refuses to send from an address until either that address or its whole
// domain has been verified in Brevo. That is a setup step somebody has to do
// once, in a different company's admin screen, and nothing about it is obvious.
//
// Checked when an inbox is SAVED rather than when the first reply fails,
// because of who is standing there at each moment. When it is saved, the person
// present is the owner setting the thing up, they have Brevo open in another
// tab, and the fix takes them five minutes. When the first reply fails, the
// person present is a colleague trying to answer a customer, and there is
// nothing whatever they can do about it.
//
// It never blocks saving. The address may be verified an hour later, the check
// may be unreachable, and an inbox that cannot send yet is still worth having -
// it can collect mail perfectly well. This answers a question; it does not hold
// a door shut.
// ---------------------------------------------------------------------------

export type SenderCheck =
  /** Brevo will send as this address. */
  | { status: 'ok' }
  /** Brevo will refuse, and here is what to do about it. */
  | { status: 'unverified'; message: string }
  /** We could not find out. Not the same as a failure, and never presented as one. */
  | { status: 'unknown'; message: string }

type BrevoSender = { email?: unknown; active?: unknown }
type BrevoDomain = { domain?: unknown; authenticated?: unknown; verified?: unknown }

/**
 * Asks Brevo whether it will send as this address.
 *
 * An exact sender match is enough. Otherwise an authenticated domain covers
 * every address on it, which is how most sites end up set up and why checking
 * only the sender list would tell people to fix something already working.
 */
export async function checkBrevoSender(address: string, apiKey: string): Promise<SenderCheck> {
  const wanted = normaliseAddress(address)
  const domain = addressDomain(wanted)

  try {
    const senders = await brevoGet<{ senders?: BrevoSender[] }>('senders', apiKey)
    if (senders === null) {
      return {
        status: 'unknown',
        message: 'The email service did not answer when we asked whether it will send from this address. It is worth checking before you rely on it.',
      }
    }
    const match = (senders.senders ?? []).some(
      (s) => typeof s.email === 'string' && normaliseAddress(s.email) === wanted,
    )
    if (match) return { status: 'ok' }

    if (domain) {
      const domains = await brevoGet<{ domains?: BrevoDomain[] }>('senders/domains', apiKey)
      const authenticated = (domains?.domains ?? []).some(
        (d) =>
          typeof d.domain === 'string' &&
          d.domain.toLowerCase() === domain &&
          (d.authenticated === true || d.verified === true),
      )
      if (authenticated) return { status: 'ok' }
    }

    return {
      status: 'unverified',
      message: `Your email service will not send from ${wanted} yet. Add it as a sender in Brevo, or verify the whole ${domain ?? 'domain'} domain there, and replies from this inbox will go out. Collecting mail works either way.`,
    }
  } catch {
    return {
      status: 'unknown',
      message: 'We could not reach the email service to check whether it will send from this address.',
    }
  }
}

async function brevoGet<T>(path: string, apiKey: string): Promise<T | null> {
  const res = await fetch(`https://api.brevo.com/v3/${path}?limit=100`, {
    headers: { 'api-key': apiKey, accept: 'application/json' },
  })
  if (!res.ok) return null
  return (await res.json()) as T
}

/**
 * The check for a saved inbox, with everything that makes it not worth doing
 * decided first.
 *
 * There is nothing to check on an inbox sending over its own SMTP server - that
 * server's willingness to relay is between it and whoever runs it, and there is
 * no API to ask.
 */
export async function checkInboxSender(inbox: {
  address: string
  sendTransport: 'brevo' | 'smtp'
}, apiKey: string | null): Promise<SenderCheck> {
  if (inbox.sendTransport === 'smtp') return { status: 'ok' }
  if (!apiKey) {
    return {
      status: 'unknown',
      message: 'This site has no Brevo key set up, so we cannot check whether it will send from this address.',
    }
  }
  return await checkBrevoSender(inbox.address, apiKey)
}
