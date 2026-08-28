import { inboxHref, type StatusFilter } from '@/modules/unified-inbox/lib/list'
import { SearchIcon } from './icons'

// Filters and search, as links and a plain form.
//
// Every one of them is a change of address rather than a piece of client state:
// the panel is rendered on the server from the query string, so a filter held
// in the browser would describe a list the server had not drawn. It also means
// the view somebody is looking at can be sent to a colleague, and the back
// button does what a back button should.

type Props = {
  base: string
  params: Record<string, string>
  status: StatusFilter
  unreadOnly: boolean
  assignee: string | null
  search: string | null
  staff: Array<{ id: string; name: string }>
  currentUserId: string
}

const STATUS_TABS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'snoozed', label: 'Snoozed' },
  { value: 'done', label: 'Done' },
  { value: 'all', label: 'Everything' },
]

export function Filters({ base, params, status, unreadOnly, assignee, search, staff, currentUserId }: Props) {
  // Any filter change starts again at page one and closes whatever was open,
  // since the conversation on screen may not survive the new filter.
  const reset = { page: null, id: null }
  return (
    <div className="uin-filters">
      {STATUS_TABS.map((tab) => (
        <a
          key={tab.value}
          className="uin-chip"
          aria-current={status === tab.value ? "true" : undefined}
          href={inboxHref(base, params, { status: tab.value, ...reset })}
        >
          {tab.label}
        </a>
      ))}
      <a
        className="uin-chip"
        aria-current={unreadOnly ? "true" : undefined}
        href={inboxHref(base, params, { unread: unreadOnly ? null : '1', ...reset })}
      >
        Unread only
      </a>
      <a
        className="uin-chip"
        aria-current={assignee === currentUserId ? "true" : undefined}
        href={inboxHref(base, params, { assignee: assignee === currentUserId ? null : currentUserId, ...reset })}
      >
        Mine
      </a>
      {staff.length > 0 && (
        <form method="get" action={base} className="uin-search" style={{ flex: '0 0 auto' }}>
          {Object.entries({ ...params, ...reset }).map(([k, v]) =>
            v && k !== 'assignee' ? <input key={k} type="hidden" name={k} value={v} /> : null,
          )}
          <label className="sr-only" htmlFor="uin-assignee">Assigned to</label>
          <select id="uin-assignee" name="assignee" defaultValue={assignee ?? ''}>
            <option value="">Anyone</option>
            <option value="unassigned">Nobody yet</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button type="submit" className="btn btn-secondary btn-sm">Filter</button>
        </form>
      )}
      <form method="get" action={base} className="uin-search">
        {Object.entries({ ...params, ...reset }).map(([k, v]) =>
          v && k !== 'q' ? <input key={k} type="hidden" name={k} value={v} /> : null,
        )}
        <label className="sr-only" htmlFor="uin-search">Search conversations</label>
        <input
          id="uin-search"
          name="q"
          type="search"
          defaultValue={search ?? ''}
          placeholder="Search everything you can see"
        />
        <button type="submit" className="btn btn-secondary btn-sm">
          {SearchIcon}<span className="sr-only">Search</span>
        </button>
      </form>
    </div>
  )
}
