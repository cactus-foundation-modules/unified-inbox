'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { inboxHref } from '@/modules/unified-inbox/lib/list'
import { Dropdown, MenuItem, useDropdownClose } from './Dropdown'
import {
  AssignedIcon, ChevronLeftIcon, ChevronRightIcon, FilterIcon, MailIcon, SearchIcon, TickIcon,
} from './icons'

// The narrower cuts, behind one button.
//
// They used to be laid out along a strip under the search box: an Unread chip,
// a menu of names, and a Filter button that had to be pressed afterwards to
// make the menu mean anything. Three controls, permanently taking a row off the
// top of a list that is the whole point of the column, to hold two questions
// most people ask once a week. Worse, the names menu did nothing until the
// button beside it was pressed, which is the one thing a menu is not supposed
// to need.
//
// Now: one button beside the sort control, a tick against Unread, and the names
// on a panel of their own with a box to find one in - the shape every mail
// program uses for exactly this, and the shape somebody arriving already knows.
//
// Which filters are actually on is NOT left to this button to say. Whatever is
// set gets a chip under the tabs (see Filters), because a filter nobody can see
// is a filter somebody is stuck with, and a filter hidden behind a button they
// have to open to check is very nearly the same thing.

type Person = { id: string; name: string }

type Props = {
  base: string
  params: Record<string, string>
  unreadOnly: boolean
  assignee: string | null
  staff: Person[]
}

/** Below this many colleagues the list is quicker to read than to search, and a
 *  box asking you to type is a box in the way. */
const SEARCH_FROM = 7

export function FilterMenu(props: Props) {
  const anyOn = props.unreadOnly || props.assignee !== null

  // The panel is a component rather than markup, so it forgets which half of
  // itself was showing the moment it closes: shutting it on the names and
  // opening it again should land back on the two choices, not halfway into one
  // of them.
  return (
    <Dropdown
      className={anyOn ? 'uin-icon-btn uin-icon-btn-on' : 'uin-icon-btn'}
      label={FilterIcon}
      ariaLabel={anyOn ? 'Filter the list. Some filters are on.' : 'Filter the list'}
      title="Filter"
      align="end"
      width={250}
    >
      <FilterPanel {...props} />
    </Dropdown>
  )
}

function FilterPanel({ base, params, unreadOnly, assignee, staff }: Props) {
  const router = useRouter()
  // The panel is shut from inside it rather than handed a callback: see
  // Dropdown, which cannot pass one without reading a ref mid-render.
  const close = useDropdownClose()
  const [names, setNames] = useState(false)
  const [find, setFind] = useState('')
  const back = useRef<HTMLButtonElement>(null)

  // Walking into the names takes the entry that was under the pointer off the
  // page with it, and focus with nowhere left to go falls back to the document,
  // which takes the arrow keys with it. So it is put somewhere: the box to type
  // in where there is one, the first name where there is not.
  useEffect(() => {
    if (!names) return
    const panel = back.current?.closest('.uin-menu')
    const landing = panel?.querySelector<HTMLElement>('input')
      ?? panel?.querySelector<HTMLElement>('[data-menu-item]')
    landing?.focus()
  }, [names])

  // Any filter change starts again at page one and closes whatever was open,
  // since the conversation on screen may not survive the new filter. A person's
  // page goes with it, for the same reason and because it was pinned open
  // beside a list that had changed underneath it.
  const go = (changes: Record<string, string | null>) => {
    close()
    router.push(inboxHref(base, params, { ...changes, page: null, id: null, person: null }))
  }

  // Choosing whose desk something is on, from a list that may already be the
  // Unassigned queue. The two are the same question asked twice, so picking a
  // name here steps back out of the queue rather than ANDing with it - which
  // would be an empty list and two controls each insisting they were right.
  // Nobody yet does the same: the tab says it better, and left on top of it the
  // chip underneath would be a filter that takes nothing off.
  const assignTo = (id: string | null) => go(
    params.status === 'unassigned' ? { assignee: id, status: 'open' } : { assignee: id },
  )

  if (names) {
    const needle = find.trim().toLowerCase()
    const shown = needle ? staff.filter((p) => p.name.toLowerCase().includes(needle)) : staff

    return (
      <>
        <div className="uin-menu-title uin-menu-back">
          <button
            type="button"
            ref={back}
            className="uin-icon-btn"
            aria-label="Back to the filters"
            onClick={() => setNames(false)}
          >
            {ChevronLeftIcon}
          </button>
          Assignees
        </div>
        {staff.length >= SEARCH_FROM && (
          <div className="uin-menu-search">
            <span aria-hidden="true">{SearchIcon}</span>
            <input
              type="search"
              value={find}
              onChange={(event) => setFind(event.target.value)}
              placeholder="Search"
              aria-label="Find a colleague"
            />
          </div>
        )}
        <Choice chosen={assignee === null} onClick={() => assignTo(null)}>Anyone</Choice>
        <Choice chosen={assignee === 'unassigned'} onClick={() => assignTo('unassigned')}>
          Nobody yet
        </Choice>
        {shown.map((person) => (
          <Choice
            key={person.id}
            chosen={assignee === person.id}
            onClick={() => assignTo(person.id)}
          >
            {person.name}
          </Choice>
        ))}
        {shown.length === 0 && <p className="uin-menu-empty">Nobody here by that name.</p>}
      </>
    )
  }

  return (
    <>
      <Choice
        icon={MailIcon}
        chosen={unreadOnly}
        onClick={() => go({ unread: unreadOnly ? null : '1' })}
      >
        Unread
      </Choice>
      {/* keepOpen because this chooses nothing: it swaps what is in the panel.
          Every other MenuItem shuts it, which is what pressing a choice should
          do. */}
      <MenuItem
        keepOpen
        icon={AssignedIcon}
        after={ChevronRightIcon}
        hint={assignee ? nameOf(assignee, staff) : undefined}
        onClick={() => setNames(true)}
      >
        Assignees
      </MenuItem>
    </>
  )
}

/** One entry that is either on or off. The tick is decoration - it is drawn
 *  inside an aria-hidden slot - so the state is said in words as well, which is
 *  the only half of it a screen reader gets. */
function Choice({
  chosen, onClick, icon, children,
}: {
  chosen: boolean
  onClick: () => void
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <MenuItem icon={icon} after={chosen ? TickIcon : undefined} onClick={onClick}>
      {children}
      {chosen && <span className="sr-only"> (on)</span>}
    </MenuItem>
  )
}

function nameOf(id: string, staff: Person[]): string {
  if (id === 'unassigned') return 'Nobody yet'
  return staff.find((p) => p.id === id)?.name ?? 'Somebody'
}
