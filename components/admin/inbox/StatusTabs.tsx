import { TabStrip } from '@/components/admin/TabStrip'
import { QueryForm } from './QueryForm'
import { inboxHref, type StatusFilter } from '@/modules/unified-inbox/lib/list'
import { SearchIcon } from './icons'

// Where a conversation stands, under the addresses: waiting, set aside, dealt
// with, or the lot.
//
// A second strip rather than a row of chips, because it is the same kind of
// choice as the row above it - which conversations am I looking at - and the
// admin already stacks tabs this way where one choice sits inside another.
//
// The numbers are what is behind each tab given everything else already chosen,
// so "Snoozed 3" beside a search for "invoice" means three snoozed conversations
// mention invoices, not three in the whole site.
//
// Every one of them is a change of address rather than a piece of client state:
// the panel is rendered on the server from the query string, so a filter held in
// the browser would describe a list the server had not drawn. It also means the
// view somebody is looking at can be sent to a colleague, and the back button
// does what a back button should.

type Props = {
  base: string
  params: Record<string, string>
  status: StatusFilter
  counts: Record<string, number>
  search: string | null
}

const STATUS_TABS: Array<{ value: StatusFilter; label: string; countKey: string }> = [
  { value: 'open', label: 'Open', countKey: 'open' },
  { value: 'snoozed', label: 'Snoozed', countKey: 'snoozed' },
  { value: 'done', label: 'Done', countKey: 'done' },
  { value: 'all', label: 'Everything', countKey: 'all' },
]

export function StatusTabs({ base, params, status, counts, search }: Props) {
  // Any change starts again at page one and closes whatever was open, since the
  // conversation on screen may not survive the new filter. A person's page goes
  // with it: searching used to leave somebody's page pinned beside a list that
  // had changed underneath it.
  const reset = { page: null, id: null, person: null }

  // What the search carries with it: everything already chosen, less the search
  // itself and less the three the reset above clears.
  const hidden = Object.fromEntries(
    Object.entries(params).filter(
      ([key, value]) => value && !['q', 'page', 'id', 'person'].includes(key),
    ),
  )

  return (
    <TabStrip
      style={{ marginBottom: '0.75rem' }}
      items={STATUS_TABS.map((tab) => {
        const count = counts[tab.countKey] ?? 0
        return {
          key: tab.value,
          active: status === tab.value,
          href: inboxHref(base, params, { status: tab.value, ...reset }),
          label: (
            <span className="uin-tab">
              <span className="uin-tab-name">{tab.label}</span>
              {count > 0 && (
                <span className="uin-tab-count uin-tab-count-quiet">
                  {/* Same ceiling as the counts on the addresses above. Two
                      thresholds on one visual chip is one too many. */}
                  {count > 999 ? '999+' : count}
                  <span className="sr-only"> conversations</span>
                </span>
              )}
            </span>
          ),
        }
      })}
      trailing={
        <QueryForm base={base} hidden={hidden} className="uin-search">
          <label className="sr-only" htmlFor="uin-search">Search conversations you can see</label>
          <input
            id="uin-search"
            name="q"
            type="search"
            defaultValue={search ?? ''}
            placeholder="Search conversations you can see"
          />
          <button type="submit" className="btn btn-secondary btn-sm" aria-label="Search">
            {SearchIcon}
          </button>
        </QueryForm>
      }
    />
  )
}
