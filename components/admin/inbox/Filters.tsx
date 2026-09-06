import Link from 'next/link'
import { inboxHref } from '@/modules/unified-inbox/lib/list'
import { QueryForm } from './QueryForm'
import { SearchIcon, SortIcon } from './icons'

// The search, and the narrower cuts across whatever the tabs above have already
// chosen: only the ones nobody has read, and only the ones handed to a
// particular colleague. Where a conversation stands is the tab row (see
// StatusTabs); these are the questions you ask of any of those.
//
// Search sits FIRST, above the tabs, which is where a mail program keeps it and
// where somebody arriving to find one thing looks before they look anywhere
// else. Beside it, the one control that changes the order rather than the
// contents: newest first, or oldest first for working a backlog off the bottom
// without the top moving under you.
//
// "Mine" used to be a chip here. It is a place in the rail now - Assigned to me
// - because "what is on my desk" is somewhere you go rather than a filter you
// remember to press, and having it in both spots meant two things that did the
// same thing and disagreed about whether they were on.
//
// All of it lives in the head of the list column, so it stays put while forty
// conversations go past underneath. It used to sit above the whole workspace,
// which meant scrolling the list scrolled the controls that made it off the top
// of the screen.
//
// Links and a form rather than client state: this panel is drawn on the server
// from the query string, so a filter held in the browser would describe a list
// the server had not drawn. The address stays the state; only the way it is
// changed is the router's job (see QueryForm), so narrowing a list no longer
// fetches the whole admin again.

type Props = {
  base: string
  params: Record<string, string>
  unreadOnly: boolean
  assignee: string | null
  search: string | null
  staff: Array<{ id: string; name: string }>
  /** Which end of the list is being read from, so the button can say what
   *  pressing it would do rather than what is already true. */
  oldestFirst: boolean
}

export function Filters({
  base, params, unreadOnly, assignee, search, staff, oldestFirst,
}: Props) {
  // Any filter change starts again at page one and closes whatever was open,
  // since the conversation on screen may not survive the new filter. A person's
  // page goes with it, for the same reason and because it was pinned open beside
  // a list that had changed underneath it.
  const reset = { page: null, id: null, person: null }

  // What each form carries with it: everything already chosen, less the one
  // field it is about to set and less the three the reset above clears.
  const carry = (own: string) => Object.fromEntries(
    Object.entries(params).filter(
      ([key, value]) => value && ![own, 'page', 'id', 'person'].includes(key),
    ),
  )

  return (
    <>
      <div className="uin-search-row">
        <QueryForm base={base} hidden={carry('q')} className="uin-search">
          <label className="sr-only" htmlFor="uin-search">Search conversations you can see</label>
          <span className="uin-search-icon" aria-hidden="true">{SearchIcon}</span>
          <input
            id="uin-search"
            name="q"
            type="search"
            defaultValue={search ?? ''}
            placeholder="Search"
          />
          <button type="submit" className="sr-only">Search</button>
        </QueryForm>
        {/* Order, not contents. A link rather than a button because it is one
            more thing in the address, like every other choice on this screen. */}
        <Link
          className="uin-icon-btn"
          href={inboxHref(base, params, { sort: oldestFirst ? null : 'oldest', ...reset })}
          aria-pressed={oldestFirst}
          title={oldestFirst ? 'Oldest first. Press for newest first.' : 'Newest first. Press for oldest first.'}
        >
          {SortIcon}
          <span className="sr-only">
            {oldestFirst ? 'Showing oldest first. Show newest first.' : 'Showing newest first. Show oldest first.'}
          </span>
        </Link>
      </div>

      <div className="uin-toolbar">
        <Link
          className="uin-chip"
          aria-current={unreadOnly ? 'true' : undefined}
          href={inboxHref(base, params, { unread: unreadOnly ? null : '1', ...reset })}
        >
          Unread
        </Link>
        {staff.length > 0 && (
          <QueryForm base={base} hidden={carry('assignee')} className="uin-toolbar-form">
            <label className="sr-only" htmlFor="uin-assignee">Assigned to</label>
            <select id="uin-assignee" name="assignee" defaultValue={assignee ?? ''}>
              <option value="">Anyone</option>
              <option value="unassigned">Nobody yet</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <button type="submit" className="btn btn-secondary btn-sm">Filter</button>
          </QueryForm>
        )}
        {search && (
          // Two halves on purpose. The chip is only so wide, and with the cross
          // inside the same run of text a long search ellipsised away the one
          // thing that takes the search off again.
          <Link className="uin-chip uin-chip-clear" href={inboxHref(base, params, { q: null, ...reset })}>
            <span className="uin-chip-clear-text">Searching for &ldquo;{search}&rdquo;</span>
            <span className="uin-chip-clear-x" aria-hidden="true">&times;</span>
            <span className="sr-only">Clear the search</span>
          </Link>
        )}
      </div>
    </>
  )
}
