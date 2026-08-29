import Link from 'next/link'
import { inboxHref } from '@/modules/unified-inbox/lib/list'
import { QueryForm } from './QueryForm'

// The narrower cuts across whatever the tabs above have already chosen: only the
// ones nobody has read, only the ones that are mine, only the ones handed to a
// particular colleague. Where a conversation stands is a tab (see StatusTabs);
// these are the questions you ask of any of those.
//
// Links and a form rather than client state, for the same reason as the tabs:
// this panel is drawn on the server from the query string, so a filter held in
// the browser would describe a list the server had not drawn. The address stays
// the state; only the way it is changed is the router's job (see QueryForm), so
// narrowing a list no longer fetches the whole admin again.

type Props = {
  base: string
  params: Record<string, string>
  unreadOnly: boolean
  assignee: string | null
  search: string | null
  staff: Array<{ id: string; name: string }>
  currentUserId: string
  /** How many conversations the whole set of choices comes to, said out loud so
   *  a filter that quietly matches nothing is obvious rather than mysterious. */
  total: number
}

export function Filters({
  base, params, unreadOnly, assignee, search, staff, currentUserId, total,
}: Props) {
  // Any filter change starts again at page one and closes whatever was open,
  // since the conversation on screen may not survive the new filter. A person's
  // page goes with it, for the same reason and because it was pinned open beside
  // a list that had changed underneath it.
  const reset = { page: null, id: null, person: null }

  // What the assignee form carries with it: everything already chosen, less the
  // one field it is about to set and less the three the reset above clears.
  const hidden = Object.fromEntries(
    Object.entries(params).filter(
      ([key, value]) => value && !['assignee', 'page', 'id', 'person'].includes(key),
    ),
  )

  return (
    <div className="uin-toolbar">
      <Link
        className="uin-chip"
        aria-current={unreadOnly ? 'true' : undefined}
        href={inboxHref(base, params, { unread: unreadOnly ? null : '1', ...reset })}
      >
        Unread only
      </Link>
      <Link
        className="uin-chip"
        aria-current={assignee === currentUserId ? 'true' : undefined}
        href={inboxHref(base, params, {
          assignee: assignee === currentUserId ? null : currentUserId,
          ...reset,
        })}
      >
        Mine
      </Link>
      {staff.length > 0 && (
        <QueryForm base={base} hidden={hidden} className="uin-toolbar-form">
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
      <span className="uin-toolbar-count">
        {total === 1 ? '1 conversation' : `${total.toLocaleString('en-GB')} conversations`}
      </span>
    </div>
  )
}
