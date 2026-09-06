import { describe, it, expect } from 'vitest'
import { plannedSleepAfterSend } from './follow-up'

// What a conversation does once a message on a timer has left it.
//
// The case that brought this into being: a reply set to go out on Monday
// morning, on a conversation somebody has ALSO put to sleep until Friday. The
// composer used to fold those two instructions into one button and the sleep
// went with the send; now they are given separately, and the send has to leave
// what it finds alone.

const SENT = new Date('2026-09-07T09:00:00.000Z')

describe('plannedSleepAfterSend', () => {
  it('leaves an open conversation alone when nothing was asked for', () => {
    expect(plannedSleepAfterSend({
      followUpMinutes: null,
      sentAt: SENT,
      was: { status: 'open', snoozeUntil: null },
    })).toBeNull()
  })

  it('puts back a sleep somebody set themselves, and does not call it a chase', () => {
    const until = new Date('2026-09-11T08:00:00.000Z')
    expect(plannedSleepAfterSend({
      followUpMinutes: null,
      sentAt: SENT,
      was: { status: 'snoozed', snoozeUntil: until },
    })).toEqual({ until, chase: false })
  })

  it('sets the chase where one was written and the conversation was awake', () => {
    expect(plannedSleepAfterSend({
      followUpMinutes: 60,
      sentAt: SENT,
      was: { status: 'open', snoozeUntil: null },
    })).toEqual({ until: new Date('2026-09-07T10:00:00.000Z'), chase: true })
  })

  it('keeps the later of the two when both were asked for', () => {
    const until = new Date('2026-09-11T08:00:00.000Z')
    // A chase an hour after the message would wake somebody who has put this
    // away until Friday. Friday wins the date; it is still their chase.
    expect(plannedSleepAfterSend({
      followUpMinutes: 60,
      sentAt: SENT,
      was: { status: 'snoozed', snoozeUntil: until },
    })).toEqual({ until, chase: true })
  })

  it('keeps the chase when it lands after the sleep', () => {
    expect(plannedSleepAfterSend({
      followUpMinutes: 60 * 24 * 7,
      sentAt: SENT,
      was: { status: 'snoozed', snoozeUntil: new Date('2026-09-08T08:00:00.000Z') },
    })).toEqual({ until: new Date('2026-09-14T09:00:00.000Z'), chase: true })
  })

  it('ignores a sleep that has already run out', () => {
    expect(plannedSleepAfterSend({
      followUpMinutes: null,
      sentAt: SENT,
      was: { status: 'snoozed', snoozeUntil: new Date('2026-09-06T08:00:00.000Z') },
    })).toBeNull()
  })

  it('ignores a conversation marked done, which is not asleep', () => {
    expect(plannedSleepAfterSend({
      followUpMinutes: null,
      sentAt: SENT,
      was: { status: 'done', snoozeUntil: null },
    })).toBeNull()
  })

  it('copes with a conversation that is not there to read', () => {
    expect(plannedSleepAfterSend({ followUpMinutes: null, sentAt: SENT, was: null })).toBeNull()
    expect(plannedSleepAfterSend({ followUpMinutes: 30, sentAt: SENT, was: null }))
      .toEqual({ until: new Date('2026-09-07T09:30:00.000Z'), chase: true })
  })
})
