import { describe, it, expect } from 'vitest'
import { detailLine, humanStatus, money, shortDate, toDate, toNumber } from './format'

describe('toNumber', () => {
  it('copes with what a NUMERIC column actually hands back', () => {
    // Prisma returns a Decimal, not a number. Going through the string is the
    // shape that keeps working whatever that library does next.
    expect(toNumber({ toString: () => '1240.50' })).toBe(1240.5)
    expect(toNumber(12n)).toBe(12)
    expect(toNumber(7)).toBe(7)
  })

  it('gives back null rather than NaN', () => {
    expect(toNumber(null)).toBeNull()
    expect(toNumber('nonsense')).toBeNull()
  })
})

describe('money', () => {
  it('writes it the way somebody in Britain would read it', () => {
    expect(money(1240.5, 'GBP')).toBe('£1,240.50')
  })

  it('formats an unheard-of but well-formed code without complaint', () => {
    // Intl takes any three letters, so this is not the case the fallback is for.
    expect(money(10, 'ZZZ')).toContain('10.00')
  })

  it('falls back rather than throwing on a code that is not a code at all', () => {
    expect(money(10, 'X')).toBe('10.00 X')
  })

  it('says nothing when there is no amount', () => {
    expect(money(null, 'GBP')).toBeNull()
  })
})

describe('humanStatus', () => {
  it('stops the enum shouting', () => {
    expect(humanStatus('PARTIALLY_REFUNDED')).toBe('Partially refunded')
    expect(humanStatus('SHIPPED')).toBe('Shipped')
  })

  it('says nothing about nothing', () => {
    expect(humanStatus(null)).toBeNull()
    expect(humanStatus('  ')).toBeNull()
  })
})

describe('detailLine and dates', () => {
  it('drops the empty pieces', () => {
    expect(detailLine('£10.00', null, 'due 1 Jan 2026')).toBe('£10.00 - due 1 Jan 2026')
    expect(detailLine(null, undefined, '')).toBeNull()
  })

  it('reads a date column back', () => {
    expect(shortDate('2026-03-12T00:00:00.000Z', 'Europe/London')).toBe('12 Mar 2026')
    expect(shortDate('nonsense', 'Europe/London')).toBeNull()
    // Midnight UTC on a summer date is already the next day in London, which is
    // the whole reason this takes a zone rather than guessing.
    expect(shortDate('2026-07-11T23:30:00.000Z', 'Europe/London')).toBe('12 Jul 2026')
    expect(shortDate('2026-07-11T23:30:00.000Z', 'UTC')).toBe('11 Jul 2026')
    expect(toDate(null)).toBeNull()
  })
})
