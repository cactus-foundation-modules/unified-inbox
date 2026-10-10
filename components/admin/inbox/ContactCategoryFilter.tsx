'use client'

import { useRouter } from 'next/navigation'
import { Dropdown, MenuItem } from './Dropdown'
import { FilterIcon, TickIcon } from './icons'

// The filter on the contacts list: which labels to show, one or several.
//
// A panel of ticks rather than the switch the conversation list has, because
// this is a choice from a list that changes from site to site rather than a
// yes or no. It stays open while ticking, since narrowing to two labels is two
// presses and a panel that shut after each would be four.
//
// Every tick is a change of address - the links are worked out on the server
// (see ContactsToolbar) and followed here - so the list drawn is always the
// one the address describes, and the view can be sent to a colleague.

export type CategoryChoice = {
  id: string
  name: string
  people: number
  selected: boolean
  /** Where ticking or unticking this one goes, everything else kept. */
  href: string
}

type Props = {
  choices: CategoryChoice[]
  /** Where "Everybody" goes: every label off. */
  clearHref: string
}

export function ContactCategoryFilter({ choices, clearHref }: Props) {
  const router = useRouter()
  const on = choices.filter((c) => c.selected)
  const label = on.length === 0
    ? 'Filter by label. Showing everybody.'
    : `Filter by label. Showing ${on.map((c) => c.name).join(', ')}.`

  return (
    <Dropdown
      label={FilterIcon}
      ariaLabel={label}
      title={on.length === 0 ? 'Filter by label' : `Showing: ${on.map((c) => c.name).join(', ')}`}
      className={on.length > 0 ? 'uin-icon-btn uin-icon-btn-on' : 'uin-icon-btn'}
      width={240}
      align="start"
    >
      <MenuItem
        keepOpen
        onClick={() => router.push(clearHref, { scroll: false })}
        after={on.length === 0 ? TickIcon : undefined}
      >
        Everybody
      </MenuItem>
      {choices.map((choice) => (
        <MenuItem
          key={choice.id}
          keepOpen
          onClick={() => router.push(choice.href, { scroll: false })}
          hint={choice.people > 0 ? (choice.people > 999 ? '999+' : choice.people) : undefined}
          after={choice.selected ? TickIcon : undefined}
        >
          {choice.name}
        </MenuItem>
      ))}
    </Dropdown>
  )
}
