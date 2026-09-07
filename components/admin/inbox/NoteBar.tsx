'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
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
// program has pinned it, and the full box keeps the ones that need it.
//
// Nothing here goes to the customer, which is why it says so on its face and
// wears the same amber the notes in the thread do. A note that reads as a reply
// is how something private ends up sounding like it was sent.
//
// TAGGING A COLLEAGUE is done by typing @ into the sentence, which is what
// everybody's fingers already do and what people were doing anyway - writing
// "@Sam can you look at this" into a line where nothing was listening. It used
// to be a button beside the box that opened a row of names underneath: two
// presses and a hunt through a wall of chips to do the commonest thing a note
// is for. The button has gone.
//
// The names open in a MENU ABOVE the line, one under another, because there is
// nothing below the note bar for a menu to open into - it is the bottom edge of
// the window. It was a row of chips wrapping under the box, a shape people read
// as things already chosen rather than as things to pick.
//
// TYPING THE NAME OUT IS ALSO A TAG. Picking off the menu is still the quick
// way, but somebody who types "@Emma can you look" and presses Return has said
// what they meant and had it silently ignored - which is the worst outcome
// available, because the note READS as though Emma was asked.
//
// The one thing not done is guessing. A written name has to match a colleague's
// name exactly, end where the name ends rather than in the middle of a longer
// word, and be the ONLY colleague it could be - two people of the same name are
// left for the menu to tell apart, where the pick carries an id rather than a
// spelling. The longest match wins, so "@Sam Smith" on a site with a Sam and a
// Sam Smith is Sam Smith rather than both of them.

/** How many names the menu offers at once. Past eight it is a list to scroll
 *  rather than a list to read, and another letter typed is quicker. */
const TAG_SUGGESTIONS = 8

/** What is being typed after an @, if anything. Two words at most: the menu
 *  narrows on every letter, and "@sam can you look" would otherwise go on
 *  looking for a colleague called "sam can you look".
 *
 *  Anchored to the caret rather than to the end of the box, so going back to
 *  put a name into a sentence already written works the same as typing one at
 *  the end of it. */
export function mentionQueryAt(text: string, caret: number): { query: string; from: number } | null {
  const before = text.slice(0, caret)
  const match = /(^|\s)@([^\s@]{0,24}(?:[ \t][^\s@]{0,24})?)$/.exec(before)
  if (!match) return null
  const query = match[2] ?? ''
  return { query, from: before.length - query.length - 1 }
}

type Person = { id: string; name: string }

/** A letter or a digit, ie a character that means the written name has not
 *  finished yet. "@Samuel" is not "@Sam" followed by something. */
const NAME_CHAR = /[\p{L}\p{N}]/u

/**
 * Who a note actually asks: everybody picked off the menu and still written in
 * it, plus everybody whose name is written out in full whether they were picked
 * or not.
 *
 * Pure, so the near misses are argued about in a test rather than in somebody's
 * post. Order is the order they appear, picked names first, and nobody twice.
 */
export function taggedInText(text: string, staff: Person[], picked: Person[] = []): string[] {
  const out: string[] = []
  const add = (id: string) => { if (!out.includes(id)) out.push(id) }

  // Chosen off the menu, and still in the sentence. Somebody picked and then
  // deleted back out of it was a thought that changed its mind, and telling them
  // anyway is how a note quietly asks the wrong person.
  for (const person of picked) {
    if (text.includes(`@${person.name}`)) add(person.id)
  }

  // Written out by hand. Each @ is looked at once, and only a whole name that
  // could be one person answers to it.
  const at = /(^|\s)@/g
  for (let hit = at.exec(text); hit; hit = at.exec(text)) {
    const tail = text.slice(hit.index + hit[0].length)
    const lower = tail.toLowerCase()
    let best: Person[] = []
    let longest = 0
    for (const person of staff) {
      const name = person.name.trim().toLowerCase()
      if (!name || !lower.startsWith(name)) continue
      // The name has to END where it ends. Otherwise a colleague called Sam is
      // tagged by the word "@Samuel", which is somebody else entirely.
      const next = tail.charAt(name.length)
      if (next && NAME_CHAR.test(next)) continue
      if (name.length > longest) { best = [person]; longest = name.length }
      else if (name.length === longest) best.push(person)
    }
    // Exactly one, or nobody. Two colleagues of the same name are a question
    // the menu answers and a spelling cannot.
    if (best.length === 1) add(best[0]!.id)
  }

  return out
}

type Props = {
  threadId: string
  /** Everybody who could be asked. Already narrowed by the server to the people
   *  this conversation can sensibly be handed to. Empty means no tagging at all
   *  rather than an empty menu: a one-person site has nobody to tell. */
  staff: Person[]
}

export function NoteBar({ threadId, staff }: Props) {
  const router = useRouter()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** Whoever has been picked out of the menu, by name as well as by id: the
   *  name is how we tell afterwards whether they are still mentioned in the
   *  sentence or have been deleted back out of it. */
  const [tagged, setTagged] = useState<Person[]>([])
  /** What is being typed after an @ and where it starts, or null when the
   *  caret is not in one. */
  const [asking, setAsking] = useState<{ query: string; from: number } | null>(null)
  /** Which suggestion the keyboard is on. */
  const [cursor, setCursor] = useState(0)
  const box = useRef<HTMLInputElement>(null)
  // Stops the browser asking twice: state has not come back round by the time a
  // second press lands in the same frame, so a disabled button is not on its
  // own enough. Same guard, and the same reason, as the composer's.
  const inFlight = useRef(false)

  const suggestions = useMemo(() => {
    if (!asking || staff.length === 0) return []
    const wanted = asking.query.trim().toLowerCase()
    const matches = wanted
      ? staff.filter((person) => person.name.toLowerCase().includes(wanted))
      : staff
    return matches.slice(0, TAG_SUGGESTIONS)
  }, [asking, staff])

  /** Read the caret out of the box and work out whether it is in an @. Done on
   *  every keystroke, every click and every arrow key, because all three move
   *  it. */
  const readCaret = useCallback(() => {
    const el = box.current
    if (!el || staff.length === 0) { setAsking(null); return }
    const caret = el.selectionStart ?? el.value.length
    const found = mentionQueryAt(el.value, caret)
    setAsking(found)
    setCursor(0)
  }, [staff.length])

  /** Put a name in the sentence, in place of what was typed after the @. */
  const pick = useCallback((person: Person) => {
    if (!asking) return
    const before = text.slice(0, asking.from)
    const after = text.slice(asking.from + 1 + asking.query.length)
    const written = `${before}@${person.name} `
    setText(written + after)
    setTagged((prev) => (prev.some((one) => one.id === person.id) ? prev : [...prev, person]))
    setAsking(null)
    setError('')
    // Back in the box, with the caret after the name rather than at the end of
    // whatever was already written past it.
    const el = box.current
    if (el) {
      window.requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(written.length, written.length)
      })
    }
  }, [asking, text])

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
      const mentions = taggedInText(note, staff, tagged)
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
      setTagged([])
      setAsking(null)
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
  }, [router, staff, tagged, text, threadId])

  return (
    <div className="uin-notebar">
      <span className="uin-notebar-icon" aria-hidden="true">{NoteIcon}</span>
      <input
        ref={box}
        type="text"
        className="uin-notebar-input"
        value={text}
        disabled={busy}
        placeholder={staff.length > 0
          ? 'Leave an internal note - nobody outside sees this. Type @ to ask somebody'
          : 'Leave an internal note - nobody outside sees this'}
        aria-label="Leave an internal note. Nobody outside sees this. Type @ to ask a colleague to look."
        autoComplete="off"
        role="combobox"
        aria-expanded={suggestions.length > 0}
        aria-controls="uin-notebar-names"
        onChange={(event) => { setText(event.target.value); setError(''); readCaret() }}
        onClick={readCaret}
        onBlur={() => {
          // After the click on a name has had its chance to land. A menu that
          // vanishes on blur is a menu nothing can be picked out of.
          window.setTimeout(() => setAsking(null), 150)
        }}
        onKeyDown={(event) => {
          if (suggestions.length > 0) {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setCursor((was) => (was + 1) % suggestions.length)
              return
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setCursor((was) => (was - 1 + suggestions.length) % suggestions.length)
              return
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              const person = suggestions[cursor] ?? suggestions[0]
              if (person) {
                event.preventDefault()
                pick(person)
                return
              }
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              // Only the menu. Escape inside a conversation is not a keystroke
              // that should be throwing a half-typed note away.
              event.stopPropagation()
              setAsking(null)
              return
            }
          }
          // The arrows move the caret, which can move it in or out of an @.
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            window.requestAnimationFrame(readCaret)
            return
          }
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

      {/* The names, one under another, opening upwards out of the bar. The bar
          is pinned to the bottom of the conversation, so there is nothing below
          it to open into - and a menu above the line covers the messages, which
          are still there when it closes, rather than the sentence being
          written. */}
      {suggestions.length > 0 && (
        <ul
          className="uin-notebar-names"
          id="uin-notebar-names"
          role="listbox"
          aria-label="Colleagues"
        >
          {suggestions.map((person, index) => (
            <li key={person.id}>
              <button
                type="button"
                className="uin-notebar-name"
                role="option"
                aria-selected={index === cursor}
                data-on={index === cursor ? '1' : undefined}
                // The click has to happen without the box losing the caret
                // first, which is what a mouse-down anywhere else does.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setCursor(index)}
                onClick={() => pick(person)}
              >
                {person.name}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Above the line rather than beside it: the bar is one line by design and
          a whole sentence pushed into it would take the box down to nothing. */}
      {error && <p className="uin-notebar-error" role="alert">{error}</p>}
    </div>
  )
}
