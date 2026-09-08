import Link from 'next/link'
import { LinkBusy } from './NavProgress'
import { inboxHref, type StatusFilter } from '@/modules/unified-inbox/lib/list'

// Where a conversation stands, at the head of the list it narrows: waiting, set
// aside, dealt with, or the lot - and, on a shared address, the queue in front
// of all four: the open ones nobody has picked up.
//
// Plain words with a line under the one that is on, rather than a pill or a
// segmented control. Four segments in a column this narrow is four boxes with
// two letters showing in each; words with the chosen one underlined take the
// width they need and no more, and it is the shape every mail program uses for
// the same four choices.
//
// The numbers are what is behind each one given everything else already chosen,
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
  /** What the row is a set of choices about. The same four words narrow a list
   *  of conversations and a list of things colleagues have asked you to look
   *  at, and only a screen reader is told which - so it is said once, here,
   *  rather than by a second component that would be this one with two strings
   *  changed. */
  unit?: string
  ariaLabel?: string
  /** Whether to put the queue in front of the other four. Only on a shared
   *  address: on somebody's own inbox "has anybody picked this up" has one
   *  answer all the way down, and on All it would be a queue spanning half a
   *  dozen addresses nobody is responsible for as a whole. */
  showUnassigned?: boolean
}

type Tab = { value: StatusFilter; label: string; countKey: string }

/** The queue, and first: on a shared address the morning starts with what
 *  nobody has taken, and the tab that answers that has no business being read
 *  after the three that answer what has already been dealt with.
 *
 *  It sets `status` and clears `assignee`, because it already says whose these
 *  are. Left carried, a name chosen in the filter menu would sit underneath it
 *  asking for the opposite thing and the list would simply be empty, with two
 *  controls each insisting they were right. */
const QUEUE_TAB: Tab = { value: 'unassigned', label: 'Unassigned', countKey: 'unassigned' }

const STATUS_TABS: Tab[] = [
  { value: 'open', label: 'Open', countKey: 'open' },
  { value: 'snoozed', label: 'Snoozed', countKey: 'snoozed' },
  { value: 'done', label: 'Done', countKey: 'done' },
  // "Everything" is the better word and does not fit: four segments share the
  // width of one column - five on a shared address - and the count has to fit
  // beside each of them. The row scrolls sideways rather than squashing when it
  // has to (see .uin-tabs), which is what makes room for the fifth.
  { value: 'all', label: 'All', countKey: 'all' },
]

export function StatusTabs({
  base, params, status, counts,
  unit = 'conversations', ariaLabel = 'Where a conversation stands',
  showUnassigned = false,
}: Props) {
  // Any change starts again at page one and closes whatever was open, since the
  // conversation on screen may not survive the new filter. A person's page goes
  // with it: searching used to leave somebody's page pinned beside a list that
  // had changed underneath it.
  const reset = { page: null, id: null, person: null }

  return (
    <div className="uin-tabs" role="group" aria-label={ariaLabel}>
      {(showUnassigned ? [QUEUE_TAB, ...STATUS_TABS] : STATUS_TABS).map((tab) => {
        const count = counts[tab.countKey] ?? 0
        return (
          <Link
            key={tab.value}
            className="uin-tab"
            href={inboxHref(base, params, {
              status: tab.value,
              ...(tab.value === 'unassigned' ? { assignee: null } : {}),
              ...reset,
            })}
            aria-current={status === tab.value ? 'true' : undefined}
          >
            {tab.label}
            {count > 0 && (
              <span className="uin-tab-count">
                {/* Same ceiling as the counts on the rail. Two thresholds on one
                    visual chip is one too many. */}
                {count > 999 ? '999+' : count}
                <span className="sr-only"> {unit}</span>
              </span>
            )}
            <LinkBusy />
          </Link>
        )
      })}
    </div>
  )
}
