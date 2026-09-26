import { describe, it, expect } from 'vitest'
import { deliveryUpdateFor } from './own-tracking'
import type { EmailTrackingEvent } from '@/lib/email/tracking/listeners'

// Core's events, in the ledger's own words. The SQL behind the listener is run
// for real in own-tracking.live.test.ts.

const at = new Date('2026-09-20T09:00:00Z')
const base: EmailTrackingEvent = {
  emailLogId: 'log1', moduleName: 'unified-inbox', ref: 'm1', kind: 'opened', occurredAt: at,
  detail: null, bounceKind: null, ip: '81.2.69.160', userAgent: 'Outlook',
}

describe('an event from the site\'s own tracking', () => {
  it('is filed as the site\'s, with who fetched it', () => {
    expect(deliveryUpdateFor(base)).toEqual({
      kind: 'opened', occurredAt: at, detail: null, bounceKind: null, source: 'site', ip: '81.2.69.160', userAgent: 'Outlook',
    })
  })

  it('keeps the address on a click and nowhere else', () => {
    expect(deliveryUpdateFor({ ...base, kind: 'clicked', detail: 'https://deskwell.co.uk/q' }).detail).toBe('https://deskwell.co.uk/q')
    expect(deliveryUpdateFor({ ...base, kind: 'proxy_open', detail: 'stray' }).detail).toBeNull()
  })

  it('turns a soft bounce into a delay and a hard one into a failure', () => {
    expect(deliveryUpdateFor({ ...base, kind: 'bounced', bounceKind: 'soft', detail: 'later' })).toMatchObject({ kind: 'bounced', bounceKind: 'deferred', source: 'site' })
    expect(deliveryUpdateFor({ ...base, kind: 'bounced', bounceKind: 'hard', detail: 'gone' })).toMatchObject({ kind: 'bounced', bounceKind: 'hard', detail: 'gone' })
  })
})
