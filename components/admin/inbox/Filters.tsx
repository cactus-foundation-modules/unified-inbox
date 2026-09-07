import Link from 'next/link'
import { formatCalendarDate, inboxHref } from '@/modules/unified-inbox/lib/list'
import { BlockedAddresses } from './BlockedAddresses'
import { FilterMenu } from './FilterMenu'
import { QueryForm } from './QueryForm'
import { FilterIcon, SearchIcon, SortIcon } from './icons'

// The search, the order, and the narrower cuts across whatever the tabs above
// have already chosen: only the ones nobody has read, and only the ones handed
// to a particular colleague. Where a conversation stands is the tab row (see
// StatusTabs); these are the questions you ask of any of those.
//
// Search sits FIRST, above the tabs, which is where a mail program keeps it and
// where somebody arriving to find one thing looks before they look anywhere
// else. Beside it, the controls that are about the list rather than in it: the
// filters, behind one button (see FilterMenu), and the one that changes the
// order rather than the contents - newest first, or oldest first for working a
// backlog off the bottom without the top moving under you.
//
// And, in the Spam folder alone, a fourth: who the site turns away. It sits
// between the search and the filters because it is a question about this list
// rather than a cut across it, and because the Spam folder is now where blocked
// post lands - so it is where somebody is standing when they wonder who is on
// the list. Nowhere else, since on every other list it would be a settings
// screen wedged into a toolbar.
//
// The filters used to be laid out flat here: a chip, a menu of names, and a
// Filter button to make the menu mean anything. That is a permanent row of
// controls across the top of the column for two questions asked once a week,
// so they went behind the button and the row underneath now holds only what is
// actually switched on.
//
// "Mine" used to be a chip here, and then briefly a place in the rail. It is
// neither now: what has been handed to somebody shows in the address they open
// on, beside the post that arrived there, because "what is on my desk" is the
// screen they are already looking at rather than a filter they remember to
// press or a second list they remember to check. What is left here is the
// genuinely occasional question - what is on somebody ELSE's desk.
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
  /** Whether this is the reader's OWN address, where the menu collapses into a
   *  single unread toggle. See the note above the button below. */
  ownInbox: boolean
  /** The Spam folder, which is the one list that gets a fourth control - the
   *  addresses the site turns away. Null everywhere else, and that is the whole
   *  of the condition: see the note beside the button. */
  blockedAddresses: { canUnblock: boolean } | null
}

export function Filters({
  base, params, unreadOnly, assignee, search, narrowed, staff, oldestFirst, ownInbox,
  blockedAddresses,
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
        {/* On the Spam folder only, and between the search and the filters
            because that is where the errand happens. Post from a blocked sender
            is collected and dropped straight in here, so this folder is where
            somebody is standing when the question occurs to them: who IS
            blocked, and why has that customer stopped getting through? Sending
            them to a settings page to find out is sending them somewhere they
            then have to find their way back from. It is the same list and the
            same route as Settings -> Collecting, not a second one. */}
        {blockedAddresses && (
          <BlockedAddresses staff={staff} canUnblock={blockedAddresses.canUnblock} />
        )}
        {/* On the reader's OWN address the menu is a menu of one, so it is not
            a menu. Everything in that list is either post that came to them or
            work handed to them; "whose desk is this on" has the same answer all
            the way down, and a panel that has to be opened to find one tick is
            two presses for a question with one answer. So the same button in
            the same place becomes a plain switch: press it for the unread,
            press it again for the lot. Everywhere else - a shared address, All,
            a channel - the full menu stands, because there the assignee
            question is the useful one. */}
        {ownInbox ? (
          <Link
            className={unreadOnly ? 'uin-icon-btn uin-icon-btn-on' : 'uin-icon-btn'}
            href={inboxHref(base, params, { unread: unreadOnly ? null : '1', ...reset })}
            aria-pressed={unreadOnly}
            title={unreadOnly ? 'Showing only what you have not read. Press to show everything.' : 'Show only what you have not read'}
          >
            {FilterIcon}
            <span className="sr-only">
              {unreadOnly ? 'Showing only what you have not read. Show everything.' : 'Show only what you have not read.'}
            </span>
          </Link>
        ) : (
          <FilterMenu
            base={base}
            params={params}
            unreadOnly={unreadOnly}
            assignee={assignee}
            staff={staff}
          />
        )}
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
