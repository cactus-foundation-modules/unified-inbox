'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

// The name at the head of a conversation, which is also where it is renamed.
//
// Click it and it becomes a box with the name in it; Enter or clicking away
// keeps the new one, Escape leaves it as it was. No pencil beside it: the head
// of the conversation is short of room already, and a name that turns into a
// box when pressed is what people try first anyway.
//
// Renaming changes what people here read and nothing else. The customer's next
// reply still carries the old subject and still lands here - see renameThread.

type Props = {
  threadId: string
  subject: string | null
}

/** Must match the cap on the route (ThreadPatchBody), or a long paste would be
 *  refused with a message about something the box let them type. */
const MAX_LENGTH = 300

export function ThreadSubject({ threadId, subject }: Props) {
  const router = useRouter()
  const shown = subject?.trim() || '(no subject)'
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(subject ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Escape and Enter both end the edit, and the blur that follows either one
  // must not save a second time (or, after Escape, save at all).
  const settled = useRef(false)

  const start = () => {
    settled.current = false
    setValue(subject ?? '')
    setError('')
    setEditing(true)
  }

  const save = async () => {
    if (settled.current) return
    settled.current = true
    const next = value.trim()
    // Blank is taken as a slip rather than a wish to have no subject, and the
    // same name again is not a change worth a line in the timeline.
    if (!next || next === (subject ?? '').trim()) {
      setEditing(false)
      return
    }
    setBusy(true)
    try {
      const response = await fetch(`/api/m/unified-inbox/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: next }),
      })
      if (!response.ok) {
        setError((await response.json().catch(() => null))?.error ?? 'The new name could not be saved.')
        return
      }
      setEditing(false)
      router.refresh()
    } catch {
      setError('The site could not be reached, so the name has not changed.')
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <div className="uin-thread-subject uin-subject-editing">
        <label className="sr-only" htmlFor={`uin-subject-${threadId}`}>Conversation name</label>
        <input
          id={`uin-subject-${threadId}`}
          className="uin-subject-input"
          value={value}
          maxLength={MAX_LENGTH}
          disabled={busy}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => { void save() }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void save()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              settled.current = true
              setEditing(false)
            }
          }}
        />
        {error && <p className="uin-subject-error" role="alert">{error}</p>}
      </div>
    )
  }

  return (
    <h2 className="uin-thread-subject uin-subject-editable">
      {/* Two lines, then an ellipsis - so the whole of it goes in the title,
          where a subject cut short can still be read. */}
      <button type="button" className="uin-subject-button" title={shown} onClick={start}>
        {shown}
        <span className="sr-only"> - press to rename</span>
      </button>
    </h2>
  )
}
