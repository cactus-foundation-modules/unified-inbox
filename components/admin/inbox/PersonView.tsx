import type { ContextSection } from '@/modules/unified-inbox/lib/adapters'
import type { OutboundLogRow, ThreadListRow, PersonEventRow, MergeRow } from '@/modules/unified-inbox/lib/db'
import type { Person, PersonIdentity, RecordLink } from '@/modules/unified-inbox/lib/types'
import { channelLabel, formatFull, formatWhen, inboxHref, participantLabel } from '@/modules/unified-inbox/lib/list'
import { BackIcon, InboundIcon, OutboundIcon } from './icons'
import { PersonActions } from './PersonActions'
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

function buildTimeline(threads: ThreadListRow[], outbound: OutboundLogRow[]): TimelineItem[] {
  const items: TimelineItem[] = []
  for (const row of threads) {
    if (row.lastMessageAt) items.push({ kind: 'thread', at: row.lastMessageAt, row })
  }
  for (const row of outbound) items.push({ kind: 'sent', at: row.sentAt, row })
  return items.sort((a, b) => b.at.getTime() - a.at.getTime())
}

export function PersonView({
  adminPath, base, params, person, identities, threads, outbound, sections, links,
  events, merges, alsoHere, staffById, canEdit, canManage, now,
}: Props) {
  const timeline = buildTimeline(threads, outbound)
  const name = person.displayName || person.primaryEmail || 'Somebody'

  return (
    <div className="uin-thread">
      <div className="uin-thread-head">
        <a className="uin-chip uin-back" href={inboxHref(base, params, { person: null })} style={{ justifySelf: 'start' }}>
          {BackIcon} Back to the list
        </a>
        <h2 className="uin-thread-subject">{name}</h2>
        <div className="uin-thread-meta">
          {person.organisationName && <span>{person.organisationName}</span>}
          <span>
            {threads.length} conversation{threads.length === 1 ? '' : 's'}
          </span>
          <span>&middot; known since {formatFull(person.createdAt)}</span>
        </div>
        {canEdit && (
          <PersonActions
            personId={person.id}
            displayName={person.displayName}
            notes={person.notes}
            identities={identities.map((i) => ({ id: i.id, value: i.value, kind: i.kind }))}
            merges={merges.map((m) => ({ id: m.id, loserName: m.loserName }))}
            canManage={canManage}
          />
        )}
      </div>

      <div className="uin-thread-body">
        <div className="uin-person">
          <div className="uin-person-main">
            <section className="uin-ctx-block">
              <h3 className="uin-ctx-heading">How we reach them</h3>
              <ul className="uin-ctx-list">
                {identities.map((identity) => (
                  <li key={identity.id} className="uin-ctx-row">
                    <div className="uin-ctx-main">
                      <span>{identity.value}</span>
                      {identity.kind !== 'email' && <span className="uin-tag">{identity.kind}</span>}
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
                      <a href={inboxHref(base, params, { person: other.id })}>
                        {other.displayName || other.primaryEmail || 'somebody'}
                      </a>
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
                          <a href={inboxHref(base, params, { id: item.row.id, person: null })}>
                            {item.row.subject || '(no subject)'}
                          </a>
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
                <summary className="uin-chip" style={{ cursor: 'pointer' }}>What has been done to this record</summary>
                <ul style={{ listStyle: 'none', margin: '0.5rem 0 0', padding: 0, display: 'grid', gap: '0.25rem' }}>
                  {events.map((event) => (
                    <li key={event.id} style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
                      {(event.userId && staffById[event.userId]) || 'Somebody'}{' '}
                      {event.detail?.split ? 'split them apart' : event.detail?.undone ? 'undid a merge' : 'merged somebody in'}
                      {' - '}
                      {formatFull(event.createdAt)}
                    </li>
                  ))}
                </ul>
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
            canEditLinks={false}
          />
        </div>
      </div>
    </div>
  )
}
