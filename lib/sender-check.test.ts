import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { checkBrevoSender, checkInboxSender } from './sender-check'

function respond(body: unknown, ok = true) {
  return { ok, json: async () => body, text: async () => '' } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('checkBrevoSender (E15)', () => {
  it('is happy when the exact address is a verified sender', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond({ senders: [{ email: 'marcus@deskwell.co.uk', active: true }] }),
    )
    expect(await checkBrevoSender('marcus@deskwell.co.uk', 'key')).toEqual({ status: 'ok' })
  })

  it('matches the address however it was typed', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond({ senders: [{ email: 'Marcus@Deskwell.co.uk' }] }),
    )
    expect(await checkBrevoSender('Marcus Jones <marcus@deskwell.co.uk>', 'key')).toEqual({
      status: 'ok',
    })
  })

  it('is happy when the whole domain is authenticated, which is how most sites are set up', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond({ senders: [{ email: 'someone-else@deskwell.co.uk' }] }))
      .mockResolvedValueOnce(respond({ domains: [{ domain: 'deskwell.co.uk', authenticated: true }] }))

    expect(await checkBrevoSender('marcus@deskwell.co.uk', 'key')).toEqual({ status: 'ok' })
  })

  it('does not accept a domain that is listed but not authenticated', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond({ senders: [] }))
      .mockResolvedValueOnce(respond({ domains: [{ domain: 'deskwell.co.uk', authenticated: false }] }))

    const result = await checkBrevoSender('marcus@deskwell.co.uk', 'key')
    expect(result.status).toBe('unverified')
  })

  it('says what to do about it, in English, naming the address and the domain', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond({ senders: [] }))
      .mockResolvedValueOnce(respond({ domains: [] }))

    const result = await checkBrevoSender('marcus@deskwell.co.uk', 'key')
    if (result.status !== 'unverified') throw new Error('expected unverified')
    expect(result.message).toContain('marcus@deskwell.co.uk')
    expect(result.message).toContain('deskwell.co.uk')
    expect(result.message).toMatch(/collecting mail works either way/i)
    expect(result.message).not.toMatch(/API|401|payload|endpoint/i)
  })

  it('a service that will not answer is unknown, not a failure', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond({}, false))
    const result = await checkBrevoSender('marcus@deskwell.co.uk', 'key')
    expect(result.status).toBe('unknown')
  })

  it('a network wobble is unknown too, and never throws', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('fetch failed'))
    const result = await checkBrevoSender('marcus@deskwell.co.uk', 'key')
    expect(result.status).toBe('unknown')
  })
})

describe('checkInboxSender', () => {
  it('has nothing to say about an inbox on its own SMTP server', async () => {
    const result = await checkInboxSender(
      { address: 'marcus@deskwell.co.uk', sendTransport: 'smtp' },
      null,
    )
    expect(result).toEqual({ status: 'ok' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('cannot check without a key, and says so rather than guessing', async () => {
    const result = await checkInboxSender(
      { address: 'marcus@deskwell.co.uk', sendTransport: 'brevo' },
      null,
    )
    expect(result.status).toBe('unknown')
    expect(fetch).not.toHaveBeenCalled()
  })
})
