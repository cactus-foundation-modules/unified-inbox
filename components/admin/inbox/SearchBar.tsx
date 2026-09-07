'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  buildSearchHref,
  inboxHref,
  leaveSearchHref,
  searchRequestFrom,
  type SearchRequest,
} from '@/modules/unified-inbox/lib/list'
import { ContactsNote, SearchFields, SearchModes, type SearchPlaces } from './SearchFields'
import { CloseIcon, SearchIcon, SortIcon } from './icons'

// The head of a search's own screen.
//
// Pressing Search in the dialog used to close it and leave a list one cut
// shorter than it was, with the cuts themselves behind a magnifier somebody had
// to go and open again to see what they had asked for - and the chips above the
// list said what was on, but changing one meant taking it off and starting the
// dialog over. So a search now lands somewhere: the same box, the same eight
// cuts, drawn across the top of the list AND the conversation rather than
// squeezed into a column twenty-four rems wide, with the results underneath and
// whatever was opened from them beside.
//
// The words wait for Enter, because a query re-run on every keystroke is a
// query per keystroke. Everything that is a choice rather than a phrase - where
// to look, where it stands, the two ticks, and which of the two lists is being
// searched - goes the moment it is picked: a menu that needs a second press to
// mean anything is a menu people press once and then wonder about.
//
// Every one of them ends up in the address, like every other choice on this
// screen, so a search can be sent to a colleague and the back button still
// walks back through the ones before it.

/** The cuts that act on the spot. The rest are phrases somebody is still
 *  typing, and a router push per keystroke is a query per keystroke. */
const INSTANT: ReadonlySet<keyof SearchRequest> = new Set([
  'mode', 'scope', 'status', 'withAttachment', 'unreadOnly',
])

type Props = SearchPlaces & {
  /** The inbox page itself, which every search is an address on. */
  base: string
  /** Everything already in the address, so a new search keeps the tab it was
   *  made on. */
  params: Record<string, string>
  /** Which end of the results is being read from, so the button can say what
   *  pressing it would do rather than what is already true. */
  oldestFirst: boolean
}

export function SearchBar({ base, params, inboxes, channels, showUnrouted, oldestFirst }: Props) {
  const router = useRouter()
  const [request, setRequest] = useState<SearchRequest>(() => searchRequestFrom(params))

  // The boxes follow the address when the address changes underneath them -
  // the back button, or a place picked off the rail while a search is up, both
  // of which leave the form describing a screen nobody is looking at any more.
  //
  // Compared as one string rather than as the object it arrived in: the params
  // are rebuilt by the server component above on every draw, so an identity
  // check would put the form back to whatever the server last sent in the
  // middle of somebody typing into it. Done during the render rather than after
  // it, which is React's own answer to a prop the state has to follow: an
  // effect would draw the stale form once and then correct it.
  const address = new URLSearchParams(params).toString()
  const [drawn, setDrawn] = useState(address)
  if (drawn !== address) {
    setDrawn(address)
    setRequest(searchRequestFrom(params))
  }

  const go = (next: SearchRequest) => router.push(buildSearchHref(base, params, next))

  const set = <K extends keyof SearchRequest>(key: K, value: SearchRequest[K]) => {
    const next = { ...request, [key]: value }
    setRequest(next)
    if (INSTANT.has(key)) go(next)
  }

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    go(request)
  }

  const contacts = request.mode === 'contacts'

  return (
    <div className="uin-find">
      <form onSubmit={submit} role="search" aria-label="Search everything you can see">
        <div className="uin-find-head">
          <div className="uin-search uin-find-box">
            <span className="uin-search-icon" aria-hidden="true">{SearchIcon}</span>
            <label className="sr-only" htmlFor="uin-find-q">
              {contacts ? 'Search the address book' : 'Search everything you can see'}
            </label>
            <input
              id="uin-find-q"
              type="search"
              value={request.q}
              onChange={(event) => set('q', event.target.value)}
              placeholder={contacts ? 'A name, an address, a company' : 'Words in the message'}
              autoComplete="off"
            />
          </div>
          <button type="submit" className="btn btn-primary btn-sm">Search</button>
          {/* Order rather than contents, and the same button the head of the
              list has when there is no search over it: results worth reading
              from the far end are exactly the ones a search turns up. A link,
              because it is one more thing in the address like everything else
              here. */}
          <Link
            className="uin-icon-btn"
            href={inboxHref(base, params, {
              sort: oldestFirst ? null : 'oldest', page: null, id: null, person: null,
            })}
            aria-pressed={oldestFirst}
            title={oldestFirst
              ? 'Oldest first. Press for newest first.'
              : 'Newest first. Press for oldest first.'}
          >
            {SortIcon}
            <span className="sr-only">
              {oldestFirst
                ? 'Showing oldest first. Show newest first.'
                : 'Showing newest first. Show oldest first.'}
            </span>
          </Link>
          {/* The way out, said as a cross rather than as "back": there is no
              screen behind this one to go back to - a search is a place, and
              leaving it means the inbox with nothing narrowing it. */}
          <Link
            className="uin-icon-btn"
            href={leaveSearchHref(base, params)}
            title="Leave the search and go back to the list"
          >
            {CloseIcon}
            <span className="sr-only">Leave the search</span>
          </Link>
        </div>

        {/* Side by side rather than the dialog's two columns: this strip is as
            wide as the list and the conversation together, and eight boxes
            stacked two-up across that much room would be a form with a field of
            white either side of it. */}
        <div className="uin-find-filters">
          <SearchModes mode={request.mode} set={set} />
          {contacts ? <ContactsNote /> : (
            <SearchFields
              request={request}
              set={set}
              inboxes={inboxes}
              channels={channels}
              showUnrouted={showUnrouted}
            />
          )}
        </div>
      </form>
    </div>
  )
}
