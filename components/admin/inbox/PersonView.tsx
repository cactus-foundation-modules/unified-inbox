import Link from 'next/link'
import type { ContextSection } from '@/modules/unified-inbox/lib/adapters'
import type { OutboundLogRow, ThreadListRow, PersonEventRow, MergeRow } from '@/modules/unified-inbox/lib/db'
import type { Person, PersonIdentity, RecordLink } from '@/modules/unified-inbox/lib/types'
import { channelLabel, formatFull, formatWhen, inboxHref, participantLabel } from '@/modules/unified-inbox/lib/list'
import { BackIcon, InboundIcon, OutboundIcon } from './icons'
import { PersonActionsBar, PersonActionsPanels, PersonActionsProvider } from './PersonActions'
import { ContextRail } from './ContextRail'

// One person, and everything about them the hub can honestly show.
//
// The timeline is the point of the whole people layer: two emails, a live chat
// and a phone call from one human, in the order they happened, plus the
// automated mail the site sent them - which no amount of reading a mailbox
// would ever find, because it goes out through the sending account and never
// touches anybody's Sent folder (D13).
//
// What it is NOT is a customer record with a value on it. There is no pipeline
// here, no stage, no score and no next action, and there is not going to be.

type Props = {
  adminPath: string
  base: string
  params: Record<string, string>
  person: Person
  identities: PersonIdentity[]
  threads: ThreadListRow[]
  outbound: OutboundLogRow[]
  sections: ContextSection[]
  links: RecordLink[]
  events: PersonEventRow[]
  merges: MergeRow[]
  alsoHere: Person[]
  staffById: Record<string, string>
  canEdit: boolean
  canManage: boolean
  now: Date
}

type TimelineItem =
  | { kind: 'thread'; at: Date; row: ThreadListRow }
  | { kind: 'sent'; at: Date; row: OutboundLogRow }

// What the queries behind this page stop at. Kept here beside the sentences
// that own up to them, because a timeline that simply stops is a timeline
// somebody trusts to be complete when it is not.
const THREAD_CAP = 50
const OUTBOUND_CAP = 25
const EVENT_CAP = 50

function buildTimeline(threads: ThreadListRow[], outbound: OutboundLogRow[]): TimelineItem[] {
  const items: TimelineItem[] = []
  for (const row of threads) {
    if (row.lastMessageAt) items.push({ kind: 'thread', at: row.lastMessageAt, row })
  }
  for (const row of outbound) items.push({ kind: 'sent', at: row.sentAt, row })
  return items.sort((a, b) => b.at.getTime() - a.at.getTime())
}

/** A date with no clock on it. When somebody first wrote in is a fact about a
 *  day, and a weekday and a time of day only make it harder to read. */
function formatDay(value: Date | string | null): string {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

/** What one line of the record says. Everything written against a person today
 *  is a merge of one sort or another, which is why this used to describe every
 *  row as one - and would have gone on describing them as one the day something
 *  else started being written. */
function describeEvent(event: PersonEventRow): string {
  if (event.kind === 'merged') {
    if (event.detail?.split) return 'split them apart'
    if (event.detail?.undone) return 'undid a merge'
    return 'merged somebody in'
  }
  return 'made a change'
}

export function PersonView({
  adminPath, base, params, person, identities, threads, outbound, sections, links,
  events, merges, alsoHere, staffById, canEdit, canManage, now,
}: Props) {
  const timeline = buildTimeline(threads, outbound)
  const name = person.displayName || person.primaryEmail || 'Somebody'
  const knownSince = formatDay(person.createdAt)
  const cappedThreads = threads.length >= THREAD_CAP
  const cappedOutbound = outbound.length >= OUTBOUND_CAP
  const stopsAt = [
    cappedThreads ? `${THREAD_CAP} most recent conversations` : null,
    cappedOutbound ? `${OUTBOUND_CAP} most recent automatic emails` : null,
  ].filter(Boolean).join(' and the ')

  return (
    <PersonActionsProvider
      personId={person.id}
      displayName={person.displayName}
      notes={person.notes}
      identities={identities.map((i) => ({ id: i.id, value: i.value, kind: i.kind }))}
      merges={merges.map((m) => ({ id: m.id, loserName: m.loserName }))}
      canManage={canManage}
    >
      <div className="uin-thread">
        <div className="uin-thread-head">
          <Link className="uin-chip uin-back" href={inboxHref(base, params, { person: null })} style={{ justifySelf: 'start' }}>
            {BackIcon} Back to the list
          </Link>
          <h2 className="uin-thread-subject">{name}</h2>
          <div className="uin-thread-meta">
            {person.organisationName && <span>{person.organisationName}</span>}
            <span>
              {person.organisationName ? <>&middot; </> : null}
              {cappedThreads
                ? `${THREAD_CAP}+ conversations`
                : `${threads.length} conversation${threads.length === 1 ? '' : 's'}`}
            </span>
            {knownSince && <span>&middot; known since {knownSince}</span>}
          </div>
          {/* Only the buttons live up here, beside their name. What they open
              is below, where it is free to be as tall as it needs. */}
          {canEdit && <PersonActionsBar />}
        </div>

        <div className="uin-thread-body">
          {canEdit && <PersonActionsPanels />}
          <div className="uin-person">
            <div className="uin-person-main">
              <section className="uin-ctx-block">
                <h3 className="uin-ctx-heading">How we reach them</h3>
                <ul className="uin-ctx-list">
                  {identities.map((identity) => (
                    <li key={identity.id} className="uin-ctx-row">
                      <div className="uin-ctx-main">
                        <span>{identity.value}</span>
                        {identity.kind !== 'email' && (
                          <span className="uin-tag">{channelLabel(identity.kind)}</span>
                        )}
                      </div>
                    </li>
                  ))}
                  {identities.length === 0 && (
                    <li className="uin-ctx-row"><span className="uin-ctx-sub">Nothing on record yet.</span></li>
                  )}
                </ul>
                {alsoHere.length > 0 && (
                  <p className="uin-ctx-sub">
                    Also at {person.organisationName}:{' '}
                    {alsoHere.map((other, index) => (
                      <span key={other.id}>
                        {index > 0 && ', '}
                        <Link href={inboxHref(base, params, { person: other.id })}>
                          {other.displayName || other.primaryEmail || 'Somebody'}
                        </Link>
                      </span>
                    ))}
                  </p>
                )}
              </section>

              {person.notes && (
                <section className="uin-ctx-block">
                  <h3 className="uin-ctx-heading">Notes</h3>
                  <p className="uin-ctx-sub" style={{ whiteSpace: 'pre-wrap' }}>{person.notes}</p>
                </section>
              )}

              <section className="uin-ctx-block">
                <h3 className="uin-ctx-heading">Everything, in order</h3>
                {timeline.length === 0 ? (
                  <p className="uin-ctx-sub">
                    Nothing to show yet. Anything they write, and anything the site sends them, will
                    appear here.
                  </p>
                ) : (
                  <ul className="uin-timeline">
                    {timeline.map((item) =>
                      item.kind === 'thread' ? (
                        <li key={`t:${item.row.id}`} className="uin-timeline-row">
                          <span className="uin-timeline-icon">
                            {item.row.lastDirection === 'out' ? OutboundIcon : InboundIcon}
                          </span>
                          <div className="uin-ctx-main">
                            <Link href={inboxHref(base, params, { id: item.row.id, person: null })}>
                              {item.row.subject || '(no subject)'}
                            </Link>
                            <span className="uin-tag">{channelLabel(item.row.channel)}</span>
                            {item.row.unread && <span className="uin-tag">Unread</span>}
                          </div>
                          <span className="uin-ctx-sub">
                            {participantLabel(item.row)} &middot; {formatWhen(item.at, now)}
                          </span>
                        </li>
                      ) : (
                        <li key={`s:${item.row.id}`} className="uin-timeline-row">
                          <span className="uin-timeline-icon">{OutboundIcon}</span>
                          <div className="uin-ctx-main">
                            <span>{item.row.subject}</span>
                            <span className="uin-tag" title="Sent by the site rather than typed by anybody">
                              Sent automatically
                            </span>
                            {item.row.status === 'failed' && (
                              <span className="uin-tag uin-tag-failed">It did not send</span>
                            )}
                          </div>
                          <span className="uin-ctx-sub">
                            {item.row.toAddress} &middot; {formatWhen(item.at, now)}
                          </span>
                        </li>
                      ),
                    )}
                  </ul>
                )}
                {/* A list that simply stopped was a list somebody would have
                    taken for the whole story. */}
                {stopsAt && (
                  <p className="uin-ctx-sub">
                    This list stops at the {stopsAt}. Anything older is still on the site; it is
                    just not on this page.
                  </p>
                )}
                {outbound.length > 0 && (
                  <p className="uin-ctx-sub">
                    Mail the site sent on its own is listed by what it was and when it went. There is
                    no copy of what it said, which is deliberate - a record of every email ever sent
                    would grow until it had to be thrown away.
                  </p>
                )}
              </section>

              {events.length > 0 && (
                <details>
                  <summary className="uin-chip uin-summary">What has been done to this record</summary>
                  <ul className="uin-log">
                    {events.map((event) => (
                      <li key={event.id}>
                        {(event.userId && staffById[event.userId]) || 'Somebody'}{' '}
                        {describeEvent(event)}
                        {' - '}
                        {formatFull(event.createdAt)}
                      </li>
                    ))}
                  </ul>
                  {events.length >= EVENT_CAP && (
                    <p className="uin-ctx-sub">Only the {EVENT_CAP} most recent are listed.</p>
                  )}
                </details>
              )}
            </div>

            <ContextRail
              adminPath={adminPath}
              threadId={null}
              base={base}
              params={params}
              person={null}
              noPersonReason={null}
              sections={sections}
              links={links}
              // The same permission the conversation rail gets. Being able to
              // see what is attached to somebody and never being able to take
              // any of it off read as a broken button rather than a decision.
              canEditLinks={canEdit}
            />
          </div>
        </div>
      </div>
    </PersonActionsProvider>
  )
}
