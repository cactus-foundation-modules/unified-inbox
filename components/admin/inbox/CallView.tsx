'use client'

import { useCallback, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toE164 } from '@/lib/phone'
import { inboxHref } from '@/modules/unified-inbox/lib/list'
import { plainReason } from './AttachmentPicker'
import { ComposeCancel, ComposeModal } from './ComposeModal'
import { ContactPhoneField } from './ContactPhoneField'

// Ringing somebody.
//
// TWO LEGS, AND THE FORM SAYS SO. The site rings YOU first, from the number you
// picked, tells you who is about to be rung, and connects the two once you
// answer. Nothing here dials a customer and hopes somebody is holding the
// phone - and the "call me at" box is the visible half of that.
//
// It is filled in from your account rather than typed out every time, and still
// editable, because the usual answer is the same number every day and the
// exception - you are at a customer's desk, ring the mobile - is the reason it
// is a box and not a fixed setting.
//
// The number you dial FROM is the caller ID they see, which is the reason it is
// a menu rather than a fixed value: a supplier rung from the sales number is a
// supplier who rings the sales number back.
//
// NUMBERS ARE TYPED THE WAY PEOPLE TYPE THEM. "020 8138 0512" off the bottom of
// an email is a whole number to the person reading it, so it is a whole number
// here: core's toE164 puts the country code on as the box is left, and the same
// sum is done again on the way in (see ../../../app/api/calls/route.ts) rather
// than trusting a browser to have done it.
//
// And a name is typed as often as a number, which is why the box you say who to
// ring in offers the address book underneath it - see ContactPhoneField.
//
// The call itself is recorded by whoever placed it and comes back to this hub
// as a phone conversation. Nothing is written down here, so there is nothing to
// keep in step.

export type CallerNumber = { number: string; label: string }

type Props = {
  base: string
  params: Record<string, string>
  /** The site's own numbers, worked out on the server. Never empty: the menu
   *  entry that opens this is not offered when there is nothing to call from. */
  numbers: CallerNumber[]
  /** Who the open conversation is with, when the screen already knew. */
  defaultTo: string | null
  /** This person's own number from their account, when they have given one. */
  defaultCallMeAt: string | null
  /** Which country a number typed without one belongs to (Settings > General). */
  diallingCode: string
  /** Their account page, for the one sentence that sends them to fill it in. */
  accountHref: string
}

export function CallView({
  base, params, numbers, defaultTo, defaultCallMeAt, diallingCode, accountHref,
}: Props) {
  const router = useRouter()
  const [to, setTo] = useState(defaultTo ?? '')
  const [from, setFrom] = useState(numbers[0]?.number ?? '')
  const [callMeAt, setCallMeAt] = useState(defaultCallMeAt ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const inFlight = useRef(false)

  const closeHref = inboxHref(base, params, {})
  // Nothing here is written, only dialled, so there is nothing to lose by
  // closing it - three phone numbers typed once are not a half-written letter.
  const guard = false

  /** Tidy a box into international form as it is left, when it can be read at
   *  all. A number it cannot read is left exactly as typed: rewriting somebody's
   *  half-finished number under their cursor is worse than leaving it be, and
   *  pressing the button says what is wrong with it. */
  const tidy = useCallback((value: string, set: (v: string) => void) => {
    const tidied = toE164(value, diallingCode)
    if (tidied && tidied !== value) set(tidied)
  }, [diallingCode])

  const submit = useCallback(async () => {
    setNote('')
    if (!to.trim()) {
      setError('Say which number to ring.')
      return
    }
    const dialTo = toE164(to, diallingCode)
    if (!dialTo) {
      setError('That does not look like a number to ring. Try it as 020 8138 0512, or in full as +44 20 8138 0512.')
      return
    }
    if (!from) {
      setError('Pick which of your numbers the call goes out as.')
      return
    }
    if (!callMeAt.trim()) {
      setError('Say where to ring you first.')
      return
    }
    const dialMe = toE164(callMeAt, diallingCode)
    if (!dialMe) {
      setError('Your own number does not look right. Try it as 07700 900123, or in full as +44 7700 900123.')
      return
    }
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/m/unified-inbox/calls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: dialTo, from, callMeAt: dialMe }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        setError(plainReason(data?.error, 'That call could not be placed.'))
        return
      }
      setNote('Your phone should ring in a moment. Answer it and press any key to be put through.')
      router.refresh()
    } catch {
      setError('The site could not be reached. No call was placed.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [callMeAt, diallingCode, from, router, to])

  return (
    <ComposeModal
      title="Make a call"
      closeHref={closeHref}
      guard={guard}
      noun="call"
      focusId="uin-call-to"
    >
      {({ askToLeave }) => (
        <>
          <div className="uin-fields">
            <div className="uin-field-row">
              <label htmlFor="uin-call-to">Ring</label>
              <div className="uin-field-control">
                <ContactPhoneField
                  id="uin-call-to"
                  value={to}
                  onChange={(next) => { setTo(next); setError(''); setNote('') }}
                  onPick={(phone) => {
                    setTo(toE164(phone, diallingCode) ?? phone)
                    setError('')
                    setNote('')
                  }}
                  placeholder="A name, or 020 8138 0512"
                />
              </div>
            </div>

            <div className="uin-field-row uin-field-row--stack">
              <label htmlFor="uin-call-from">As</label>
              <div className="uin-field-control">
                <select
                  id="uin-call-from"
                  value={from}
                  onChange={(e) => { setFrom(e.target.value); setError(''); setNote('') }}
                >
                  {numbers.map((n) => (
                    <option key={n.number} value={n.number}>{n.label}</option>
                  ))}
                </select>
                <span className="uin-field-hint">The number they see, and the one they ring back.</span>
              </div>
            </div>

            <div className="uin-field-row uin-field-row--stack">
              <label htmlFor="uin-call-me-at">Call me at</label>
              <div className="uin-field-control">
                <input
                  id="uin-call-me-at"
                  type="tel"
                  value={callMeAt}
                  onChange={(e) => { setCallMeAt(e.target.value); setError(''); setNote('') }}
                  onBlur={(e) => tidy(e.target.value, setCallMeAt)}
                  placeholder="07700 900123"
                  /* The one box on this screen the browser can sensibly fill in:
                     it is the same number every time, and it is this person's
                     own. Nothing else here is theirs to remember. */
                  autoComplete="tel"
                />
                <span className="uin-field-hint">
                  Your phone rings first. Answer it, press any key, and you are put through.
                  {!defaultCallMeAt && (
                    <> Put your number on <Link href={accountHref}>your account</Link> and it will be filled in next time.</>
                  )}
                </span>
              </div>
            </div>
          </div>

          {error && <div className="alert alert-danger" role="alert">{error}</div>}
          {note && !error && <div className="alert alert-success" role="status">{note}</div>}

          <div className="uin-composer-row uin-composer-row--end">
            <ComposeCancel closeHref={closeHref} guard={guard} askToLeave={askToLeave} />
            <button type="button" className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>
              {busy ? 'Ringing...' : 'Place call'}
            </button>
          </div>
        </>
      )}
    </ComposeModal>
  )
}
