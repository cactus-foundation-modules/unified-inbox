import { describe, it, expect } from 'vitest'
import { plannedSleepAfterSend } from './follow-up'

// What a conversation does once a message on a timer has left it.
//
// The case that brought this into being: a message set to go out on Monday
// morning, on a conversation that should ALSO stay asleep until Friday. That is
// one instruction - "Send later & snooze" - and it reaches this function by two
// routes. A reply puts the conversation to sleep on the spot, so the send has
// to leave the sleep it finds alone. A message starting a conversation has
// nothing to put to sleep yet, so the instruction rides on the draft and is
// carried out here, at the far end, by somebody who is not there.

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

  it('applies a sleep asked for on the draft, which is how a new conversation asks', () => {
    // Nothing to put to sleep when this was written: the conversation is made
    // by the send itself, so the instruction travelled on the draft.
    const until = new Date('2026-09-11T08:00:00.000Z')
    expect(plannedSleepAfterSend({
      followUpMinutes: null,
      sentAt: SENT,
      was: null,
      snoozeUntil: until,
    })).toEqual({ until, chase: false })
  })

  it('ignores a sleep on the draft that has run out by the time it goes', () => {
    expect(plannedSleepAfterSend({
      followUpMinutes: null,
      sentAt: SENT,
      was: { status: 'open', snoozeUntil: null },
      snoozeUntil: new Date('2026-09-06T08:00:00.000Z'),
    })).toBeNull()
  })

  it('keeps whichever of the two sleeps lasts longer', () => {
    const friday = new Date('2026-09-11T08:00:00.000Z')
    // The conversation was already asleep until Tuesday; the draft says Friday.
    expect(plannedSleepAfterSend({
      followUpMinutes: null,
      sentAt: SENT,
      was: { status: 'snoozed', snoozeUntil: new Date('2026-09-08T08:00:00.000Z') },
      snoozeUntil: friday,
    })).toEqual({ until: friday, chase: false })
    // And the other way round.
    expect(plannedSleepAfterSend({
      followUpMinutes: null,
      sentAt: SENT,
      was: { status: 'snoozed', snoozeUntil: friday },
      snoozeUntil: new Date('2026-09-08T08:00:00.000Z'),
    })).toEqual({ until: friday, chase: false })
  })

  it('lets a chase written on an older draft outlast the sleep asked for', () => {
    expect(plannedSleepAfterSend({
      followUpMinutes: 60 * 24 * 7,
      sentAt: SENT,
      was: null,
      snoozeUntil: new Date('2026-09-08T08:00:00.000Z'),
    })).toEqual({ until: new Date('2026-09-14T09:00:00.000Z'), chase: true })
  })

  it('copes with a conversation that is not there to read', () => {
    expect(plannedSleepAfterSend({ followUpMinutes: null, sentAt: SENT, was: null })).toBeNull()
    expect(plannedSleepAfterSend({ followUpMinutes: 30, sentAt: SENT, was: null }))
      .toEqual({ until: new Date('2026-09-07T09:30:00.000Z'), chase: true })
  })
})
