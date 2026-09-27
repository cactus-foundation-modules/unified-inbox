'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { SEGMENT_CHARS_UNICODE, segmentsFor } from '@/modules/unified-inbox/lib/sms-segments'
import { ConfirmDialog } from './ConfirmDialog'

// A text to the person an email conversation is with, written from that
// conversation.
//
// A dialog rather than the full writing box: a text has no subject, no
// attachments, no signature and no quotation, and the writing box is built
// around all four. What it does need is the count beside it - a text is charged
// by the segment, and one curly quote shortens every segment in the message.
//
// The number is shown but cannot be changed here. The route reads it off the
// contact card itself, so the only way to text somebody else is to change the
// card - which is where a wrong number should be put right anyway.

/** What went wrong, in words worth reading. The route explains everything it
 *  can in plain English; only the answers with nothing to say are rewritten. */
function refusal(status: number, message: string | null): string {
  if (status === 401) return 'You have been signed out. Sign in again and try once more.'
  if (status === 403 && !message) return 'You are not allowed to answer this conversation.'
  return message ?? 'That text could not be sent just now. Nothing has gone out.'
}

type Props = {
  open: boolean
  threadId: string
  /** Where it will go, as the card has it, for reading rather than editing. */
  to: string
  onClose: () => void
}

export function SendTextDialog({ open, threadId, to, onClose }: Props) {
  const router = useRouter()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const { segments, perSegment } = segmentsFor(text)

  const close = useCallback(() => {
    if (inFlight.current) return
    setError('')
    onClose()
  }, [onClose])

  const send = useCallback(async () => {
    if (!text.trim()) {
      setError('There is nothing to send yet.')
      return
    }
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/m/unified-inbox/threads/${threadId}/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text.trim() }),
      })
      const data = (await response.json().catch(() => null)) as { error?: string } | null
      if (!response.ok) {
        setError(refusal(response.status, data?.error ?? null))
        return
      }
      setText('')
      onClose()
      // The text is written onto the conversation on the server, and the pane
      // is rendered there, so a refresh is what puts it on the screen.
      router.refresh()
    } catch {
      setError('The site could not be reached. Nothing was sent.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [onClose, router, text, threadId])

  return (
    <ConfirmDialog
      open={open}
      title="Send a text message"
      initialFocus="#uin-thread-text"
      body={
        <>
          <p>To <strong>{to}</strong>, from the site&apos;s own number. It is kept in this conversation, and so is their reply.</p>
          <label className="sr-only" htmlFor="uin-thread-text">Your text</label>
          <textarea
            id="uin-thread-text"
            className="uin-text-dialog-box"
            rows={5}
            value={text}
            maxLength={640}
            disabled={busy}
            onChange={(event) => { setText(event.target.value); setError('') }}
            placeholder="Keep it short. This is a text, not an email."
          />
          <p className="uin-text-dialog-count">
            {segments === 0
              ? `${perSegment} characters to a text.`
              : segments === 1
                ? `One text, ${perSegment - text.length} characters left.`
                : `${segments} texts. They are charged one at a time.`}
            {perSegment === SEGMENT_CHARS_UNICODE && ' A curly quote or emoji shortens every one of them.'}
          </p>
          {/* Same colour as the other refusals on this screen: --color-danger
              measures under AA on this ground at this size. */}
          {error && (
            <p style={{ color: 'var(--color-destructive-hover)' }} role="alert">{error}</p>
          )}
        </>
      }
      confirmLabel={busy ? 'Sending...' : 'Send text'}
      busy={busy}
      onCancel={close}
      onConfirm={() => void send()}
    />
  )
}
