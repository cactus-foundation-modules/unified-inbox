import { inboxHref } from '@/modules/unified-inbox/lib/list'
import { PenIcon } from './icons'
import { RailInboxes } from './RailInboxes'

// The rail: the addresses people write to, then everything at once (D1 - the
// All view exists, but it is not where the screen opens). Unread counts sit
// beside each one, because "is there anything new in accounts@" is the question
// this rail is answering.
//
// Drafts sits directly under All and is not an address at all: it is one
// person's own half-written messages across every address they can write from,
// which is where a mail program has put them for thirty years and therefore the
// first place somebody looks.

export type RailInbox = { id: string; name: string; address: string }

/** A channel another module owns - live chat, the contact form, the phone.
 *  Keyed by that module's name, which is also how its conversations are marked. */
export type RailChannel = { moduleName: string; label: string }

type Props = {
  base: string
  params: Record<string, string>
  inboxes: RailInbox[]
  channels: RailChannel[]
  counts: Record<string, number>
  currentInboxId: string | null
  /** Whether this person can see conversations that landed in no inbox. */
  showUnrouted: boolean
  /** Whether the Drafts entry is worth showing: somebody who can write from
   *  nowhere and has nothing put down half-written has no use for it. */
  showDrafts: boolean
  /** How many of this person's own drafts are waiting. Nobody else's are
   *  counted, because nobody else's are theirs to finish. */
  draftCount: number
  /** Where "Write a message" goes, or null when there is no address this person
   *  may send from - in which case the button is not there at all, rather than
   *  there and disappointing. */
  composeHref: string | null
  /** Whether this person may drag the addresses into a different order. The
   *  order is the site's rather than one person's, so it takes `manage` - and
   *  anybody who holds that sees every inbox, which is what makes it safe to
   *  save the rail as the complete list. */
  canReorder: boolean
}

function Count({ value, word = 'unread' }: { value: number; word?: string }) {
  if (!value) return null
  return (
    <span className="uin-rail-count">
      {value > 99 ? '99+' : value}
      <span className="sr-only"> {word}</span>
    </span>
  )
}

export function InboxRail({
  base, params, inboxes, channels, counts, currentInboxId, showUnrouted, showDrafts,
  draftCount, composeHref, canReorder,
}: Props) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  // Changing inbox always goes back to page one and drops whichever conversation
  // was open - it belongs to the inbox being left.
  const link = (inbox: string | null) =>
    inboxHref(base, params, { inbox, page: null, id: null })

  return (
    <div className="uin-railpane">
      {composeHref && (
        <a className="uin-compose" href={composeHref}>
          {PenIcon} Write a message
        </a>
      )}
      <nav className="uin-rail" aria-label="Inboxes">
        <div className="uin-rail-heading">Inboxes</div>
        <RailInboxes
          items={inboxes.map((inbox) => ({
            id: inbox.id,
            name: inbox.name,
            address: inbox.address,
            href: link(inbox.id),
            count: counts[inbox.id] ?? 0,
          }))}
          currentInboxId={currentInboxId}
          canReorder={canReorder}
        />
        <a
          href={link(null)}
          aria-current={currentInboxId === null ? 'page' : undefined}
        >
          <span className="uin-rail-name">All</span>
          <Count value={total} />
        </a>
        {showDrafts && (
          <a
            href={link('drafts')}
            aria-current={currentInboxId === 'drafts' ? 'page' : undefined}
            title="Messages you have started and not sent"
          >
            <span className="uin-rail-name">Drafts</span>
            <Count value={draftCount} word="saved" />
          </a>
        )}
        {showUnrouted && (
          <a href={inboxHref(base, params, { inbox: 'none', page: null, id: null })}
             aria-current={currentInboxId === 'none' ? 'page' : undefined}
             title="Mail that reached the account but matched none of your addresses">
            <span className="uin-rail-name">Not filed</span>
            <Count value={counts[''] ?? 0} />
          </a>
        )}

        {channels.length > 0 && (
          <>
            <div className="uin-rail-heading">Other channels</div>
            {channels.map((channel) => (
              <a
                key={channel.moduleName}
                href={link(`m:${channel.moduleName}`)}
                aria-current={currentInboxId === `m:${channel.moduleName}` ? 'page' : undefined}
              >
                <span className="uin-rail-name">{channel.label}</span>
                <Count value={counts[`m:${channel.moduleName}`] ?? 0} />
              </a>
            ))}
          </>
        )}
      </nav>
    </div>
  )
}
