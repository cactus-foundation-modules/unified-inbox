import { describe, expect, it } from 'vitest'
import { describeEvents, visibleTo, weaveTimeline, type TimelineEvent, type TimelineLine } from './timeline'

const CHRIS = 'user-chris'
const SAM = 'user-sam'
const ctx = {
  staffById: { [CHRIS]: 'Chris', [SAM]: 'Sam' },
  timezone: 'Europe/London',
  viewerUserId: CHRIS,
}

let seq = 0
function event(kind: string, detail: Record<string, unknown> | null, opts: { userId?: string | null; at?: string } = {}): TimelineEvent {
  seq += 1
  return {
    id: `ev-${String(seq).padStart(3, '0')}`,
    userId: opts.userId === undefined ? null : opts.userId,
    kind,
    detail,
    createdAt: new Date(opts.at ?? '2026-09-01T10:00:00.000Z'),
  }
}

function say(e: TimelineEvent, viewer = CHRIS): string | undefined {
  return describeEvents([e], { ...ctx, viewerUserId: viewer })[0]?.text
}

describe('what a line says', () => {
  it('names who snoozed it and until when, in the site zone', () => {
    const text = say(event('snoozed', { status: 'snoozed', until: '2026-09-04T08:00:00.000Z', was: 'open' }, { userId: CHRIS }))
    expect(text).toMatch(/^Chris snoozed it until /)
    // 08:00 UTC in September is nine o'clock in London.
    expect(text).toContain('09:00')
  })

  it('says a snooze was moved rather than set, when it was already asleep', () => {
    expect(say(event('snoozed', { until: '2026-09-04T08:00:00.000Z', was: 'snoozed' }, { userId: SAM })))
      .toMatch(/^Sam moved its snooze to /)
  })

  it('tells a reply waking a snooze apart from one reopening something done', () => {
    expect(say(event('woken', { was: 'snoozed', direction: 'in' }))).toBe('A reply arrived, so it is no longer snoozed')
    expect(say(event('woken', { was: 'done', direction: 'in' }))).toBe('A reply arrived, so it was opened again')
  })

  it('says when the reply that woke it went out from somewhere other than this hub', () => {
    expect(say(event('woken', { was: 'snoozed', direction: 'out' })))
      .toBe('A reply was sent from outside the inbox, so it is no longer snoozed')
  })

  it('reads an old woken row, with no direction on it, as a reply arriving', () => {
    expect(say(event('woken', { was: 'snoozed' }))).toBe('A reply arrived, so it is no longer snoozed')
  })

  it('says a snooze ran out on its own', () => {
    expect(say(event('woken', { was: 'snoozed', cause: 'time' }))).toBe('Its snooze ran out, so it came back')
  })

  it('says nobody replied when the sleep that ran out was a follow-up', () => {
    const lines = describeEvents([
      event('awaiting', { userId: SAM, minutes: 1440 }, { at: '2026-09-01T09:00:00.000Z' }),
      event('woken', { was: 'snoozed', cause: 'time' }, { at: '2026-09-02T09:00:00.000Z' }),
    ], ctx)
    expect(lines.map((l) => l.text)).toEqual([
      'It went out, so it comes back to Sam if nobody replies',
      'Nobody replied, so it came back to Sam',
    ])
  })

  it('forgets the follow-up once somebody has snoozed it themselves', () => {
    const lines = describeEvents([
      event('awaiting', { userId: SAM }, { at: '2026-09-01T09:00:00.000Z' }),
      event('snoozed', { until: '2026-09-03T08:00:00.000Z', was: 'snoozed' }, { userId: CHRIS, at: '2026-09-01T10:00:00.000Z' }),
      event('woken', { was: 'snoozed', cause: 'time' }, { at: '2026-09-03T08:00:00.000Z' }),
    ], ctx)
    expect(lines[2]!.text).toBe('Its snooze ran out, so it came back')
  })

  it('says who took it out of snooze early, and who opened it again', () => {
    expect(say(event('status', { status: 'open', was: 'snoozed' }, { userId: CHRIS }))).toBe('Chris brought it back before its snooze ran out')
    expect(say(event('status', { status: 'open', was: 'done' }, { userId: CHRIS }))).toBe('Chris opened it again')
    expect(say(event('status', { status: 'done', was: 'open' }, { userId: SAM }))).toBe('Sam marked it done')
  })

  it('says whose bin, and never implies it went for everybody', () => {
    expect(say(event('binned', { ownerUserId: CHRIS }, { userId: CHRIS }))).toBe('Chris put it in their bin')
    // Covering Sam's own address fills Sam's bin.
    expect(say(event('binned', { ownerUserId: SAM }, { userId: CHRIS }))).toBe("Chris put it in Sam's bin")
    expect(say(event('unbinned', { ownerUserId: CHRIS }, { userId: CHRIS }))).toBe('Chris took it back out of their bin')
    expect(say(event('unbinned', { bins: 2 }))).toBe('A reply arrived, so it came back out of the bin')
  })

  it('says whose junk', () => {
    expect(say(event('junked', { ownerUserId: SAM }, { userId: SAM }))).toBe('Sam moved it to their junk')
    expect(say(event('unjunked', { ownerUserId: SAM }, { userId: CHRIS }))).toBe("Chris took it back out of Sam's junk")
    expect(say(event('blocked', {}))).toBe('It came from a sender the site has blocked, so it went straight to junk')
  })

  it('says a scheduled reply was cancelled and saved as a draft because they wrote first', () => {
    expect(say(event('held', { cause: 'they', count: 1, authorUserIds: [CHRIS], allReplies: true })))
      .toBe("They wrote before Chris's scheduled reply went out, so it was cancelled and saved as a draft")
  })

  it('counts several, from several people', () => {
    expect(say(event('held', { cause: 'they', count: 2, authorUserIds: [CHRIS, SAM], allReplies: false })))
      .toBe('They wrote before 2 scheduled messages from Chris and Sam went out, so they were cancelled and saved as drafts')
  })

  it('says when they wrote in another conversation', () => {
    expect(say(event('held', { cause: 'they', count: 1, authorUserIds: [SAM], allReplies: true, elsewhereThreadId: 't-2' })))
      .toBe("They wrote in another conversation before Sam's scheduled reply went out, so it was cancelled and saved as a draft")
  })

  it('names the colleague who answered first', () => {
    expect(say(event('held', { cause: 'colleague', count: 1, authorUserIds: [CHRIS], allReplies: true }, { userId: SAM })))
      .toBe("Sam replied first, so Chris's scheduled reply was cancelled and saved as a draft")
    expect(say(event('held', { cause: 'colleague', count: 1, authorUserIds: [CHRIS], allReplies: true })))
      .toBe("A reply was sent from outside the inbox first, so Chris's scheduled reply was cancelled and saved as a draft")
  })

  it('still reads the oldest held rows, which carry only a count', () => {
    expect(say(event('held', { count: 1, address: 'a@b.c' })))
      .toBe('They wrote first, so a message waiting to go out to them was cancelled and saved as a draft')
  })

  it('says a scheduled message failed, and why', () => {
    expect(say(event('scheduled_failed', { authorUserId: SAM, reply: true, reason: 'Whoever wrote it can no longer send from that address, so it stayed here.' })))
      .toBe("Sam's scheduled reply did not go out, so it stayed a draft. Whoever wrote it can no longer send from that address, so it stayed here.")
  })

  it('says a snooze asked for on a scheduled message was carried out', () => {
    expect(say(event('snoozed', { until: '2026-09-05T08:00:00.000Z', afterSend: true, userId: SAM })))
      .toMatch(/^It went out, so it is snoozed until .*, as Sam asked$/)
  })

  it('never invents a colleague for something nobody did', () => {
    expect(say(event('assigned', { to: SAM, automatic: true }))).toBe('It went to Sam, as it came to their own address')
  })

  it('says who a conversation was handed to', () => {
    expect(say(event('assigned', { to: SAM }, { userId: CHRIS }))).toBe('Chris handed it to Sam')
    expect(say(event('assigned', { to: CHRIS }, { userId: CHRIS }))).toBe('Chris took it on')
    expect(say(event('assigned', { to: null }, { userId: CHRIS }))).toBe("Chris took everybody's name off it")
  })
})

describe('who sees a line', () => {
  it('leaves notes out, because the note is already in the conversation', () => {
    expect(visibleTo(event('note', { messageId: 'm' }, { userId: CHRIS }), CHRIS)).toBe(false)
  })

  it('shows a discussion\'s own done and bin only to whoever did it', () => {
    const done = event('status', { status: 'done', forUserOnly: true }, { userId: SAM })
    expect(visibleTo(done, SAM)).toBe(true)
    expect(visibleTo(done, CHRIS)).toBe(false)
    expect(say(done, SAM)).toBe('Sam marked it done for themselves')
  })

  it('shows everybody an ordinary bin', () => {
    expect(visibleTo(event('binned', { ownerUserId: SAM }, { userId: SAM }), CHRIS)).toBe(true)
  })
})

describe('where a line goes', () => {
  const m = (id: string, sent: string, held?: string) => ({
    id, sentAt: new Date(sent), createdAt: new Date(held ?? sent),
  })
  const line = (e: TimelineEvent): TimelineLine => ({ event: e, text: e.kind })
  const shape = (entries: ReturnType<typeof weaveTimeline>) =>
    entries.map((e) => (e.type === 'message' ? e.message.id : `[${e.line.event.kind}]`))

  it('puts a line caused by a message directly before that message', () => {
    const messages = [m('a', '2026-09-01T09:00:00Z'), m('b', '2026-09-01T11:00:00Z')]
    // Recorded at noon, after both - but it was b that woke it.
    const woke = line(event('woken', { was: 'snoozed', messageId: 'b' }, { at: '2026-09-01T12:00:00Z' }))
    expect(shape(weaveTimeline(messages, [woke]))).toEqual(['a', '[woken]', 'b'])
  })

  it('places everything else after the last message that was already there', () => {
    const messages = [m('a', '2026-09-01T09:00:00Z'), m('b', '2026-09-01T11:00:00Z')]
    const snoozed = line(event('snoozed', {}, { at: '2026-09-01T10:00:00Z' }))
    expect(shape(weaveTimeline(messages, [snoozed]))).toEqual(['a', '[snoozed]', 'b'])
  })

  it('judges "already there" by when the site collected it, not the date written on it', () => {
    // Dated 10:00 but collected at 10:05: a snooze at 10:03 came before it.
    const messages = [m('a', '2026-09-01T09:00:00Z'), m('b', '2026-09-01T10:00:00Z', '2026-09-01T10:05:00Z')]
    const snoozed = line(event('snoozed', {}, { at: '2026-09-01T10:03:00Z' }))
    const woke = line(event('woken', { messageId: 'b' }, { at: '2026-09-01T10:05:01Z' }))
    expect(shape(weaveTimeline(messages, [snoozed, woke]))).toEqual(['a', '[snoozed]', '[woken]', 'b'])
  })

  it('keeps several lines caused by one message in the order they happened', () => {
    const messages = [m('a', '2026-09-01T09:00:00Z')]
    const woke = line(event('woken', { messageId: 'a' }, { at: '2026-09-01T09:00:01Z' }))
    const held = line(event('held', { messageId: 'a' }, { at: '2026-09-01T09:00:02Z' }))
    expect(shape(weaveTimeline(messages, [held, woke]))).toEqual(['[woken]', '[held]', 'a'])
  })

  it('falls back on the clock when the message it pointed at has gone', () => {
    const messages = [m('a', '2026-09-01T09:00:00Z')]
    const orphan = line(event('woken', { messageId: 'deleted' }, { at: '2026-09-01T10:00:00Z' }))
    expect(shape(weaveTimeline(messages, [orphan]))).toEqual(['a', '[woken]'])
  })

  it('puts lines from before the first message at the top', () => {
    const messages = [m('a', '2026-09-01T09:00:00Z')]
    const early = line(event('assigned', {}, { at: '2026-09-01T08:00:00Z' }))
    expect(shape(weaveTimeline(messages, [early]))).toEqual(['[assigned]', 'a'])
  })

  it('keeps a line between the same two messages when read newest first', () => {
    const messages = [m('a', '2026-09-01T09:00:00Z'), m('b', '2026-09-01T11:00:00Z')]
    const woke = line(event('woken', { messageId: 'b' }, { at: '2026-09-01T12:00:00Z' }))
    expect(shape(weaveTimeline(messages, [woke]).reverse())).toEqual(['b', '[woken]', 'a'])
  })

  it('shows lines on a conversation with no messages at all', () => {
    const lonely = line(event('binned', {}, { at: '2026-09-01T08:00:00Z' }))
    expect(shape(weaveTimeline([], [lonely]))).toEqual(['[binned]'])
  })
})
