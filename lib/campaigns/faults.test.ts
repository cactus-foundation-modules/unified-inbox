import { describe, expect, it } from 'vitest'
import { CampaignPatchBody } from '../validation'
import { describeCampaignFault } from './faults'

// Every one of these is a box somebody can type the wrong thing into. The test
// is not really "does it return a string" - it is that the string names the box
// and says the limit, because the one that did not ("That change could not be
// saved") sent somebody round the loop of typing the same wrong number again.

function faultFor(body: unknown): string {
  const parsed = CampaignPatchBody.safeParse(body)
  if (parsed.success) throw new Error('that body was accepted, so there is no fault to describe')
  return describeCampaignFault(parsed.error)
}

describe('why a campaign would not save', () => {
  it('names the floor when the gap between messages is too short', () => {
    const said = faultFor({ window: { intervalSeconds: 10 } })
    expect(said).toContain('20 seconds')
    expect(said).not.toBe('That change could not be saved.')
  })

  it('names the ceiling when the gap is longer than an hour', () => {
    expect(faultFor({ window: { intervalSeconds: 7200 } })).toContain('20 seconds and an hour')
  })

  it('says what a day to sit out looks like', () => {
    expect(faultFor({ window: { skipDates: ['christmas'] } })).toContain('2026-12-25')
  })

  it('says how a time is written', () => {
    expect(faultFor({ window: { startTime: 'nine' } })).toContain('09:00')
  })

  it('tells somebody the daily cap can be left empty rather than set to nought', () => {
    expect(faultFor({ window: { dailyCap: 0 } })).toContain('empty')
  })

  it('does not let the array index into the sentence', () => {
    const said = faultFor({ steps: [{ stepIndex: 0, body: '', waitDays: 900 }] })
    expect(said).toContain('1 and 90')
    expect(said).not.toMatch(/\d+\.waitDays/)
  })

  it('falls back to the old sentence rather than to Zod\'s own wording', () => {
    expect(faultFor({ includeSignature: 'yes please' })).toBe('That change could not be saved.')
  })
})
