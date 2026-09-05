import Link from 'next/link'
import { inboxHref, initialsFor, pageCount, PER_PAGE } from '@/modules/unified-inbox/lib/list'
import type { PersonListRow } from '@/modules/unified-inbox/lib/db'

// The people half of the address book.
//
// A row says the four things somebody scans a contacts list for - who they are,
// what they do, where they work and how to ring them - and nothing else. What
// they have written to us about is one press away on their own page, which is
// where it belongs: a list that tries to be a summary of every conversation is
// a list nobody can read across.
//
// Server-rendered from the query string like every other list here, so a search
// can be sent to a colleague and the back button behaves.

type Props = {
  base: string
  params: Record<string, string>
  rows: PersonListRow[]
  /** The labels on each of them, by person id, fetched once for the page. */
  categories: Record<string, string[]>
  total: number
  page: number
  openPersonId: string | null
  searching: boolean
  /** Whether this reader may add one, so the empty state can offer it. */
  canEdit: boolean
}

function nameOf(row: PersonListRow): string {
  return row.displayName || row.primaryEmail || row.phone || 'Somebody'
}

export function ContactsListView({
  base, params, rows, categories, total, page, openPersonId, searching, canEdit,
}: Props) {
  const pages = pageCount(total, PER_PAGE)

  if (rows.length === 0) {
    return (
      <div className="uin-empty">
        <strong>{searching ? 'Nobody matches that' : 'No contacts yet'}</strong>
        {searching
          ? 'Try a shorter search - a surname, part of an address, or the first half of a postcode.'
          : canEdit
            ? 'Everybody who writes in turns up here on their own. You can also add one yourself, or bring a whole address book in from a file.'
            : 'Everybody who writes in turns up here on their own.'}
      </div>
    )
  }

  return (
    <>
      <ul className="uin-list">
        {rows.map((row) => {
          const name = nameOf(row)
          const labels = categories[row.id] ?? []
          const open = openPersonId === row.id
          return (
            <li key={row.id} className="uin-list-item" data-selected={open ? 'true' : undefined}>
              <Link
                className="uin-row"
                aria-current={open ? 'true' : undefined}
                href={inboxHref(base, params, { person: row.id, org: null, edit: null, import: null })}
              >
                <span className="uin-avatar-wrap">
                  <span className="uin-avatar" aria-hidden="true">{initialsFor(name)}</span>
                </span>
                <span className="uin-row-main">
                  <span className="uin-row-who">
                    <span className="uin-row-name">{name}</span>
                  </span>
                  <span className="uin-row-subject">
                    {[row.jobTitle, row.organisationName].filter(Boolean).join(' · ') || 'No job title yet'}
                  </span>
                  {/* Nothing rather than an empty line: a blank third line left
                      a gap under every contact that has one. */}
                  {(row.primaryEmail || row.phone || row.addressPostcode) && (
                    <span className="uin-row-preview">
                      {[row.primaryEmail, row.phone, row.addressPostcode].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </span>
                <span className="uin-row-meta">
                  <span className="uin-row-tags">
                    {labels.map((label) => (
                      <span className="uin-tag" key={label}>
                        <span className="uin-tag-text">{label}</span>
                      </span>
                    ))}
                    {row.threadCount > 0 && (
                      <span className="uin-tag">
                        <span className="uin-tag-text">
                          {row.threadCount === 1 ? '1 conversation' : `${row.threadCount} conversations`}
                        </span>
                      </span>
                    )}
                  </span>
                </span>
              </Link>
            </li>
          )
        })}
      </ul>

      {pages > 1 && (
        <div className="uin-pager">
          {page > 1 ? (
            <Link className="btn btn-secondary btn-sm" href={inboxHref(base, params, { page: String(page - 1), person: null })}>
              Back
            </Link>
          ) : <span />}
          <span>Page {page} of {pages}</span>
          {page < pages ? (
            <Link className="btn btn-secondary btn-sm" href={inboxHref(base, params, { page: String(page + 1), person: null })}>
              On
            </Link>
          ) : <span />}
        </div>
      )}
    </>
  )
}
