'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { inboxHref } from '@/modules/unified-inbox/lib/list'
import { plainReason } from './AttachmentPicker'
import { ColleagueField } from './ColleagueField'
import { ComposeCancel, ComposeModal } from './ComposeModal'

// Starting a discussion: colleagues only, nothing sent, nobody outside sees it.
//
// The hub has always had internal notes, but only stuck to something a customer
// wrote. This is the same note with nothing above it - "a word about the
// Henderson order" without waiting for the Hendersons to write in.
//
// To is colleagues, and that is the whole of what is asked: there is no outside
// party to write to, only people here to put it to. WHERE it sits is not asked
// at all - it goes in the address the person starting it calls their own AND in
// the address of everybody it is put to, which the server settles from the
// names (see the discussions route). A tick list of addresses was a question
// with one sensible answer nine times in ten, and naming a colleague is a
// better way of asking the tenth than naming their mailbox.
//
// The keyboard starts on To rather than on Subject, which is where a form that
// addresses something has always started. Subject when there is nobody to
// address - a site with one person in it - because a To line that is not drawn
// is not somewhere focus can go.

type StaffMember = { id: string; name: string }

type Props = {
  base: string
  params: Record<string, string>
  /** The address it is started in: the person's own, or failing that the one
   *  they are standing in. Settled on the server, never chosen here. */
  inboxId: string
  staff: StaffMember[]
}

export function DiscussionView({ base, params, inboxId, staff }: Props) {
  const router = useRouter()
  const [subject, setSubject] = useState('')
  const [text, setText] = useState('')
  const [to, setTo] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // The token stops the browser asking twice: state has not come back round by
  // the time a second click lands in the same frame, so a disabled button is
  // not on its own enough.
  const inFlight = useRef(false)

  const closeHref = inboxHref(base, params, {})
  const guard = subject.trim().length > 0 || text.trim().length > 0 || to.length > 0

  const submit = useCallback(async () => {
    if (!subject.trim()) {
      setError('Give the discussion a subject.')
      return
    }
    if (!text.trim()) {
      setError('There is nothing to say yet.')
      return
    }
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/m/unified-inbox/discussions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inboxIds: [inboxId],
          subject: subject.trim(),
          body: text,
          toUserIds: to,
        }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        setError(plainReason(data?.error, 'That discussion could not be started.'))
        return
      }
      // It is a conversation now, so go and stand in it, in the address it
      // was started in.
      router.push(inboxHref(base, params, {
        id: data?.threadId ?? null,
        inbox: inboxId,
        page: null,
        compose: null,
      }))
      router.refresh()
    } catch {
      setError('The site could not be reached. Nothing was started.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [base, inboxId, params, router, subject, text, to])

  return (
    <ComposeModal
      title="Start A Discussion"
      closeHref={closeHref}
      guard={guard}
      noun="discussion"
      focusId={staff.length > 0 ? 'uin-discussion-to' : 'uin-discussion-subject'}
    >
      {({ askToLeave }) => (
        <>
          <div className="uin-fields">
            {staff.length > 0 && (
              <div className="uin-field-row">
                <label htmlFor="uin-discussion-to">To</label>
                <div className="uin-field-control">
                  <ColleagueField
                    id="uin-discussion-to"
                    colleagues={staff}
                    chosen={to}
                    onChange={setTo}
                    placeholder="Start typing a name"
                  />
                </div>
              </div>
            )}

            <div className="uin-field-row">
              <label htmlFor="uin-discussion-subject">Subject</label>
              <div className="uin-field-control">
                <input
                  id="uin-discussion-subject"
                  type="text"
                  value={subject}
                  onChange={(e) => { setSubject(e.target.value); setError('') }}
                  placeholder="What it is about"
                  autoComplete="off"
                />
              </div>
            </div>
          </div>

          <div className="uin-compose-message">
            <label className="sr-only" htmlFor="uin-discussion-text">What you want to say</label>
            <textarea
              id="uin-discussion-text"
              value={text}
              onChange={(e) => { setText(e.target.value); setError('') }}
              placeholder="Something for the others to see. Nothing here is ever sent to a customer."
            />
          </div>

          {error && <div className="alert alert-danger" role="alert">{error}</div>}

          <div className="uin-composer-row uin-composer-row--end">
            <ComposeCancel closeHref={closeHref} guard={guard} askToLeave={askToLeave} />
            <button type="button" className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>
              {busy ? 'Starting...' : 'Start the discussion'}
            </button>
          </div>
        </>
      )}
    </ComposeModal>
  )
}
