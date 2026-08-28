import { inboxHref } from '@/modules/unified-inbox/lib/list'

// The rail: the addresses people write to, then everything at once (D1 - the
// All view exists, but it is not where the screen opens). Unread counts sit
// beside each one, because "is there anything new in accounts@" is the question
// this rail is answering.

export type RailInbox = { id: string; name: string; address: string }

type Props = {
  base: string
  params: Record<string, string>
  inboxes: RailInbox[]
  counts: Record<string, number>
  currentInboxId: string | null
  /** Whether this person can see conversations that landed in no inbox. */
  showUnrouted: boolean
}

function Count({ value }: { value: number }) {
  if (!value) return null
  return (
    <span className="uin-rail-count">
      {value > 99 ? '99+' : value}
      <span className="sr-only"> unread</span>
    </span>
  )
}

export function InboxRail({ base, params, inboxes, counts, currentInboxId, showUnrouted }: Props) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  // Changing inbox always goes back to page one and drops whichever conversation
  // was open - it belongs to the inbox being left.
  const link = (inbox: string | null) =>
    inboxHref(base, params, { inbox, page: null, id: null })

  return (
    <nav className="uin-rail" aria-label="Inboxes">
      <div className="uin-rail-heading">Inboxes</div>
      {inboxes.map((inbox) => (
        <a
          key={inbox.id}
          href={link(inbox.id)}
          aria-current={currentInboxId === inbox.id ? 'page' : undefined}
          title={inbox.address}
        >
          <span className="uin-rail-name">{inbox.name}</span>
          <Count value={counts[inbox.id] ?? 0} />
        </a>
      ))}
      <a
        href={link(null)}
        aria-current={currentInboxId === null ? 'page' : undefined}
      >
        <span className="uin-rail-name">All</span>
        <Count value={total} />
      </a>
      {showUnrouted && (
        <a href={inboxHref(base, params, { inbox: 'none', page: null, id: null })}
           aria-current={currentInboxId === 'none' ? 'page' : undefined}
           title="Mail that reached the account but matched none of your addresses">
          <span className="uin-rail-name">Not filed</span>
          <Count value={counts[''] ?? 0} />
        </a>
      )}
    </nav>
  )
}
