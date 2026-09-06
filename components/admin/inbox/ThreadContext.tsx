import Link from 'next/link'
import type { LinkKind } from '@/modules/unified-inbox/lib/linking'
import type { Person, RecordLink } from '@/modules/unified-inbox/lib/types'
import { inboxHref } from '@/modules/unified-inbox/lib/list'
import type { LinkKindChoice } from './LinkActions'
import { AttachedRecords } from './AttachedRecords'

// Who the conversation is with, and what it is about - directly under the
// buttons, where the conversation's own header is.
//
// It used to be the first block of the panel beside the messages, which on any
// window narrower than 1500px is a panel UNDER the messages: the answer to
// "who am I talking to" sat four thousand pixels of quoted email below the
// question. Two lines in the header cost nothing and are always on the screen,
// because the header is pinned.

export type ThreadContextView = {
  /** The admin root, so a stored link becomes a real address. */
  adminPath: string
  /** Who the conversation is with, when the site knows. */
  person: Person | null
  /** Why there is nobody, when there is nobody. */
  noPersonReason: string | null
  links: RecordLink[]
  canEditLinks: boolean
  /** What may be attached here at all: the record kinds whose module is
   *  installed and whose records this viewer may see. */
  linkKinds: LinkKindChoice[]
  /** Which of them the picker opens on, decided from what the inbox is used
   *  for. */
  defaultLinkKind: LinkKind | null
}

type Props = ThreadContextView & {
  threadId: string
  base: string
  params: Record<string, string>
}

export function ThreadContext({
  threadId, base, params, adminPath, person, noPersonReason, links, canEditLinks,
  linkKinds, defaultLinkKind,
}: Props) {
  const attached = (
    <AttachedRecords
      threadId={threadId}
      adminPath={adminPath}
      links={links}
      canEdit={canEditLinks}
      kinds={linkKinds}
      defaultKind={defaultLinkKind}
    />
  )
  const who = person
    ? (
      <p className="uin-thread-who">
        <Link href={inboxHref(base, params, { person: person.id, id: null })}>
          {person.displayName || person.primaryEmail || 'Somebody'}
        </Link>
        {person.organisationName && (
          <span className="uin-thread-org">{person.organisationName}</span>
        )}
      </p>
    )
    : noPersonReason
      ? <p className="uin-thread-who uin-thread-who-none">{noPersonReason}</p>
      : null

  // Both halves can be nothing at once - a channel that never had a person on
  // it, on a site that keeps no records anybody could attach. Then there is no
  // block, rather than a bordered strip with nothing in it.
  if (!who && links.length === 0 && !(canEditLinks && linkKinds.length > 0)) return null

  return (
    <div className="uin-thread-ctx">
      {who}
      {attached}
    </div>
  )
}
