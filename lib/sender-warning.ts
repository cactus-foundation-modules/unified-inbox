import { getInboxSecrets } from './db'
import { checkInboxSender } from './sender-check'
import { tryDecryptSecret } from '@/lib/crypto/secrets'
import type { Inbox } from './types'

/**
 * The one sentence an inbox screen shows after saving, when the email service
 * will not send from that address yet (E15).
 *
 * Null means there is nothing to say - either it will send, or we could not
 * find out, and a shrug is not worth a warning box. Anything that goes wrong in
 * here returns null too: failing to check is never a reason to fail a save.
 */
export async function senderWarningFor(inbox: Inbox): Promise<string | null> {
  try {
    const secrets = await getInboxSecrets(inbox.id)
    const apiKey = secrets.brevoApiKey
      ? tryDecryptSecret(secrets.brevoApiKey)
      : process.env.BREVO_API_KEY ?? null

    const result = await checkInboxSender(inbox, apiKey)
    return result.status === 'unverified' ? result.message : null
  } catch {
    return null
  }
}
