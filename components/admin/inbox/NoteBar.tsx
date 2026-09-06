'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AtIcon, NoteIcon, SendIcon } from './icons'

// One line at the foot of the conversation for saying something to the people
// you work with.
//
// It was a button in the row at the top that opened the full writing box in
// note mode - the same box a customer reply is written in, with attachments and
// a send-later picker and a signature behind it, for a sentence like "rang
// them, no answer". Most notes are that sentence. So the sentence gets a line
// of its own, pinned to the bottom of the conversation the way every chat
// program has pinned it, and the full box keeps the ones that need it.
//
// Nothing here goes to the customer, which is why it says so on its face and
// wears the same amber the notes in the thread do. A note that reads as a reply
// is how something private ends up sounding like it was sent.
//
// TAGGING A COLLEAGUE lives here too, and that is a change: it used to be
// buried in the full writing box, which meant the commonest reason for leaving
// a note at all - "Sam, can you look at this" - was the one thing this line
// could not do, and people wrote the name into the sentence instead where
// nothing was listening.
//
// The names are picked from a list rather than scraped out of the words. A
// colleague called Sam Smith and another called Sam Smyth are not something a
// regular expression should be deciding between, and a tag now hands somebody
// a job and a way into the conversation - which is not a thing to get wrong on
// a near miss.

/** How many names the row offers before it wants narrowing. Eight fits a line
 *  on an ordinary window; past that the row becomes a wall and the search box
 *  earns its place. */
const TAG_CHIPS = 8

type Props = {
  threadId: string
  /** Everybody who could be asked. Already narrowed by the server to the people
   *  this conversation can sensibly be handed to. Empty means no tagging at all
   *  rather than an empty row: a one-person site has nobody to tell. */
  staff: Array<{ id: string; name: string }>
}

export function NoteBar({ threadId, staff }: Props) {
  const router = useRouter()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tagging, setTagging] = useState(false)
  const [mentions, setMentions] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const box = useRef<HTMLInputElement>(null)
  // Stops the browser asking twice: state has not come back round by the time a
  // second press lands in the same frame, so a disabled button is not on its
  // own enough. Same guard, and the same reason, as the composer's.
  const inFlight = useRef(false)

  // Whoever matches what has been typed, plus anybody already ticked - a name
  // that vanishes from the row the moment you narrow past it is a tag you
  // cannot see and cannot take off again.
  const offered = useMemo(() => {
    const wanted = query.trim().toLowerCase()
    const matches = wanted
      ? staff.filter((person) => person.name.toLowerCase().includes(wanted))
      : staff
    const shown = matches.slice(0, TAG_CHIPS)
    const kept = staff.filter(
      (person) => mentions.includes(person.id) && !shown.some((one) => one.id === person.id),
    )
    return { shown: [...kept, ...shown], hidden: Math.max(0, matches.length - shown.length) }
  }, [mentions, query, staff])

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
        body: JSON.stringify({ text: note, mentions }),
      })
      if (!response.ok) {
        setError((await response.json().catch(() => null))?.error ?? 'That note could not be saved.')
        return
      }
      setText('')
      // The names go with the note they were attached to. Leaving them ticked
      // is how the next note - "no answer, will try Tuesday" - quietly asks
      // three people a second time.
      setMentions([])
      setQuery('')
      setTagging(false)
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
  }, [mentions, router, text, threadId])

  const chosen = staff.filter((person) => mentions.includes(person.id))

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
      {staff.length > 0 && (
        <button
          type="button"
          className="uin-icon-btn uin-icon-btn-framed uin-notebar-tag"
          aria-expanded={tagging}
          aria-controls="uin-notebar-tags"
          title="Ask a colleague to look at this"
          disabled={busy}
          onClick={() => setTagging((was) => !was)}
        >
          {AtIcon}
          <span className="sr-only">
            Ask a colleague to look at this{chosen.length > 0 ? `. ${chosen.length} chosen.` : ''}
          </span>
          {chosen.length > 0 && <span className="uin-notebar-tag-count" aria-hidden="true">{chosen.length}</span>}
        </button>
      )}
      <button
        type="button"
        className="btn btn-secondary btn-sm uin-notebar-send"
        disabled={busy || !text.trim()}
        onClick={() => void save()}
      >
        <span className="uin-notebar-send-icon" aria-hidden="true">{SendIcon}</span>
        <span>{busy ? 'Saving...' : 'Note'}</span>
      </button>

      {/* Below the line rather than in a panel over it. The bar already wraps,
          the names are wanted at the same time as the sentence rather than
          instead of it, and a menu that covers the note you are writing is a
          menu you close to check what you said. */}
      {tagging && staff.length > 0 && (
        <div className="uin-notebar-tags" id="uin-notebar-tags">
          <span className="uin-recipients">Ask somebody to look at this</span>
          {staff.length > TAG_CHIPS && (
            <input
              type="search"
              className="uin-notebar-find"
              value={query}
              placeholder="Start typing a name"
              autoComplete="off"
              aria-label="Find a colleague by name"
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
          {offered.shown.map((person) => (
            <button
              key={person.id}
              type="button"
              className="uin-chip"
              aria-pressed={mentions.includes(person.id)}
              disabled={busy}
              onClick={() => setMentions((prev) =>
                prev.includes(person.id) ? prev.filter((id) => id !== person.id) : [...prev, person.id],
              )}
            >
              {person.name}
            </button>
          ))}
          {offered.shown.length === 0 && (
            <span className="uin-recipients">Nobody here goes by that.</span>
          )}
          {offered.hidden > 0 && (
            <span className="uin-recipients">
              {offered.hidden === 1
                ? 'One more. Keep typing to find them.'
                : `${offered.hidden} more. Keep typing to find them.`}
            </span>
          )}
          {/* Said out loud, because it is the surprising half: a tag hands
              somebody a job AND lets them into this one conversation, which is
              not what "mention" means anywhere else. */}
          {chosen.length > 0 && (
            <p className="uin-notebar-tagnote">
              {chosen.length === 1
                ? `${chosen[0]!.name} will see this conversation and be able to work through it, whether or not this inbox is one of theirs.`
                : 'They will each see this conversation and be able to work through it, whether or not this inbox is one of theirs.'}
            </p>
          )}
        </div>
      )}

      {/* Above the line rather than beside it: the bar is one line by design and
          a whole sentence pushed into it would take the box down to nothing. */}
      {error && <p className="uin-notebar-error" role="alert">{error}</p>}
    </div>
  )
}
