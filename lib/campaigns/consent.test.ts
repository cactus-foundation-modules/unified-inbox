import { describe, it, expect, vi } from 'vitest'

// The pure half only: nothing here reaches a database.
vi.mock('@/lib/db/prisma', () => ({ prisma: {} }))

const { effectiveConsent } = await import('./consent')

const at = (iso: string) => new Date(iso)

describe('effectiveConsent', () => {
  it('reads as never asked when nobody has said anything', () => {
    expect(effectiveConsent({ card: null, order: null, account: null })).toBeNull()
  })

  it('takes a no given at the checkout when the card never heard it', () => {
    // The Customers-list case: the order said no, the copying onto the card was
    // switched off, and the campaign must still leave them out.
    expect(effectiveConsent({
      card: null,
      order: { consent: false, at: at('2026-10-01T10:00:00Z') },
      account: null,
    })).toBe(false)
  })

  it('lets a later yes on the card overrule an earlier no at the checkout', () => {
    expect(effectiveConsent({
      card: { consent: true, at: at('2026-11-01T10:00:00Z') },
      order: { consent: false, at: at('2026-10-01T10:00:00Z') },
      account: false,
    })).toBe(true)
  })

  it('lets a later no at the checkout overrule an older yes on the card', () => {
    expect(effectiveConsent({
      card: { consent: true, at: at('2026-09-01T10:00:00Z') },
      order: { consent: false, at: at('2026-10-01T10:00:00Z') },
      account: null,
    })).toBe(false)
  })

  it('reads a tie that disagrees as a no', () => {
    expect(effectiveConsent({
      card: { consent: true, at: at('2026-10-01T10:00:00Z') },
      order: { consent: false, at: at('2026-10-01T10:00:00Z') },
      account: null,
    })).toBe(false)
  })

  it('only listens to the account when nothing dated has spoken', () => {
    expect(effectiveConsent({ card: null, order: null, account: false })).toBe(false)
    expect(effectiveConsent({
      card: { consent: true, at: at('2026-10-01T10:00:00Z') },
      order: null,
      account: false,
    })).toBe(true)
  })
})
