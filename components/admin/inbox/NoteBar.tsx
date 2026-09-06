'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { NoteIcon, SendIcon } from './icons'

// One line at the foot of the conversation for saying something to the people
// you work with.
//
// It was a button in the row at the top that opened the full writing box in
// note mode - the same box a customer reply is written in, with attachments and
// a send-later picker and a signature behind it, for a sentence like "rang
// them, no answer". Most notes are that sentence. So the sentence gets a line
// of its own, pinned to the bottom of the conversation the way every chat
// program has pinned it, and the full box keeps the ones that need it: pressing
// Reply and switching to Internal note inside it still does everything this
// does and more, including mentioning a colleague.
//
// Nothing here goes to the customer, which is why it says so on its face and
// wears the same amber the notes in the thread do. A note that reads as a reply
// is how something private ends up sounding like it was sent.

export function NoteBar({ threadId }: { threadId: string }) {
  const router = useRouter()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const box = useRef<HTMLInputElement>(null)
  // Stops the browser asking twice: state has not come back round by the time a
  // second press lands in the same frame, so a disabled button is not on its
  // own enough. Same guard, and the same reason, as the composer's.
  const inFlight = useRef(false)

  const save = useCallback(async () => {
    const note = text.trim()
    if (!note) {
      setError('There is nothing to leave yet.')
      return
    }
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/m/unified-inbox/threads/${threadId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: note, mentions: [] }),
      })
      if (!response.ok) {
        setError((await response.json().catch(() => null))?.error ?? 'That note could not be saved.')
        return
      }
      setText('')
      // Straight back in the box: leaving one note is the best predictor there
      // is of leaving a second.
      box.current?.focus()
      router.refresh()
    } catch {
      setError('The site could not be reached, so nothing was saved.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [router, text, threadId])

  return (
    <div className="uin-notebar">
      <span className="uin-notebar-icon" aria-hidden="true">{NoteIcon}</span>
      <input
        ref={box}
        type="text"
        className="uin-notebar-input"
        value={text}
        disabled={busy}
        placeholder="Leave an internal note - nobody outside sees this"
        aria-label="Leave an internal note. Nobody outside sees this."
        onChange={(event) => { setText(event.target.value); setError('') }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey) return
          event.preventDefault()
          void save()
        }}
      />
      <button
        type="button"
        className="btn btn-secondary btn-sm uin-notebar-send"
        disabled={busy || !text.trim()}
        onClick={() => void save()}
      >
        <span className="uin-notebar-send-icon" aria-hidden="true">{SendIcon}</span>
        <span>{busy ? 'Saving...' : 'Note'}</span>
      </button>
      {/* Above the line rather than beside it: the bar is one line by design and
          a whole sentence pushed into it would take the box down to nothing. */}
      {error && <p className="uin-notebar-error" role="alert">{error}</p>}
    </div>
  )
}
