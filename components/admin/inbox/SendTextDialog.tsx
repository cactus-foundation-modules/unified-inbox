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
  /** The name of the live chat this conversation is on ("Live chat"), when the
   *  same words can also be put in it. Null on an email conversation. */
  chatLabel?: string | null
  onClose: () => void
}

export function SendTextDialog({ open, threadId, to, chatLabel = null, onClose }: Props) {
  const router = useRouter()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [alsoChat, setAlsoChat] = useState(false)
  // The text went but the chat would not take it: shown, and the box locked,
  // because sending again would text them twice.
  const [partial, setPartial] = useState('')
  const inFlight = useRef(false)
  const { segments, perSegment } = segmentsFor(text)

  const close = useCallback(() => {
    if (inFlight.current) return
    setError('')
    if (partial) { setPartial(''); setText(''); router.refresh() }
    onClose()
  }, [onClose, partial, router])

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
        body: JSON.stringify({ body: text.trim(), ...(chatLabel && alsoChat ? { alsoChat: true } : {}) }),
      })
      const data = (await response.json().catch(() => null)) as { error?: string; chatSent?: boolean; chatError?: string } | null
      if (!response.ok) {
        setError(refusal(response.status, data?.error ?? null))
        return
      }
      if (data?.chatSent === false) {
        setPartial(`The text was sent, but it could not be put in ${chatLabel ?? 'the chat'}: ${data.chatError ?? 'it would not go.'}`)
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
  }, [alsoChat, chatLabel, onClose, router, text, threadId])

  return (
    <ConfirmDialog
      open={open}
      title="Send a text message"
      initialFocus="#uin-thread-text"
      body={
        <>
          <p>To <strong>{to}</strong>, from the site&apos;s own number. {chatLabel ? 'It is kept in this conversation.' : 'It is kept in this conversation, and so is their reply.'}</p>
          <label className="sr-only" htmlFor="uin-thread-text">Your text</label>
          <textarea
            id="uin-thread-text"
            className="uin-text-dialog-box"
            rows={5}
            value={text}
            maxLength={640}
            disabled={busy || !!partial}
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
          {chatLabel && (
            <label className="uin-text-dialog-also" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={alsoChat} disabled={busy || !!partial} onChange={(event) => setAlsoChat(event.target.checked)} />
              Also send in {chatLabel}
            </label>
          )}
          {partial && <p role="alert">{partial}</p>}
          {/* Same colour as the other refusals on this screen: --color-danger
              measures under AA on this ground at this size. */}
          {error && (
            <p style={{ color: 'var(--color-destructive-hover)' }} role="alert">{error}</p>
          )}
        </>
      }
      confirmLabel={busy ? 'Sending...' : partial ? 'Done' : 'Send text'}
      busy={busy}
      onCancel={close}
      onConfirm={() => { if (partial) close(); else void send() }}
    />
  )
}
