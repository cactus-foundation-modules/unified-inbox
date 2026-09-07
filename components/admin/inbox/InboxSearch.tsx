'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import {
  buildSearchHref,
  searchRequestFrom,
  type SearchRequest,
} from '@/modules/unified-inbox/lib/list'
import { ContactsNote, SearchFields, SearchModes, type SearchPlaces } from './SearchFields'
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

type Props = SearchPlaces & {
  /** The inbox page itself, which every search is an address on. */
  base: string
  /** Everything already in the address, so a search keeps the tab it was made
   *  on and the boxes open filled in with whatever is already narrowing the
   *  list. */
  params: Record<string, string>
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

      {/* DRAWN INTO THE PAGE ITSELF, NOT WHERE THE BUTTON IS, AND THAT IS NOT
          decoration. The magnifier lives in the head of the rail, which is
          position: sticky so it stays put while the addresses scroll under it -
          and a sticky box makes a stacking context, which a fixed dialog inside
          it cannot get out of however high its z-index is. Left where it was,
          this went UNDER the pinned head of the conversation and the note bar,
          which is to say behind the middle and right columns. The composers,
          the confirmations and the undo toast are all drawn out here for the
          same reason. There is no page on the server, and this is never open on
          a first render, so the two sides agree. */}
      {open && typeof document !== 'undefined' && createPortal(
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
                <SearchModes mode={request.mode} set={set} />

                {contacts ? <ContactsNote /> : (
                  <div className="uin-search-grid">
                    <SearchFields
                      request={request}
                      set={set}
                      inboxes={inboxes}
                      channels={channels}
                      showUnrouted={showUnrouted}
                    />
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
        </div>,
        document.body,
      )}
    </>
  )
}
