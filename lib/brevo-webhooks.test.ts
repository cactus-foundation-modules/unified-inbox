import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// Brevo answers "this account has no webhooks" with a 400 and a body saying
// document_not_found, rather than with an empty list. Reading that as a failure
// deadlocked the whole feature: the account that has never had a webhook is
// precisely the account that needs its first one, and it never got past the
// listing call. Live sites sat with delivery updates switched on, collecting
// nothing, for as long as that lasted.

vi.mock('@/lib/db/prisma', () => ({ prisma: {} }))
vi.mock('@/lib/config/env', () => ({ getSiteUrlOrNull: () => 'https://example.test' }))
vi.mock('./db', () => ({
  brevoSendingKeys: async () => [{ label: 'This site', apiKey: 'key-1' }],
  ensureBrevoWebhookSecret: async () => 'sekret',
}))

const { reconcileBrevoWebhooks } = await import('./brevo-webhooks')

type Call = { url: string; method: string }

function mockBrevo(listing: { status: number; body: unknown }) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET'
    calls.push({ url: String(url), method })
    if (method === 'GET') {
      return new Response(JSON.stringify(listing.body), { status: listing.status })
    }
    return new Response(JSON.stringify({ id: 99 }), { status: 200 })
  }))
  return calls
}

describe('reconcileBrevoWebhooks', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('registers the first webhook on an account Brevo says has none', async () => {
    const calls = mockBrevo({
      status: 400,
      body: { code: 'document_not_found', message: 'Webhook record does not exist' },
    })

    const results = await reconcileBrevoWebhooks(true)

    expect(results).toEqual([{ label: 'This site', ok: true, message: 'Sending us delivery updates.' }])
    const posted = calls.find((c) => c.method === 'POST')
    expect(posted?.url).toContain('/webhooks')
  })

  it('still reports a listing that failed for a real reason', async () => {
    const calls = mockBrevo({ status: 401, body: { message: 'no' } })

    const results = await reconcileBrevoWebhooks(true)

    expect(results[0]?.ok).toBe(false)
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('is content when switching off an account that has none', async () => {
    mockBrevo({
      status: 400,
      body: { code: 'document_not_found', message: 'Webhook record does not exist' },
    })

    const results = await reconcileBrevoWebhooks(false)

    expect(results).toEqual([{ label: 'This site', ok: true, message: 'No longer sending us delivery updates.' }])
  })
})
