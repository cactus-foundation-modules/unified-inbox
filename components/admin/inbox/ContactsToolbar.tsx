import Link from 'next/link'
import { TabStrip } from '@/components/admin/TabStrip'
import { QueryForm } from './QueryForm'
import { inboxHref, NEW_CONTACT, type ContactsView } from '@/modules/unified-inbox/lib/list'
import { PenIcon, SearchIcon } from './icons'

// The address book's own row: which half of it is being listed, a search across
// it, and the two ways of putting something into it.
//
// The same shape as the status row over the conversations, and for the same
// reason: it is the same kind of choice one level down - what the list on the
// left is a list of - and the admin already stacks tabs this way where one
// choice sits inside another.
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
  /** The one being filtered on, if any. */
  categoryId: string | null
}

export function ContactsToolbar({
  base, params, view, search, peopleCount, organisationCount, canEdit, canImport,
  categories, categoryId,
}: Props) {
  // Any change starts again at page one and closes whatever card was open - it
  // belongs to the list being left.
  const reset = { page: null, person: null, org: null, edit: null, import: null }

  const hidden = Object.fromEntries(
    Object.entries(params).filter(
      ([key, value]) => value && !['q', 'page', 'person', 'org', 'edit', 'import'].includes(key),
    ),
  )

  const tab = (value: ContactsView, label: string, count: number) => ({
    key: value,
    active: view === value,
    href: inboxHref(base, params, { view: value === 'people' ? null : value, cat: null, ...reset }),
    label: (
      <span className="uin-tab">
        <span className="uin-tab-name">{label}</span>
        {count > 0 && (
          <span className="uin-tab-count uin-tab-count-quiet">
            {count > 999 ? '999+' : count}
            <span className="sr-only"> {label.toLowerCase()}</span>
          </span>
        )}
      </span>
    ),
  })

  // Only over the people, and only where there are any: a label is something on
  // a contact, and a row of filters that narrows nothing is a row in the way.
  const showCategories = view === 'people' && categories.length > 0

  return (
    <>
    <TabStrip
      style={{ marginBottom: '0.75rem' }}
      items={[
        tab('people', 'People', peopleCount),
        tab('organisations', 'Organisations', organisationCount),
      ]}
      trailing={
        <div className="uin-search-row">
          <QueryForm base={base} hidden={hidden} className="uin-search">
            <label className="sr-only" htmlFor="uin-contact-search">Search the address book</label>
            <input
              id="uin-contact-search"
              name="q"
              type="search"
              defaultValue={search ?? ''}
              placeholder="Name, address, number or postcode"
            />
            <button type="submit" className="btn btn-secondary btn-sm" aria-label="Search">
              {SearchIcon}
            </button>
          </QueryForm>
          {canImport && view === 'people' && (
            <Link
              className="btn btn-secondary btn-sm"
              href={inboxHref(base, params, { import: '1', person: null, org: null, edit: null })}
            >
              Import a file
            </Link>
          )}
          {canEdit && (
            <Link
              className="uin-compose"
              href={view === 'organisations'
                ? inboxHref(base, params, { org: NEW_CONTACT, person: null, import: null, edit: null })
                : inboxHref(base, params, { person: NEW_CONTACT, org: null, import: null, edit: null })}
            >
              {PenIcon}
              <span className="uin-compose-words">
                {view === 'organisations' ? 'New organisation' : 'New contact'}
              </span>
            </Link>
          )}
        </div>
      }
    />

    {showCategories && (
      <div className="uin-toolbar">
        <Link
          className="uin-chip"
          aria-current={categoryId ? undefined : 'true'}
          href={inboxHref(base, params, { cat: null, ...reset })}
        >
          Everybody
        </Link>
        {categories.map((category) => (
          <Link
            key={category.id}
            className="uin-chip"
            aria-current={categoryId === category.id ? 'true' : undefined}
            href={inboxHref(base, params, {
              // Pressing the one already on takes the filter off, which is what
              // pressing a pressed thing should do.
              cat: categoryId === category.id ? null : category.id,
              ...reset,
            })}
          >
            {category.name}
            {category.people > 0 && (
              <span className="uin-tab-count uin-tab-count-quiet">
                {category.people > 999 ? '999+' : category.people}
                <span className="sr-only"> contacts</span>
              </span>
            )}
          </Link>
        ))}
      </div>
    )}
    </>
  )
}
