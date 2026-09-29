'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ThreadContact } from '@/modules/unified-inbox/lib/thread-contact'
import { AdminTooltip } from '@/components/admin/Tooltip'
import { Dropdown, MenuItem } from './Dropdown'
import { TickIcon } from './icons'

// Who the conversation is with, at the start of the line under its name - and,
// the way the name above it renames it, pressing it changes it.
//
// The choice is everybody who actually appears in the conversation (see
// lib/thread-contact.ts): whoever wrote in, and whoever we wrote to. Picking
// one is what the list and this line call it from then on, whoever writes
// next. "Whoever wrote last" puts it back to reading the newest message, which
// is what it did before anybody chose.
//
// The link to every conversation with them used to be the name itself. It is
// the first entry on the panel now, so it is one press further away and still
// there.

type Props = {
  threadId: string
  /** What the line says now. */
  label: string
  /** Every conversation with them, where there is a card to link to. */
  href: string | null
  contacts: ThreadContact[]
  /** The address somebody picked, or null while it follows the newest message. */
  chosenAddress: string | null
}

export function ThreadContactPicker({ threadId, label, href, contacts, chosenAddress }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const chosen = chosenAddress?.trim().toLowerCase() ?? null

  const pick = async (address: string | null) => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/m/unified-inbox/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactAddress: address }),
      })
      if (!response.ok) {
        setError((await response.json().catch(() => null))?.error ?? 'That could not be changed.')
        return
      }
      router.refresh()
    } catch {
      setError('The site could not be reached, so nothing changed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <AdminTooltip body="Press to change who this is with">
      <Dropdown
        label={label}
        ariaLabel={`With ${label}. Change who this conversation is with`}
        className="uin-thread-with uin-contact-button"
        disabled={busy}
        width={300}
      >
        <div className="uin-menu-title">Who this is with</div>
        {contacts.map((contact) => (
          <MenuItem
            key={contact.address}
            disabled={busy}
            hint={contact.name ? contact.address : undefined}
            after={chosen === contact.address.toLowerCase() ? TickIcon : undefined}
            onClick={() => void pick(contact.address)}
          >
            {contact.name ?? contact.address}
            {chosen === contact.address.toLowerCase() && <span className="sr-only"> (chosen)</span>}
          </MenuItem>
        ))}
        {chosen && (
          <MenuItem disabled={busy} onClick={() => void pick(null)}>Whoever wrote last</MenuItem>
        )}
        {href && (
          <>
            <div className="uin-menu-sep" />
            <MenuItem onClick={() => router.push(href)}>Every conversation with them</MenuItem>
          </>
        )}
      </Dropdown>
      </AdminTooltip>
      {error && <span className="uin-contact-error" role="alert">{error}</span>}
    </>
  )
}
