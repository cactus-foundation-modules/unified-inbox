import { describe, expect, it } from 'vitest'
import {
  hasPersonalisation,
  personalise,
  previewFor,
  tagsIn,
  tagsWithoutFallback,
  unknownTags,
} from './personalise'
import type { RecipientNames } from './types'

// Merge tags. The whole feature is five tags and a fallback, and every test
// below is a way somebody's address book is actually shaped.

const jane: RecipientNames = {
  firstName: 'Jane',
  lastName: 'Smith',
  displayName: 'Jane Smith',
  organisationName: 'Acme Ltd',
  address: 'jane@acme.co.uk',
}

const nameless: RecipientNames = {
  firstName: null,
  lastName: null,
  displayName: null,
  organisationName: null,
  address: 'accounts@acme.co.uk',
}

describe('filling the tags in', () => {
  it('does the obvious thing for somebody with a full record', () => {
    expect(personalise('Hello {{first_name}},', jane)).toBe('Hello Jane,')
    expect(personalise('{{full_name}} at {{company}}', jane)).toBe('Jane Smith at Acme Ltd')
    expect(personalise('Sent to {{email}}', jane)).toBe('Sent to jane@acme.co.uk')
  })

  it('uses the fallback for somebody with nothing in that box', () => {
    expect(personalise('Hello {{first_name|there}},', nameless)).toBe('Hello there,')
  })

  it('leaves a gap rather than braces when there is no fallback', () => {
    // A hole is a smaller embarrassment than a pair of braces in a customer's
    // inbox. The editor refuses to start a campaign in this state anyway.
    expect(personalise('Hello {{first_name}},', nameless)).toBe('Hello ,')
  })

  it('treats a blank as missing, not as a value', () => {
    const blank: RecipientNames = { ...jane, firstName: '   ', displayName: null }
    expect(personalise('Hi {{first_name|there}}', blank)).toBe('Hi there')
  })

  it('falls back to the first word of a display name for a contact never split', () => {
    // Half of every address book is like this: a name read off a From line and
    // never separated into two boxes.
    const collected: RecipientNames = {
      firstName: null, lastName: null, displayName: 'Marcus Webb',
      organisationName: null, address: 'marcus@webb.co.uk',
    }
    expect(personalise('Hi {{first_name|there}}', collected)).toBe('Hi Marcus')
    expect(personalise('{{full_name}}', collected)).toBe('Marcus Webb')
  })

  it('tolerates spacing and capitals in the tag itself', () => {
    expect(personalise('Hi {{ First_Name | there }}', jane)).toBe('Hi Jane')
  })

  it('replaces every occurrence, not only the first', () => {
    expect(personalise('{{first_name}}, {{first_name}}', jane)).toBe('Jane, Jane')
  })

  it('gives an unknown tag its fallback rather than printing braces at a customer', () => {
    expect(personalise('Hi {{firstname|there}}', jane)).toBe('Hi there')
    expect(personalise('Hi {{firstname}}', jane)).toBe('Hi ')
  })

  it('leaves ordinary braces alone', () => {
    expect(personalise('Use {this} and {{ }} carefully', jane)).toBe('Use {this} and {{ }} carefully')
  })
})

describe('what the editor warns about', () => {
  it('finds the tags that are not tags', () => {
    expect(unknownTags('Hi {{firstname}}, from {{company}}')).toEqual(['firstname'])
    expect(unknownTags('Hi {{first_name}}')).toEqual([])
  })

  it('finds the tags with nothing to fall back on', () => {
    expect(tagsWithoutFallback('Hi {{first_name}} at {{company|your company}}')).toEqual(['first_name'])
  })

  it('does not nag about the email tag, which is never empty', () => {
    expect(tagsWithoutFallback('Sent to {{email}}')).toEqual([])
  })

  it('lists what is in a piece of text, fallbacks and all', () => {
    expect(tagsIn('Hi {{first_name|there}} and {{last_name}}')).toEqual([
      { name: 'first_name', fallback: 'there' },
      { name: 'last_name', fallback: null },
    ])
  })

  it('knows whether anything is personalised at all', () => {
    expect(hasPersonalisation('Dear customer')).toBe(false)
    expect(hasPersonalisation('Dear {{first_name|customer}}')).toBe(true)
    // An unknown tag is not personalisation - it is a typo.
    expect(hasPersonalisation('Dear {{firstname}}')).toBe(false)
  })
})

describe('the preview', () => {
  it('fills in the subject as well as the body', () => {
    expect(previewFor({ subject: 'A question, {{first_name|there}}', body: 'Hello {{first_name|there}}' }, nameless))
      .toEqual({ subject: 'A question, there', body: 'Hello there' })
  })
})
