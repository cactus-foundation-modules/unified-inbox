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
  links: RecordLink[]
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
}

export function ThreadContext({
  threadId, adminPath, sourceLabel, links, canEditLinks, linkKinds, defaultLinkKind,
}: Props) {
  // Nothing attached, nothing to say about where it came from, and nothing that
  // could be attached on a site that keeps no records anybody could attach.
  // Then there is no block, rather than a bordered strip with nothing in it.
  if (!sourceLabel && links.length === 0 && !(canEditLinks && linkKinds.length > 0)) return null

  return (
    <div className="uin-thread-ctx">
      <ContextRecords
        threadId={threadId}
        adminPath={adminPath}
        sourceLabel={sourceLabel}
        links={links}
        canEdit={canEditLinks}
        kinds={linkKinds}
        defaultKind={defaultLinkKind}
      />
    </div>
  )
}
