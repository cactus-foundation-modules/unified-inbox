import { z } from 'zod'
import { WEBHOOK_EVENTS } from './webhook-types'

// Shared between the create and the edit route, so a subscription cannot be
// saved through one of them carrying a field the other would have refused.

const HeaderName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'That header name is not allowed.')

export const WebhookBody = z.object({
  name: z.string().min(1).max(120),
  inboxId: z.string().min(1).nullable().optional(),
  url: z.string().min(8).max(2000),
  enabled: z.boolean().optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS as [string, ...string[]])).min(1).max(20),
  payloadStyle: z.enum(['event', 'literal']),
  literalBody: z.string().max(10_000).nullable().optional(),
  includeBody: z.boolean().optional(),
  /** Empty string clears it, absent leaves it alone. */
  secret: z.string().max(500).nullable().optional(),
  /** Extra request headers. Capped, and the names are constrained, so this
   *  cannot be used to set a Host or smuggle a second request. */
  headers: z.record(HeaderName, z.string().max(2000)).nullable().optional(),
})

export const WebhookPatchBody = WebhookBody.partial()

/** Header names the module sets itself, or that belong to the transport. A
 *  subscription overriding one of these would either break its own signature
 *  or send the request somewhere other than where it says. */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'x-cactus-timestamp',
  'x-cactus-nonce',
  'x-cactus-signature',
])

export function headerProblem(headers: Record<string, string> | null | undefined): string | null {
  if (!headers) return null
  const names = Object.keys(headers)
  if (names.length > 20) return 'That is more headers than a webhook needs - twenty is the limit.'
  for (const name of names) {
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      return `${name} is set for you and cannot be overridden here.`
    }
  }
  return null
}

/** A literal subscription with nothing to send is a subscription that fires an
 *  empty object at somebody, which is never what was meant. */
export function literalProblem(style: string, body: string | null | undefined): string | null {
  if (style !== 'literal') return null
  if (!body || !body.trim()) return 'Choose what to send, or switch back to the standard payload.'
  try {
    JSON.parse(body)
  } catch {
    return 'That is not valid JSON, so the far end would not be able to read it.'
  }
  return null
}
