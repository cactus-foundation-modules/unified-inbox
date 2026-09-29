import { describe, it, expect } from 'vitest'
import { threadContacts } from './thread-contact'

const msg = (over: Partial<Parameters<typeof threadContacts>[0][number]>) => ({
  direction: 'in', fromName: null, fromAddress: null, fromPhone: null, toAddresses: [], ...over,
})

describe('threadContacts', () => {
  it('lists senders and recipients newest first, once each', () => {
    expect(threadContacts([
      msg({ fromName: 'Sam Jones', fromAddress: 'sam@x.com' }),
      msg({ direction: 'out', toAddresses: ['SAM@x.com', 'accounts@y.com'] }),
      msg({ fromPhone: '+447700900123' }),
    ])).toEqual([
      { name: null, address: '+447700900123' },
      { name: 'Sam Jones', address: 'SAM@x.com' },
      { name: null, address: 'accounts@y.com' },
    ])
  })

  it('leaves notes out', () => {
    expect(threadContacts([msg({ direction: 'note', fromAddress: 'me@here.com', toAddresses: ['x@y.com'] })])).toEqual([])
  })
})
