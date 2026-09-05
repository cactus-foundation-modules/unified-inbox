import Link from 'next/link'
import { inboxHref, initialsFor, pageCount, PER_PAGE } from '@/modules/unified-inbox/lib/list'
import type { OrganisationListRow } from '@/modules/unified-inbox/lib/db'

// The companies half of the address book.
//
// Most of these arrived on their own, off the domain a supplier writes from, so
// the count of people in each one is the useful column: it is what makes "Acme
// Ltd" with fourteen contacts and "Acme Limited" with one visible enough to be
// tidied up.

type Props = {
  base: string
  params: Record<string, string>
  rows: OrganisationListRow[]
  total: number
  page: number
  openOrganisationId: string | null
  searching: boolean
  canEdit: boolean
}

export function OrganisationsListView({
  base, params, rows, total, page, openOrganisationId, searching, canEdit,
}: Props) {
  const pages = pageCount(total, PER_PAGE)

  if (rows.length === 0) {
    return (
      <div className="uin-empty">
        <strong>{searching ? 'No organisation matches that' : 'No organisations yet'}</strong>
        {searching
          ? 'Try the first word of the name, or part of the postcode.'
          : canEdit
            ? 'One appears for each company that writes in from its own domain. You can also add one yourself - the haulier who only ever telephones has no mail domain to be found by.'
            : 'One appears for each company that writes in from its own domain.'}
      </div>
    )
  }

  return (
    <>
      <ul className="uin-list">
        {rows.map((row) => {
          const open = openOrganisationId === row.id
          return (
            <li key={row.id} className="uin-list-item" data-selected={open ? 'true' : undefined}>
              <Link
                className="uin-row"
                aria-current={open ? 'true' : undefined}
                href={inboxHref(base, params, { org: row.id, person: null, edit: null, import: null })}
              >
                <span className="uin-avatar-wrap">
                  <span className="uin-avatar" aria-hidden="true">{initialsFor(row.name)}</span>
                </span>
                <span className="uin-row-main">
                  <span className="uin-row-who">
                    <span className="uin-row-name">{row.name}</span>
                  </span>
                  <span className="uin-row-subject">{row.domain || row.website || row.email || 'No details yet'}</span>
                  {(row.phone || row.addressCity || row.addressPostcode) && (
                    <span className="uin-row-preview">
                      {[row.phone, row.addressCity, row.addressPostcode].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </span>
                <span className="uin-row-meta">
                  <span className="uin-row-tags">
                    {row.peopleCount > 0 && (
                      <span className="uin-tag">
                        <span className="uin-tag-text">
                          {row.peopleCount === 1 ? '1 contact' : `${row.peopleCount} contacts`}
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
            <Link className="btn btn-secondary btn-sm" href={inboxHref(base, params, { page: String(page - 1), org: null })}>
              Back
            </Link>
          ) : <span />}
          <span>Page {page} of {pages}</span>
          {page < pages ? (
            <Link className="btn btn-secondary btn-sm" href={inboxHref(base, params, { page: String(page + 1), org: null })}>
              On
            </Link>
          ) : <span />}
        </div>
      )}
    </>
  )
}
