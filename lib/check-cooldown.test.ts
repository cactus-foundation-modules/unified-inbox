import { describe, expect, it } from 'vitest'
import { COOLDOWN_MS, PRESSED_COOLDOWN_MS, cooldownFor, dueForCheck } from './check-cooldown'

const now = new Date('2026-09-03T04:00:00.000Z').getTime()
const ago = (ms: number) => new Date(now - ms)

describe('dueForCheck', () => {
  it('checks an account that has never been checked', () => {
    const { due, restedSeconds } = dueForCheck([{ id: 'a', lastSyncAt: null }], COOLDOWN_MS, now)
    expect(due.map((a) => a.id)).toEqual(['a'])
    expect(restedSeconds).toBeNull()
  })

  it('steps over an account opened moments ago', () => {
    const { due, restedSeconds } = dueForCheck([{ id: 'a', lastSyncAt: ago(11_000) }], COOLDOWN_MS, now)
    expect(due).toEqual([])
    expect(restedSeconds).toBe(11)
  })

  it('checks it anyway when somebody pressed the button', () => {
    const accounts = [{ id: 'a', lastSyncAt: ago(11_000) }]
    expect(dueForCheck(accounts, PRESSED_COOLDOWN_MS, now).due.map((a) => a.id)).toEqual(['a'])
  })

  it('rests a pressed check too, just briefly', () => {
    const accounts = [{ id: 'a', lastSyncAt: ago(2_000) }]
    const { due, restedSeconds } = dueForCheck(accounts, PRESSED_COOLDOWN_MS, now)
    expect(due).toEqual([])
    expect(restedSeconds).toBe(2)
  })

  it('one resting account no longer holds up the others', () => {
    const { due } = dueForCheck(
      [
        { id: 'fresh', lastSyncAt: ago(3_000) },
        { id: 'stale', lastSyncAt: ago(10 * 60_000) },
        { id: 'never', lastSyncAt: null },
      ],
      COOLDOWN_MS,
      now,
    )
    expect(due.map((a) => a.id)).toEqual(['stale', 'never'])
  })

  it('reports the freshest of the resting accounts, not the oldest', () => {
    const { restedSeconds } = dueForCheck(
      [{ id: 'a', lastSyncAt: ago(50_000) }, { id: 'b', lastSyncAt: ago(4_000) }],
      COOLDOWN_MS,
      now,
    )
    expect(restedSeconds).toBe(4)
  })

  it('never says a check happened zero seconds ago', () => {
    expect(dueForCheck([{ id: 'a', lastSyncAt: ago(200) }], COOLDOWN_MS, now).restedSeconds).toBe(1)
  })

  it('has nothing to check and nothing to explain with no accounts', () => {
    expect(dueForCheck([], COOLDOWN_MS, now)).toEqual({ due: [], restedSeconds: null })
  })

  it('rests a pressed check for less than an automatic one', () => {
    expect(cooldownFor(false)).toBeLessThan(cooldownFor(true))
    expect(cooldownFor(true)).toBe(COOLDOWN_MS)
  })
})
