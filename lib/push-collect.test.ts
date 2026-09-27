import { beforeEach, describe, expect, it, vi } from 'vitest'

// The ring's own loop, with the mailbox and the database stood in for: what it
// does when another check already covered it, when the account is busy, and
// when the account is free.

const state = { answeredAt: null as Date | null }
const syncs: Array<'locked' | 'ok' | 'error'> = []
const syncConnection = vi.fn()
const runPeoplePass = vi.fn(async () => ({ people: 0, links: 0 }))
const deliverPending = vi.fn(async () => ({}))

vi.mock('./db', () => ({ pushRingState: async () => ({ requestedAt: null, answeredAt: state.answeredAt }) }))
vi.mock('./sync', () => ({ syncConnection: (...args: unknown[]) => syncConnection(...args) }))
vi.mock('./identity', () => ({ runPeoplePass: (...args: unknown[]) => runPeoplePass(...(args as [])) }))
vi.mock('./webhooks', () => ({ WEBHOOK_BUDGET_MS: 8_000, deliverPending: (...args: unknown[]) => deliverPending(...(args as [])) }))
vi.mock('./push-checks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./push-checks')>()),
  PUSH_WAIT_POLL_MS: 1,
}))

const { collectOnPush } = await import('./push-collect')

const rang = new Date('2026-09-27T12:00:05Z')

beforeEach(() => {
  state.answeredAt = null
  syncs.length = 0
  syncConnection.mockReset()
  runPeoplePass.mockClear()
  deliverPending.mockClear()
})

describe('collectOnPush', () => {
  it('opens nothing when a check has already covered the ring', async () => {
    state.answeredAt = new Date(rang.getTime() + 1)
    const out = await collectOnPush('c1', rang, { budgetMs: 40_000 })
    expect(out.answered).toBe(true)
    expect(syncConnection).not.toHaveBeenCalled()
    expect(deliverPending).toHaveBeenCalledTimes(1)
  })

  it('waits on a busy account and stops once the holder says it covered the ring', async () => {
    let calls = 0
    syncConnection.mockImplementation(async () => {
      calls += 1
      // The holder finishes during the second wait, having seen this ring.
      if (calls === 2) state.answeredAt = rang
      return { ok: true, skipped: 'locked', stored: 0, folders: [] }
    })
    const out = await collectOnPush('c1', rang, { budgetMs: 40_000 })
    expect(out.answered).toBe(true)
    expect(syncConnection).toHaveBeenCalledTimes(2)
    expect(runPeoplePass).not.toHaveBeenCalled()
  })

  it('checks the account itself when it is free, then runs the people pass for what it filed', async () => {
    syncConnection.mockImplementation(async () => {
      state.answeredAt = rang
      return { ok: true, stored: 2, folders: [] }
    })
    const out = await collectOnPush('c1', rang, { budgetMs: 40_000 })
    expect(out).toEqual({ stored: 2, answered: true })
    expect(syncConnection).toHaveBeenCalledTimes(1)
    expect(runPeoplePass).toHaveBeenCalledTimes(1)
    expect(deliverPending).toHaveBeenCalledTimes(1)
  })

  it('reports a failed check as unanswered rather than trying again in a loop', async () => {
    syncConnection.mockResolvedValue({ ok: false, stored: 0, folders: [], error: 'Login refused' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await collectOnPush('c1', rang, { budgetMs: 40_000 })
    expect(out).toEqual({ stored: 0, answered: false, error: 'Login refused' })
    expect(syncConnection).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
