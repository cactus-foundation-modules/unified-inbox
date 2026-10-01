import { afterEach, describe, expect, it, vi } from 'vitest'
import { offerInboxAgain } from './api'

// The screen's half of "offer the last 14 days again": it keeps asking until
// the site says the walk is done, and a null cursor alone does not say that.

function answers(...bodies: Array<Record<string, unknown>>) {
  const fetchMock = vi.fn()
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => body })
  }
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => { vi.unstubAllGlobals() })

describe('offerInboxAgain', () => {
  it('carries on past a first request that handed its first message back', async () => {
    const fetchMock = answers(
      { ok: true, offered: 0, next: null, done: false },
      { ok: true, offered: 3, next: 'msg-3', done: false },
      { ok: true, offered: 2, next: null, done: true },
    )
    expect(await offerInboxAgain('inbox-1')).toEqual({ ok: true, offered: 5 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const sent = fetchMock.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body))
    // From the beginning twice - the retry - then from where it got to.
    expect(sent).toEqual([{ after: null }, { after: null }, { after: 'msg-3' }])
  })

  it('stops when the site says done, and treats an answer without the flag as done', async () => {
    answers({ ok: true, offered: 1, next: 'msg-1', done: true })
    expect(await offerInboxAgain('inbox-1')).toEqual({ ok: true, offered: 1 })
    const fetchMock = answers({ ok: true, offered: 1, next: 'msg-1' })
    expect(await offerInboxAgain('inbox-1')).toEqual({ ok: true, offered: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('says what went wrong when the site refuses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'Nobody is listening.' }) })
    vi.stubGlobal('fetch', fetchMock)
    expect(await offerInboxAgain('inbox-1')).toEqual({ ok: false, error: 'Nobody is listening.' })
  })
})
