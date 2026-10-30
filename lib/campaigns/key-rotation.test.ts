import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetKeyringState, setKeyringState } from '@/lib/crypto/keyring'
import { tokenMatches, unsubscribeToken } from './unsubscribe'

// "Works for ever" includes after the site changes its encryption key (core's
// lib/crypto/keyring.ts): a link in last year's campaign still opts its address out.

const OLD = '1a'.repeat(32)
const NEW = '2b'.repeat(32)
const saved = process.env.ENCRYPTION_KEY

beforeEach(() => {
  resetKeyringState()
  process.env.ENCRYPTION_KEY = OLD
})
afterEach(() => {
  resetKeyringState()
  if (saved === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = saved
})

describe('campaign unsubscribe links after a key rotation', () => {
  it('accept one signed with the previous key, for that address only', () => {
    const before = unsubscribeToken('Someone@Example.com')
    process.env.ENCRYPTION_KEY = NEW
    setKeyringState({ previous: [OLD] })
    expect(tokenMatches('someone@example.com', before)).toBe(true)
    expect(tokenMatches('someone-else@example.com', before)).toBe(false)
  })

  it('are signed with the current key from then on', () => {
    process.env.ENCRYPTION_KEY = NEW
    setKeyringState({ previous: [OLD] })
    const after = unsubscribeToken('someone@example.com')
    expect(tokenMatches('someone@example.com', after)).toBe(true)
    process.env.ENCRYPTION_KEY = OLD
    resetKeyringState()
    expect(tokenMatches('someone@example.com', after)).toBe(false)
  })
})
