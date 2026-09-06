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
// To is colleagues, and In is which of the site's own addresses it sits in.
// That is the whole difference between this and a message: there is no outside
// party to write to, only people here to put it to, and the address decides who
// may read it rather than where it goes. Naming several addresses starts one
// discussion in each - see the route for why one thread cannot honestly belong
// to two addresses at once.

export type DiscussionInbox = { id: string; name: string; address: string }
type StaffMember = { id: string; name: string }

type Props = {
  base: string
  params: Record<string, string>
  /** Every address this person may read. A discussion is a note, and a note
   *  takes reading rights rather than sending ones. */
  inboxes: DiscussionInbox[]
  /** Which one it opens ticked, worked out on the server from the open tab. */
  defaultInboxId: string | null
  staff: StaffMember[]
}

export function DiscussionView({ base, params, inboxes, defaultInboxId, staff }: Props) {
  const router = useRouter()
  const [chosen, setChosen] = useState<string[]>(
    defaultInboxId && inboxes.some((i) => i.id === defaultInboxId) ? [defaultInboxId] : [],
  )
  const [subject, setSubject] = useState('')
  const [text, setText] = useState('')
  const [mentions, setMentions] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // The token stops the browser asking twice: state has not come back round by
  // the time a second click lands in the same frame, so a disabled button is
  // not on its own enough.
  const inFlight = useRef(false)

  const closeHref = inboxHref(base, params, {})
  const guard = subject.trim().length > 0 || text.trim().length > 0

  const toggle = useCallback((id: string) => {
    setChosen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
    setError('')
  }, [])

  const submit = useCallback(async () => {
    if (chosen.length === 0) {
      setError('Say which of your addresses this is for.')
      return
    }
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
          inboxIds: chosen,
          subject: subject.trim(),
          body: text,
          mentions,
        }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        setError(plainReason(data?.error, 'That discussion could not be started.'))
        return
      }
      // It is a conversation now, so go and stand in it - in the first address
      // named, which on the ordinary single-address discussion is the only one.
      router.push(inboxHref(base, params, {
        id: data?.threadId ?? null,
        inbox: chosen[0] ?? null,
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
  }, [base, chosen, mentions, params, router, subject, text])

  return (
    <ComposeModal
      title="Start A Discussion"
      closeHref={closeHref}
      guard={guard}
      noun="discussion"
      focusId="uin-discussion-subject"
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
                    chosen={mentions}
                    onChange={setMentions}
                    placeholder="Start typing a name"
                  />
                </div>
              </div>
            )}

            <div className="uin-field-row uin-field-row--stack">
              <span className="uin-field-label" id="uin-discussion-in">In</span>
              <div className="uin-field-control">
                <div className="uin-pick-list" role="group" aria-labelledby="uin-discussion-in">
                  {inboxes.map((inbox) => (
                    <label className="uin-pick" key={inbox.id}>
                      <input
                        type="checkbox"
                        checked={chosen.includes(inbox.id)}
                        onChange={() => toggle(inbox.id)}
                      />
                      <span className="uin-pick-name" title={inbox.name}>{inbox.name}</span>
                      <span className="uin-recipients" title={inbox.address}>{inbox.address}</span>
                    </label>
                  ))}
                </div>
                {chosen.length > 1 && (
                  <span className="uin-field-hint">
                    Each address gets its own discussion, so each team can answer in their own.
                  </span>
                )}
              </div>
            </div>

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
