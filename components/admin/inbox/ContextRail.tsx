import Link from 'next/link'
import type { ContextSection } from '@/modules/unified-inbox/lib/adapters'
import type { RecordLink } from '@/modules/unified-inbox/lib/types'
import { recordHref, recordLabel } from '@/modules/unified-inbox/lib/record-links'
import { LinkActions } from './LinkActions'

// What the rest of the site knows about the person on the other end of the
// conversation, beside the conversation.
//
// Every block comes from an adapter that reads another module and writes to
// none of them, and a module that is not installed contributes nothing and
// costs one cheap check. So this component knows nothing about shops, purchase
// orders or bookkeeping: it draws whatever sections it is handed, in the order
// it is handed them, which is what lets a later stage add a source without
// touching the screen.
//
// Who the conversation is with, and which records are its context, are NOT
// here: beside a conversation they are two lines in the conversation's own
// pinned header (see ThreadContext), because this panel sits under the messages
// on anything narrower than a very wide window. What is left here is the rest
// of the site's answer about that person, which is worth scrolling to.

type Props = {
  /** The admin root, so an adapter's relative href becomes a real address. */
  adminPath: string
  /** The conversation this rail sits beside, when it sits beside one. */
  threadId: string | null
  sections: ContextSection[]
  /** Records that are context for the PERSON. Beside a conversation this is
   *  empty and the block is not drawn - a conversation's own are in its header. */
  links: RecordLink[]
  canEditLinks: boolean
}

function LinkedRecord({
  link, adminPath, canEdit,
}: { link: RecordLink; adminPath: string; canEdit: boolean }) {
  const href = recordHref(link)
  const label = recordLabel(link)
  return (
    <li className="uin-ctx-row">
      <div className="uin-ctx-main">
        {href ? (
          // New tab, same as the line in a conversation's header: following an
          // order from somebody's page is reading the order as well as the
          // page, not instead of it.
          <Link href={`/${adminPath}/${href}`} target="_blank" rel="noreferrer">{label}</Link>
        ) : (
          <span>{label}</span>
        )}
        {link.linkedBy === 'auto' && (
          <span className="uin-tag" title="We spotted this reference in the message. Take it off if it is wrong.">
            Found automatically
          </span>
        )}
      </div>
      {canEdit && <LinkActions linkId={link.id} label={label} onThread={false} />}
    </li>
  )
}

export function ContextRail({
  adminPath, threadId, sections, links, canEditLinks,
}: Props) {
  // The block still stands on a person's page with nothing in it, because
  // "no context yet" is an answer somebody came looking for. Beside a
  // conversation it is not drawn at all: that list is in the header.
  const showContext = !threadId && (links.length > 0 || canEditLinks)

  return (
    <aside className="uin-ctx" aria-label={threadId ? 'About this conversation' : 'About this person'}>
      {showContext && (
        <section className="uin-ctx-block">
          <h3 className="uin-ctx-heading">Context</h3>
          {links.length > 0 ? (
            <ul className="uin-ctx-list">
              {links.map((link) => (
                <LinkedRecord
                  key={link.id}
                  link={link}
                  adminPath={adminPath}
                  canEdit={canEditLinks}
                />
              ))}
            </ul>
          ) : (
            <p className="uin-ctx-sub">No context yet.</p>
          )}
        </section>
      )}

      {sections.map((section) => (
        <section key={section.moduleName} className="uin-ctx-block">
          <h3 className="uin-ctx-heading">{section.label}</h3>
          <ul className="uin-ctx-list">
            {section.items.map((item) => (
              <li key={item.id} className="uin-ctx-row">
                <div className="uin-ctx-main">
                  <Link href={`/${adminPath}/${item.href}`}>{item.title}</Link>
                  {item.status && <span className="uin-tag">{item.status}</span>}
                </div>
                {item.detail && <span className="uin-ctx-sub">{item.detail}</span>}
              </li>
            ))}
          </ul>
          {section.moreHref && section.total > section.items.length && (
            <p className="uin-ctx-sub">
              <Link href={`/${adminPath}/${section.moreHref}`}>
                See all {section.total}
              </Link>
            </p>
          )}
        </section>
      ))}
    </aside>
  )
}
