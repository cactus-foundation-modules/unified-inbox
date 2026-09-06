'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toE164 } from '@/lib/phone'
import { inboxHref } from '@/modules/unified-inbox/lib/list'
import { SEGMENT_CHARS_UNICODE, segmentsFor } from '@/modules/unified-inbox/lib/sms-segments'
import { plainReason } from './AttachmentPicker'
import { ComposeCancel, ComposeModal } from './ComposeModal'
import { ContactPhoneField } from './ContactPhoneField'

// Sending a text.
//
// It goes out through whichever part of the site owns text messages, and that
// same part files it back here as a phone conversation with that number - so
// nothing is written down twice, and what you see afterwards is what actually
// left rather than what this box hoped would.
//
// A text is charged by the segment, so the count beside the box is not
// decoration: 160 plain characters is one text, and a single curly quote or
// emoji drops that to 70 for the whole message. Better said before pressing
// Send than discovered on the bill.

type Props = {
  base: string
  params: Record<string, string>
  /** A number the screen already knew about - whoever the open conversation is
   *  with - so the ordinary case is not typed out again. */
  defaultTo: string | null
  /** Which country a number typed without one belongs to (Settings > General). */
  diallingCode: string
}

export function SmsView({ base, params, defaultTo, diallingCode }: Props) {
  const router = useRouter()
  const [to, setTo] = useState(defaultTo ?? '')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const inFlight = useRef(false)

  const closeHref = inboxHref(base, params, {})
  const guard = !note && text.trim().length > 0
  const { segments, perSegment } = segmentsFor(text)

  const submit = useCallback(async () => {
    if (!to.trim()) {
      setError('Say which number this is going to.')
      return
    }
    const sendTo = toE164(to, diallingCode)
    if (!sendTo) {
      setError('That does not look like a number to text. Try it as 07700 900123, or in full as +44 7700 900123.')
      return
    }
    if (!text.trim()) {
      setError('There is nothing to send yet.')
      return
    }
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    setNote('')
    try {
      const response = await fetch('/api/m/unified-inbox/sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: sendTo, body: text.trim() }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        setError(plainReason(data?.error, 'That text could not be sent.'))
        return
      }
      setText('')
      setNote(`Sent to ${data?.to ?? sendTo}. It will appear in the conversation with that number.`)
      router.refresh()
    } catch {
      setError('The site could not be reached. Nothing was sent.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [diallingCode, router, text, to])

  return (
    <ComposeModal
      title="A text message"
      closeHref={closeHref}
      guard={guard}
      noun="text"
      focusId="uin-sms-to"
    >
      {({ askToLeave }) => (
        <>
          <div className="uin-fields">
            <div className="uin-field-row">
              <label htmlFor="uin-sms-to">To</label>
              <div className="uin-field-control">
                <ContactPhoneField
                  id="uin-sms-to"
                  value={to}
                  onChange={(next) => { setTo(next); setError(''); setNote('') }}
                  onPick={(phone) => {
                    setTo(toE164(phone, diallingCode) ?? phone)
                    setError('')
                    setNote('')
                  }}
                  placeholder="A name, or 07700 900123"
                />
              </div>
            </div>
          </div>

          <div className="uin-compose-message">
            <label className="sr-only" htmlFor="uin-sms-text">Your message</label>
            <textarea
              id="uin-sms-text"
              value={text}
              onChange={(e) => { setText(e.target.value); setError(''); setNote('') }}
              placeholder="Keep it short. This is a text, not an email."
            />
          </div>

          <div className="uin-composer-row">
            <span className="uin-recipients">
              {segments === 0
                ? `${perSegment} characters to a text.`
                : segments === 1
                  ? `One text, ${perSegment - text.length} characters left.`
                  : `${segments} texts. They are charged one at a time.`}
              {perSegment === SEGMENT_CHARS_UNICODE && ' A curly quote or emoji shortens every one of them.'}
            </span>
          </div>

          {error && <div className="alert alert-danger" role="alert">{error}</div>}
          {note && !error && <div className="alert alert-success" role="status">{note}</div>}

          <div className="uin-composer-row uin-composer-row--end">
            <ComposeCancel closeHref={closeHref} guard={guard} askToLeave={askToLeave} />
            <button type="button" className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>
              {busy ? 'Sending...' : 'Send text'}
            </button>
          </div>
        </>
      )}
    </ComposeModal>
  )
}
