import Link from 'next/link'
import { formatCalendarDate, inboxHref } from '@/modules/unified-inbox/lib/list'
import { FilterMenu } from './FilterMenu'
import { QueryForm } from './QueryForm'
import { SearchIcon, SortIcon } from './icons'

// The search, the order, and the narrower cuts across whatever the tabs above
// have already chosen: only the ones nobody has read, and only the ones handed
// to a particular colleague. Where a conversation stands is the tab row (see
// StatusTabs); these are the questions you ask of any of those.
//
// Search sits FIRST, above the tabs, which is where a mail program keeps it and
// where somebody arriving to find one thing looks before they look anywhere
// else. Beside it, the two controls that are about the list rather than in it:
// the filters, behind one button (see FilterMenu), and the one that changes the
// order rather than the contents - newest first, or oldest first for working a
// backlog off the bottom without the top moving under you.
//
// The filters used to be laid out flat here: a chip, a menu of names, and a
// Filter button to make the menu mean anything. That is a permanent row of
// controls across the top of the column for two questions asked once a week,
// so they went behind the button and the row underneath now holds only what is
// actually switched on.
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
// changed is the router's job (see QueryForm and FilterMenu), so narrowing a
// list no longer fetches the whole admin again.

type Props = {
  base: string
  params: Record<string, string>
  unreadOnly: boolean
  assignee: string | null
  search: string | null
  /** Whatever the search dialog has narrowed the list to on top of the words.
   *  Each one gets a chip, because a filter nobody can see is a filter somebody
   *  is stuck with - and the ones set from a dialog that closes behind them are
   *  exactly the ones that get forgotten. */
  narrowed: {
    from: string | null
    to: string | null
    subject: string | null
    withAttachment: boolean
    after: string | null
    before: string | null
  }
  staff: Array<{ id: string; name: string }>
  /** Which end of the list is being read from, so the button can say what
   *  pressing it would do rather than what is already true. */
  oldestFirst: boolean
}

export function Filters({
  base, params, unreadOnly, assignee, search, narrowed, staff, oldestFirst,
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

  // Every cut that is currently on, in the order they are asked for. The same
  // chip for all of them: what it is, and the cross that takes it off again.
  const chips: Array<{ key: string; label: string }> = []
  if (unreadOnly) chips.push({ key: 'unread', label: 'Unread only' })
  if (assignee) chips.push({ key: 'assignee', label: assigneeLabel(assignee, staff) })
  if (search) chips.push({ key: 'q', label: `Searching for “${search}”` })
  chips.push(...narrowedChips(narrowed))

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
        <FilterMenu
          base={base}
          params={params}
          unreadOnly={unreadOnly}
          assignee={assignee}
          staff={staff}
        />
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

      {chips.length > 0 && (
        <div className="uin-toolbar">
          {chips.map((chip) => (
            // Two halves on purpose. The chip is only so wide, and with the
            // cross inside the same run of text a long search ellipsised away
            // the one thing that takes the search off again.
            <Link
              key={chip.key}
              className="uin-chip uin-chip-clear"
              href={inboxHref(base, params, { [chip.key]: null, ...reset })}
            >
              <span className="uin-chip-clear-text">{chip.label}</span>
              <span className="uin-chip-clear-x" aria-hidden="true">&times;</span>
              <span className="sr-only">Take this off</span>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}

/** What the assignee chip says. The id on its own means nothing to anybody, and
 *  a name that has since left the site still has to read as something. */
function assigneeLabel(assignee: string, staff: Props['staff']): string {
  if (assignee === 'unassigned') return 'Assigned to nobody yet'
  const person = staff.find((s) => s.id === assignee)
  return person ? `Assigned to ${person.name}` : 'Assigned to somebody who has left'
}

/** One chip per cut the search dialog has made, in the order the dialog asks
 *  about them. Written out here rather than as six copies of the same markup
 *  above, and keyed by the param each one takes off. */
function narrowedChips(narrowed: Props['narrowed']): Array<{ key: string; label: string }> {
  const chips: Array<{ key: string; label: string }> = []
  if (narrowed.from) chips.push({ key: 'from', label: `From “${narrowed.from}”` })
  if (narrowed.to) chips.push({ key: 'to', label: `To “${narrowed.to}”` })
  if (narrowed.subject) chips.push({ key: 'subject', label: `Subject “${narrowed.subject}”` })
  if (narrowed.withAttachment) chips.push({ key: 'att', label: 'With something attached' })
  if (narrowed.after) chips.push({ key: 'after', label: `Since ${formatCalendarDate(narrowed.after)}` })
  if (narrowed.before) chips.push({ key: 'before', label: `Up to ${formatCalendarDate(narrowed.before)}` })
  return chips
}
