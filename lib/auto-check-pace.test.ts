import { describe, expect, it } from 'vitest'
import { BACKGROUND_CHECK_SECONDS, autoCheckSeconds, checkDue } from './auto-check-pace'

describe('autoCheckSeconds', () => {
  it('keeps the Settings interval while somebody is reading mail', () => {
    expect(autoCheckSeconds(60, true)).toBe(60)
  })

  it('slows to the background pace anywhere else', () => {
    expect(autoCheckSeconds(60, false)).toBe(BACKGROUND_CHECK_SECONDS)
    expect(autoCheckSeconds(120, false)).toBe(BACKGROUND_CHECK_SECONDS)
  })

  it('never makes a background tab check more often than Settings asked for', () => {
    expect(autoCheckSeconds(1800, false)).toBe(1800)
  })
})

describe('checkDue', () => {
  const now = new Date('2026-09-21T12:00:00.000Z').getTime()

  it('is due once the interval has passed', () => {
    expect(checkDue(now - 60_000, 60, now)).toBe(true)
  })

  it('counts a timer tick that lands a hair early', () => {
    expect(checkDue(now - 59_996, 60, now)).toBe(true)
  })

  it('is not due inside the interval', () => {
    expect(checkDue(now - 50_000, 60, now)).toBe(false)
  })

  it('waits the background pace after another tab checked a minute ago', () => {
    expect(checkDue(now - 61_000, autoCheckSeconds(60, false), now)).toBe(false)
    expect(checkDue(now - 61_000, autoCheckSeconds(60, true), now)).toBe(true)
  })

  it('is due when nothing has ever checked', () => {
    expect(checkDue(0, BACKGROUND_CHECK_SECONDS, now)).toBe(true)
  })
})
