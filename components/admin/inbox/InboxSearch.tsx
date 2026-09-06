'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  buildSearchHref,
  searchRequestFrom,
  type SearchRequest,
  type StatusFilter,
} from '@/modules/unified-inbox/lib/list'
import { CloseIcon, SearchIcon } from './icons'

// Search everything, from anywhere.
//
// There is a search box in the head of the list already, and it is the right
// thing for what it does: narrow the list in front of you. It is the wrong
// thing for the question people actually arrive with, which is "where is the
// message about the invoice" - because that message is in an address they are
// not standing in, was dealt with three weeks ago, and is therefore behind two
// choices they have to make correctly before the box will find it.
//
// So this one opens over the whole hub, looks everywhere the reader may look by
// default, and asks about any status rather than only the open ones. The
// narrower cuts a mail program has always had - who from, who to, subject,
// anything attached, between two dates - are boxes rather than a syntax nobody
// remembers, and every one of them ends up in the address like every other
// choice on this screen, so a search can be sent to a colleague and the back
// button still works.
//
// It sits beside the pen at the head of the rail, on the left of it, and the
// two are the same pair of acts: find something, or write something.

/** Everything the keyboard can land on inside the card, for the Tab circle. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const STATUS_LABELS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'Any status' },
  { value: 'open', label: 'Still open' },
  { value: 'snoozed', label: 'Set aside for later' },
  { value: 'done', label: 'Dealt with' },
]

type Props = {
  /** The inbox page itself, which every search is an address on. */
  base: string
  /** Everything already in the address, so a search keeps the tab it was made
   *  on and the boxes open filled in with whatever is already narrowing the
   *  list. */
  params: Record<string, string>
  /** The addresses this person may read, for the "where to look" menu. */
  inboxes: Array<{ id: string; name: string }>
  /** And the channels another module owns, which are places to look in exactly
   *  the same way. */
  channels: Array<{ key: string; label: string }>
  /** Whether "the mail that landed nowhere" is a place this reader has. */
  showUnrouted: boolean
}

export function InboxSearch({ base, params, inboxes, channels, showUnrouted }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [request, setRequest] = useState<SearchRequest>(() => searchRequestFrom(params))
  const card = useRef<HTMLDivElement>(null)

  // Filled in from the address every time it opens rather than once: the list
  // underneath may have been narrowed since, and a form that quietly disagrees
  // with the screen behind it throws away whatever it disagrees about the
  // moment somebody presses Search.
  const show = useCallback(() => {
    setRequest(searchRequestFrom(params))
    setOpen(true)
  }, [params])

  const set = <K extends keyof SearchRequest>(key: K, value: SearchRequest[K]) =>
    setRequest((current) => ({ ...current, [key]: value }))

  // Read out of a box so the shortcut below is put on the page once and left
  // there rather than rebuilt whenever the address changes.
  const showRef = useRef(show)
  useEffect(() => { showRef.current = show })

  // The one shortcut every mail program and every editor has bound to finding
  // something. Held here rather than on the button so it works while somebody
  // is reading a conversation three panes away.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'k' && event.key !== 'K') return
      if (!event.metaKey && !event.ctrlKey) return
      event.preventDefault()
      showRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // Escape closes, and the keyboard goes round in a circle inside the card
  // rather than off into the inbox behind it. Nothing here is unsaved, so
  // unlike the composers this one closes without asking - and the backdrop
  // closes it too, for the same reason.
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    card.current?.querySelector<HTMLElement>('#uin-search-all')?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const inside = card.current
      if (!inside) return
      const items = Array.from(inside.querySelectorAll<HTMLElement>(FOCUSABLE))
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      const active = document.activeElement
      if (!inside.contains(active)) {
        event.preventDefault()
        first.focus()
        return
      }
      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previous
    }
  }, [open])

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setOpen(false)
    router.push(buildSearchHref(base, params, request))
  }

  const contacts = request.mode === 'contacts'

  return (
    <>
      <button
        type="button"
        className="uin-rail-search"
        onClick={show}
        aria-label="Search everything"
        title="Search everything. Ctrl K, or Cmd K on a Mac."
      >
        {SearchIcon}
      </button>

      {open && (
        <div
          className="uin-modal"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}
        >
          <div
            className="uin-modal-card uin-search-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="uin-search-all-label"
            ref={card}
          >
            <form onSubmit={submit}>
              <div className="uin-search-head">
                <label className="sr-only" id="uin-search-all-label" htmlFor="uin-search-all">
                  Search everything you can see
                </label>
                <span className="uin-search-icon" aria-hidden="true">{SearchIcon}</span>
                <input
                  id="uin-search-all"
                  type="search"
                  value={request.q}
                  onChange={(event) => set('q', event.target.value)}
                  placeholder={contacts ? 'A name, an address, a company' : 'Words in the message'}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="uin-modal-close"
                  onClick={() => setOpen(false)}
                  aria-label="Close search"
                >
                  {CloseIcon}
                </button>
              </div>

              <div className="uin-modal-body uin-search-body">
                {/* Two lists, one box. The address book answers a different
                    question about the same people, and having to close this and
                    go and find the Contacts tab to ask it is the sort of thing
                    that makes somebody give up and search their own mail
                    client instead. */}
                <div className="uin-search-modes" role="group" aria-label="What to search">
                  <button
                    type="button"
                    className="uin-chip"
                    aria-pressed={!contacts}
                    onClick={() => set('mode', 'conversations')}
                  >
                    Conversations
                  </button>
                  <button
                    type="button"
                    className="uin-chip"
                    aria-pressed={contacts}
                    onClick={() => set('mode', 'contacts')}
                  >
                    Contacts
                  </button>
                </div>

                {contacts ? (
                  <p className="uin-search-note">
                    The address book takes the words and nothing else - who a message came
                    from, and when, are questions about post.
                  </p>
                ) : (
                  <div className="uin-search-grid">
                    <label className="uin-field">
                      <span>Where to look</span>
                      <select
                        value={request.scope}
                        onChange={(event) => set('scope', event.target.value)}
                      >
                        <option value="all">Everywhere you can see</option>
                        {inboxes.map((inbox) => (
                          <option key={inbox.id} value={inbox.id}>{inbox.name}</option>
                        ))}
                        {channels.map((channel) => (
                          <option key={channel.key} value={`m:${channel.key}`}>
                            {channel.label}
                          </option>
                        ))}
                        {showUnrouted && <option value="none">Not filed</option>}
                      </select>
                    </label>

                    <label className="uin-field">
                      <span>Where it stands</span>
                      <select
                        value={request.status}
                        onChange={(event) => set('status', event.target.value as StatusFilter)}
                      >
                        {STATUS_LABELS.map((status) => (
                          <option key={status.value} value={status.value}>{status.label}</option>
                        ))}
                      </select>
                    </label>

                    <label className="uin-field">
                      <span>From</span>
                      <input
                        type="text"
                        value={request.from}
                        onChange={(event) => set('from', event.target.value)}
                        placeholder="A name or an address"
                        autoComplete="off"
                      />
                    </label>

                    <label className="uin-field">
                      <span>To</span>
                      <input
                        type="text"
                        value={request.to}
                        onChange={(event) => set('to', event.target.value)}
                        placeholder="Anybody it was sent or copied to"
                        autoComplete="off"
                      />
                    </label>

                    <label className="uin-field uin-field-wide">
                      <span>Subject</span>
                      <input
                        type="text"
                        value={request.subject}
                        onChange={(event) => set('subject', event.target.value)}
                        placeholder="Words in the subject line"
                        autoComplete="off"
                      />
                    </label>

                    <label className="uin-field">
                      <span>Since</span>
                      <input
                        type="date"
                        value={request.after}
                        onChange={(event) => set('after', event.target.value)}
                      />
                    </label>

                    <label className="uin-field">
                      <span>Up to and including</span>
                      <input
                        type="date"
                        value={request.before}
                        onChange={(event) => set('before', event.target.value)}
                      />
                    </label>

                    <div className="uin-search-ticks">
                      <label className="uin-tick">
                        <input
                          type="checkbox"
                          checked={request.withAttachment}
                          onChange={(event) => set('withAttachment', event.target.checked)}
                        />
                        <span>Has something attached</span>
                      </label>
                      <label className="uin-tick">
                        <input
                          type="checkbox"
                          checked={request.unreadOnly}
                          onChange={(event) => set('unreadOnly', event.target.checked)}
                        />
                        <span>Nobody has read it</span>
                      </label>
                    </div>
                  </div>
                )}
              </div>

              <div className="uin-search-foot">
                <p className="uin-search-hint">
                  Ctrl K opens this from anywhere in the inbox - Cmd K on a Mac.
                </p>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setRequest((current) => ({
                    ...searchRequestFrom({}),
                    mode: current.mode,
                  }))}
                >
                  Empty the boxes
                </button>
                <button type="submit" className="btn btn-primary btn-sm">Search</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
