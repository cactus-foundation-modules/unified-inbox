import type { ContextSection } from '@/modules/unified-inbox/lib/adapters'
import type { Person, RecordLink } from '@/modules/unified-inbox/lib/types'
import { inboxHref } from '@/modules/unified-inbox/lib/list'
import { AddLink, LinkActions } from './LinkActions'

// What the rest of the site knows about the person on the other end of the
// conversation, beside the conversation.
//
// Every block comes from an adapter that reads another module and writes to
// none of them, and a module that is not installed contributes nothing and
// costs one cheap check. So this component knows nothing about shops, purchase
// orders or bookkeeping: it draws whatever sections it is handed, in the order
// it is handed them, which is what lets a later stage add a source without
// touching the screen.

type Props = {
  /** The admin root, so an adapter's relative href becomes a real address. */
  adminPath: string
  /** The conversation this rail sits beside, when it sits beside one. */
  threadId: string | null
  base: string
  params: Record<string, string>
  person: Person | null
  /** Why there is nobody, when there is nobody. */
  noPersonReason: string | null
  sections: ContextSection[]
  links: RecordLink[]
  canEditLinks: boolean
}

function LinkedRecord({
  link, adminPath, canEdit,
}: { link: RecordLink; adminPath: string; canEdit: boolean }) {
  const href = linkHref(link)
  return (
    <li className="uin-ctx-row">
      <div className="uin-ctx-main">
        {href ? (
          <a href={`/${adminPath}/${href}`}>{link.label || link.recordType}</a>
        ) : (
          <span>{link.label || link.recordType}</span>
        )}
        {link.linkedBy === 'auto' && (
          <span className="uin-tag" title="We spotted this reference in the message. Take it off if it is wrong.">
            Found automatically
          </span>
        )}
      </div>
      {canEdit && <LinkActions linkId={link.id} label={link.label || link.recordType} />}
    </li>
  )
}

/** Where a stored link points. The href is not stored - it is rebuilt from what
 *  the link holds, so a module that changes its own page addresses does not
 *  leave every conversation on the site pointing at a page that has moved. */
function linkHref(link: RecordLink): string | null {
  if (link.moduleName === 'shop' && link.recordType === 'order') return `shop/orders/${link.recordId}`
  if (link.moduleName === 'purchase-orders' && link.recordType === 'purchase-order') {
    return `purchase-orders/orders/${link.recordId}`
  }
  if (link.moduleName === 'quote-for-shop' && link.recordType === 'quote') {
    return `quote-for-shop/quotes/${link.recordId}`
  }
  return null
}

export function ContextRail({
  adminPath, threadId, base, params, person, noPersonReason, sections, links, canEditLinks,
}: Props) {
  const nothing = !person && sections.length === 0 && links.length === 0

  return (
    <aside className="uin-ctx" aria-label="About this conversation">
      {person ? (
        <section className="uin-ctx-block">
          <h3 className="uin-ctx-heading">Who this is</h3>
          <p className="uin-ctx-name">
            <a href={inboxHref(base, params, { person: person.id, id: null })}>
              {person.displayName || person.primaryEmail || 'Somebody'}
            </a>
          </p>
          {person.primaryEmail && person.displayName && (
            <p className="uin-ctx-sub">{person.primaryEmail}</p>
          )}
          {person.organisationName && <p className="uin-ctx-sub">{person.organisationName}</p>}
        </section>
      ) : (
        noPersonReason && (
          <section className="uin-ctx-block">
            <h3 className="uin-ctx-heading">Who this is</h3>
            <p className="uin-ctx-sub">{noPersonReason}</p>
          </section>
        )
      )}

      {(links.length > 0 || canEditLinks) && (
        <section className="uin-ctx-block">
          <h3 className="uin-ctx-heading">
            {threadId ? 'Attached to this conversation' : 'Attached to them'}
          </h3>
          {links.length > 0 ? (
            <ul className="uin-ctx-list">
              {links.map((link) => (
                <LinkedRecord key={link.id} link={link} adminPath={adminPath} canEdit={canEditLinks} />
              ))}
            </ul>
          ) : (
            <p className="uin-ctx-sub">Nothing attached yet.</p>
          )}
          {canEditLinks && threadId && <AddLink threadId={threadId} />}
        </section>
      )}

      {sections.map((section) => (
        <section key={section.moduleName} className="uin-ctx-block">
          <h3 className="uin-ctx-heading">{section.label}</h3>
          <ul className="uin-ctx-list">
            {section.items.map((item) => (
              <li key={item.id} className="uin-ctx-row">
                <div className="uin-ctx-main">
                  <a href={`/${adminPath}/${item.href}`}>{item.title}</a>
                  {item.status && <span className="uin-tag">{item.status}</span>}
                </div>
                {item.detail && <span className="uin-ctx-sub">{item.detail}</span>}
              </li>
            ))}
          </ul>
          {section.moreHref && section.total > section.items.length && (
            <p className="uin-ctx-sub">
              <a href={`/${adminPath}/${section.moreHref}`}>
                See all {section.total}
              </a>
            </p>
          )}
        </section>
      ))}

      {nothing && (
        <section className="uin-ctx-block">
          <p className="uin-ctx-sub">
            Nothing else on the site mentions this person yet. Anything they order, ask for a
            quote on or get billed for will show up here.
          </p>
        </section>
      )}
    </aside>
  )
}
