'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { inboxHref } from '@/modules/unified-inbox/lib/list'
import { plainReason } from './AttachmentPicker'
import { ComposeCancel, ComposeModal } from './ComposeModal'

// Ringing somebody.
//
// TWO LEGS, AND THE FORM SAYS SO. The site rings YOU first, from the number you
// picked, tells you who is about to be rung, and connects the two once you
// answer. Nothing here dials a customer and hopes somebody is holding the
// phone - and the "call me at" box is the visible half of that, rather than a
// setting somebody has to have filled in months ago.
//
// The number you dial FROM is the caller ID they see, which is the reason it is
// a menu rather than a fixed value: a supplier rung from the sales number is a
// supplier who rings the sales number back.
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
}

export function CallView({ base, params, numbers, defaultTo }: Props) {
  const router = useRouter()
  const [to, setTo] = useState(defaultTo ?? '')
  const [from, setFrom] = useState(numbers[0]?.number ?? '')
  const [callMeAt, setCallMeAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const inFlight = useRef(false)

  const closeHref = inboxHref(base, params, {})
  // Nothing here is written, only dialled, so there is nothing to lose by
  // closing it - three phone numbers typed once are not a half-written letter.
  const guard = false

  const submit = useCallback(async () => {
    if (!to.trim()) {
      setError('Say which number to ring.')
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
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    setNote('')
    try {
      const response = await fetch('/api/m/unified-inbox/calls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: to.trim(), from, callMeAt: callMeAt.trim() }),
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
  }, [callMeAt, from, router, to])

  return (
    <ComposeModal
      title="A call"
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
                <input
                  id="uin-call-to"
                  type="tel"
                  value={to}
                  onChange={(e) => { setTo(e.target.value); setError(''); setNote('') }}
                  placeholder="+447700900123"
                  autoComplete="off"
                />
              </div>
            </div>

            <div className="uin-field-row">
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

            <div className="uin-field-row">
              <label htmlFor="uin-call-me-at">Call me at</label>
              <div className="uin-field-control">
                <input
                  id="uin-call-me-at"
                  type="tel"
                  value={callMeAt}
                  onChange={(e) => { setCallMeAt(e.target.value); setError(''); setNote('') }}
                  placeholder="+447700900456"
                  /* The one box on this screen the browser can sensibly fill in:
                     it is the same number every time, and it is this person's
                     own. Nothing else here is theirs to remember. */
                  autoComplete="tel"
                />
                <span className="uin-field-hint">
                  Your phone rings first. Answer it, press any key, and you are put through.
                </span>
              </div>
            </div>
          </div>

          {error && <div className="alert alert-danger" role="alert">{error}</div>}
          {note && !error && <div className="alert alert-success" role="status">{note}</div>}

          <div className="uin-composer-row">
            <button type="button" className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>
              {busy ? 'Ringing...' : 'Ring them'}
            </button>
            <ComposeCancel closeHref={closeHref} guard={guard} askToLeave={askToLeave} />
          </div>
        </>
      )}
    </ComposeModal>
  )
}
