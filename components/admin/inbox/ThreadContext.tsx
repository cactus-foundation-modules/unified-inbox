import type { ContextHint } from '@/modules/unified-inbox/lib/adapters/types'
import type { LinkKind } from '@/modules/unified-inbox/lib/linking'
import type { RecordLink } from '@/modules/unified-inbox/lib/types'
import type { LinkKindChoice } from './LinkActions'
import { ContextRecords } from './ContextRecords'

// What the conversation is about - the records that give it context - directly
// under the buttons, where the conversation's own header is.
//
// It used to be the first block of the panel beside the messages, which on any
// window narrower than 1500px is a panel UNDER the messages: the answer to
// "what is this about" sat four thousand pixels of quoted email below the
// question. One line in the header costs nothing and is always on the screen,
// because the header is pinned.
//
// Who the conversation is WITH is no longer said here. Every message in it
// carries the sender's name and their organisation, the list beside it says the
// same again on the row, and a third copy pinned over the top of both was a
// line of header saying what the screen already said twice.

export type ThreadContextView = {
  /** The admin root, so a stored link becomes a real address. */
  adminPath: string
  /** What on the site the conversation came from, when its channel says so -
   *  the name of the form it was typed into, say. It sits with the attached
   *  records because it answers the same question they do, and it is NOT one of
   *  them: nobody attached it, it does not open anything, and it cannot be
   *  taken off, because taking it off would be claiming the enquiry came from
   *  somewhere else. */
  sourceLabel: string | null
  /** What the rest of the site already knows about whoever is writing -
   *  "Existing customer" and nothing longer. Not records: nobody attached them
   *  and nobody can take them off, and an adapter drops its own the moment a
   *  record that answers the same question properly is attached. */
  hints: ContextHint[]
  links: RecordLink[]
  /** Where the attached records that have a public page open, keyed by link id.
   *  A product goes to the shop's own page; everything else opens in the admin,
   *  which is the only place it exists. */
  publicUrls: Record<string, string>
  canEditLinks: boolean
  /** What may be added here at all: the record kinds whose module is
   *  installed and whose records this viewer may see. */
  linkKinds: LinkKindChoice[]
  /** Which of them the picker opens on, decided from what the inbox is used
   *  for. */
  defaultLinkKind: LinkKind | null
}

type Props = ThreadContextView & {
  threadId: string
  /** Just the arrow, for the line in the header that carries it when there is
   *  nothing to list. See hasThreadContext below. */
  compact?: boolean
}

/** Whether there is anything to put on a line: something attached, or somewhere
 *  it came from. Exported because the header has to know BEFORE it draws the
 *  meta line whether the arrow belongs on the end of it or under it, and
 *  answering that question twice in two files is how the two get it different. */
export function hasThreadContext(view: ThreadContextView): boolean {
  return !!view.sourceLabel || view.hints.length > 0 || view.links.length > 0
}

export function ThreadContext({
  threadId, adminPath, sourceLabel, hints, links, publicUrls, canEditLinks, linkKinds,
  defaultLinkKind, compact = false,
}: Props) {
  // Nothing attached, nothing to say about where it came from, and nothing that
  // could be attached on a site that keeps no records anybody could attach.
  // Then there is no block, rather than a bordered strip with nothing in it.
  if (!sourceLabel && hints.length === 0 && links.length === 0
    && !(canEditLinks && linkKinds.length > 0)) return null

  const records = (
    <ContextRecords
      threadId={threadId}
      adminPath={adminPath}
      sourceLabel={sourceLabel}
      hints={hints}
      links={links}
      publicUrls={publicUrls}
      canEdit={canEditLinks}
      kinds={linkKinds}
      defaultKind={defaultLinkKind}
      compact={compact}
    />
  )

  // Compact, it is drawn INTO a line the header already has, so it gets no
  // block of its own - a strip round a single arrow is the strip this was
  // supposed to save.
  if (compact) return records

  return <div className="uin-thread-ctx">{records}</div>
}
