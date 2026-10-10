import Link from 'next/link'
import { QueryForm } from './QueryForm'
import { inboxHref, NEW_CONTACT, type ContactsView } from '@/modules/unified-inbox/lib/list'
import { AdminTooltip } from '@/components/admin/Tooltip'
import { ContactCategoryFilter } from './ContactCategoryFilter'
import { ImportIcon, PenIcon, SearchIcon, SortIcon } from './icons'

// The address book's own head: which half of it is being listed, a search across
// it, the labels it can be narrowed to and the order it is read in, and the ways of
// putting something into it.
//
// The same shape as the tab row over the conversations, and for the same
// reason: it is the same kind of choice one level down - what the list under it
// is a list of - and it has the same one column of width to do it in.
//
// Everything is a change of address rather than client state, so the view
// somebody is looking at can be sent to a colleague and the back button behaves.

type Props = {
  base: string
  params: Record<string, string>
  view: ContactsView
  search: string | null
  peopleCount: number
  organisationCount: number
  /** Whether this reader may add a contact. Reading the book and writing in it
   *  are different grants, and a button that ends in "you are not allowed" is
   *  worse than no button. */
  canEdit: boolean
  /** Whether this reader may bring a whole file in. Two thousand contacts in
   *  one press is a wider act than correcting one of them. */
  canImport: boolean
  /** The labels, in the order somebody put them in, with how many contacts are
   *  in each. Empty on a site that has never made one, where the row is not
   *  drawn at all rather than drawn empty. */
  categories: Array<{ id: string; name: string; people: number }>
  /** The ones being filtered on, if any. */
  categoryIds: string[]
  /** Which end of the list to start at: by date added, newest first unless
   *  this says otherwise. */
  oldestFirst: boolean
  /** Whether this head carries its own search box. Off on a search's own
   *  screen, where the same box is already drawn across the top of the whole
   *  thing: two search boxes an inch apart, one of which quietly asks a
   *  narrower question than the other, is worse than either on its own. The
   *  rest of the row - the labels, and the two ways of adding somebody - is not
   *  a search and stays. */
  showSearch: boolean
}

export function ContactsToolbar({
  base, params, view, search, peopleCount, organisationCount, canEdit, canImport,
  categories, categoryIds, oldestFirst, showSearch,
}: Props) {
  // Any change starts again at page one and closes whatever card was open - it
  // belongs to the list being left.
  const reset = { page: null, person: null, org: null, edit: null, import: null }

  const hidden = Object.fromEntries(
    Object.entries(params).filter(
      ([key, value]) => value && !['q', 'page', 'person', 'org', 'edit', 'import'].includes(key),
    ),
  )

  const half = (value: ContactsView, label: string, count: number) => (
    <Link
      key={value}
      className="uin-tab"
      href={inboxHref(base, params, { view: value === 'people' ? null : value, cat: null, ...reset })}
      aria-current={view === value ? 'true' : undefined}
    >
      {label}
      {count > 0 && (
        <span className="uin-tab-count">
          {count > 999 ? '999+' : count}
          <span className="sr-only"> {label.toLowerCase()}</span>
        </span>
      )}
    </Link>
  )

  // The labels are a filter on people, and only where there are any: a label
  // is something on a contact, and a button that narrows nothing is in the way.
  const showFilter = view === 'people' && categories.length > 0
  const withCategories = (ids: string[]) => ({ cat: ids.length > 0 ? ids.join(',') : null, ...reset })

  return (
    <>
      <div className="uin-search-row">
        {showSearch && (
          <QueryForm base={base} hidden={hidden} className="uin-search" applyWhenEmptied={search ? 'q' : undefined}>
            <label className="sr-only" htmlFor="uin-contact-search">Search the address book</label>
            <span className="uin-search-icon" aria-hidden="true">{SearchIcon}</span>
            <input
              id="uin-contact-search"
              name="q"
              type="search"
              defaultValue={search ?? ''}
              placeholder="Name, address, number or postcode"
            />
            <button type="submit" className="sr-only">Search</button>
          </QueryForm>
        )}
        {/* The import, a circle of its own to the left of the filter and the
            order: bringing a file in is an errand rather than a way of looking
            at the list, so it is not one of their pair. */}
        {canImport && view === 'people' && (
          <div className="uin-list-tools uin-list-tools-single" role="group" aria-label="Import">
            <AdminTooltip body="Import contacts from a file">
              <Link
                className="uin-icon-btn"
                href={inboxHref(base, params, { import: '1', person: null, org: null, edit: null })}
              >
                {ImportIcon}
                <span className="sr-only">Import contacts from a file</span>
              </Link>
            </AdminTooltip>
          </div>
        )}
        {/* Which labels to show, and which end of the list to read from - the
            same pair the conversation lists carry, with the same shape. */}
        <div className="uin-list-tools" role="group" aria-label="Filter and order">
          {showFilter && (
            <ContactCategoryFilter
              clearHref={inboxHref(base, params, withCategories([]))}
              choices={categories.map((category) => ({
                id: category.id,
                name: category.name,
                people: category.people,
                selected: categoryIds.includes(category.id),
                href: inboxHref(base, params, withCategories(
                  categoryIds.includes(category.id)
                    ? categoryIds.filter((id) => id !== category.id)
                    : [...categoryIds, category.id],
                )),
              }))}
            />
          )}
          <AdminTooltip body={oldestFirst ? 'Oldest added first. Press for newest added first.' : 'Newest added first. Press for oldest added first.'}>
            <Link
              className="uin-icon-btn"
              href={inboxHref(base, params, { sort: oldestFirst ? null : 'oldest', ...reset })}
              aria-pressed={oldestFirst}
            >
              {SortIcon}
              <span className="sr-only">
                {oldestFirst ? 'Showing oldest added first. Show newest added first.' : 'Showing newest added first. Show oldest added first.'}
              </span>
            </Link>
          </AdminTooltip>
        </div>
        {/* A new PERSON is started from the new-message menu's Contact entry,
            wherever somebody happens to be standing. Organisations have no
            such entry, so theirs stays here. */}
        {canEdit && view === 'organisations' && (
          <Link
            className="uin-compose"
            href={inboxHref(base, params, { org: NEW_CONTACT, person: null, import: null, edit: null })}
          >
            {PenIcon}
            <span className="uin-compose-words">New organisation</span>
          </Link>
        )}
      </div>

      <div className="uin-tabs" role="group" aria-label="Which half of the address book">
        {half('people', 'People', peopleCount)}
        {half('organisations', 'Organisations', organisationCount)}
      </div>
    </>
  )
}
