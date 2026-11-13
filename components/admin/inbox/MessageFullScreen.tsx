'use client'

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon } from './icons'
import { MessageBody } from './MessageBody'
import { MessageText } from './MessageText'

/** What the full-screen view needs to know about the one message it shows. */
export type FullScreenMessage = {
  id: string
  /** Who it is from, as the header of the message says it. */
  from: string
  subject: string | null
  hasHtml: boolean
  hasRemoteImages: boolean
  ownSender: boolean
  bodyText: string | null
}

type Props = {
  message: FullScreenMessage
  open: boolean
  onClose: () => void
}

/**
 * One message with the whole screen to itself.
 *
 * On a phone a message is read inside a pane that is inside a frame that has a
 * header pinned over the top of it, and an email written for a 600px column
 * gets whatever is left. This gives it every pixel the phone has, and nothing
 * else on the screen but the way back out.
 *
 * A message narrower than the screen sits in the middle of it rather than
 * against the left edge, which is how it was written to be seen: a newsletter
 * built as a 500px column looks lost hugging one side of a landscape phone.
 * The frame is told to centre (see `centred` on MessageBody), because the email
 * is laid out inside a frame this page cannot reach into.
 *
 * Read-only, so there is nothing to lose by closing it: Escape and the cross
 * both simply shut it. Put on the body through a portal so no pane's overflow,
 * transform or stacking can clip it.
 */
export function MessageFullScreen({ message, open, onClose }: Props) {
  const closeButton = useRef<HTMLButtonElement>(null)
  // Read through a box so the key listener is added once per opening, not once
  // per render of whatever is holding this.
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose })

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
      returnTo?.focus()
    }
  }, [open])

  if (!open || typeof document === 'undefined') return null

  const heading = message.subject?.trim() || '(no subject)'

  return createPortal(
    <div
      className="uin-fullmsg"
      role="dialog"
      aria-modal="true"
      aria-label={`${heading}, from ${message.from}`}
    >
      <header className="uin-fullmsg-head">
        <div className="uin-fullmsg-title">
          <span className="uin-fullmsg-subject">{heading}</span>
          <span className="uin-fullmsg-from">{message.from}</span>
        </div>
        <button
          ref={closeButton}
          type="button"
          className="uin-icon-btn uin-fullmsg-close"
          aria-label="Close the full-screen view"
          title="Close"
          onClick={onClose}
        >
          {CloseIcon}
        </button>
      </header>
      <div className="uin-fullmsg-scroll">
        <div className="uin-fullmsg-body">
          {message.hasHtml ? (
            <MessageBody
              messageId={message.id}
              hasRemoteImages={message.hasRemoteImages}
              ownSender={message.ownSender}
              centred
            />
          ) : (
            <div className="uin-fullmsg-text">
              <MessageText text={message.bodyText ?? '(this message had nothing in it)'} />
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
