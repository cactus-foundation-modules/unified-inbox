import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth/session', () => ({ getSessionFromCookie: async () => ({ id: 'u1' }) }))
vi.mock('@/lib/permissions/check', () => ({ hasPermission: async () => true }))
vi.mock('@/modules/unified-inbox/lib/access', () => ({ canOpenThread: async () => true }))
vi.mock('@/modules/unified-inbox/lib/db', () => ({
  getMessageHtml: async () => ({ id: 'm1', threadId: 't1', html: '<p>hi</p>' }),
}))

const { GET } = await import('./route')

let saved: Array<[string, string | undefined]> = []
beforeEach(() => {
  saved = ['CACTUS_HOSTING_PROVIDER', 'SITE_URL', 'VERCEL'].map((k) => [k, process.env[k]])
  delete process.env.VERCEL
  process.env.CACTUS_HOSTING_PROVIDER = 'server'
  process.env.SITE_URL = 'https://shop.example'
})
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

it('writes the public address into the picture policy, never the bind address', async () => {
  const request = new NextRequest('https://localhost:3101/api/m/unified-inbox/messages/m1/body', {
    headers: { host: 'shop.example', 'x-forwarded-proto': 'https' },
  })
  const res = await GET(request, { params: Promise.resolve({ id: 'm1' }) })
  const csp = res.headers.get('content-security-policy') ?? ''
  expect(csp).toContain('https://shop.example')
  expect(csp).not.toContain('localhost')
})
