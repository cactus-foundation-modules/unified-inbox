import { describe, expect, it, vi } from 'vitest'

// E25. A contact form enquiry emails the owner, so the same enquiry arrives
// twice: once on the channel it came in on and once as an ordinary email. The
// same goes for every order confirmation and purchase order the site sends to
// an address it also collects from. Get this wrong and every enquiry a site
// receives is two unread enquiries, and somebody answers the wrong one.

vi.mock('imapflow', () => ({}))
vi.mock('mailparser', () => ({ simpleParser: vi.fn() }))
vi.mock('@/lib/db/prisma', () => ({ prisma: {} }))
vi.mock('@/lib/notifications/alerts', () => ({ upsertAlert: vi.fn(), clearAlert: vi.fn() }))

const { ownNotification } = await import('./sync')

describe('ownNotification', () => {
  it('recognises the site writing to its own owner', () => {
    expect(ownNotification('in', 'hi@deskwell.co.uk', 'hi@deskwell.co.uk')).toBe('own-notification')
  })

  it('leaves a real customer alone', () => {
    expect(ownNotification('in', 'ada@example.com', 'hi@deskwell.co.uk')).toBeNull()
  })

  it('says nothing about something the owner sent themselves', () => {
    // Outbound mail from that address is the owner writing to a customer, and
    // marking their own replies as machinery would be worse than the problem.
    expect(ownNotification('out', 'hi@deskwell.co.uk', 'hi@deskwell.co.uk')).toBeNull()
  })

  it('is inert on a site that has not set a sending address', () => {
    expect(ownNotification('in', 'hi@deskwell.co.uk', null)).toBeNull()
    expect(ownNotification('in', 'hi@deskwell.co.uk', '')).toBeNull()
  })

  it('is inert on mail with no sender at all', () => {
    expect(ownNotification('in', null, 'hi@deskwell.co.uk')).toBeNull()
  })
})
