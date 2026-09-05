'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { inboxHref } from '@/modules/unified-inbox/lib/list'
import { joinCategories, splitCategories, type ContactDraft } from '@/modules/unified-inbox/lib/contacts'
import { CardField, CardNotes, CardSection } from './ContactFieldRows'
import { CategoryPicker } from './CategoryPicker'
import { BackIcon } from './icons'

// One contact, written down.
//
// The same card whether it is somebody brand new or somebody the post has
// already introduced us to, because it is the same information either way and
// two forms for one record is two forms that drift. What changes is where it
// posts and where it goes afterwards.
//
// The organisation is a plain box with the ones we already know offered
// underneath. Not a menu: an address book that will not let somebody type in a
// company it has never heard of is an address book that stops being used the
// first time a new supplier rings. The server matches on the name, case and
// spacing ignored, before it creates anything - which is what stops "Acme Ltd"
// and "acme ltd" becoming two companies.

type Props = {
  base: string
  params: Record<string, string>
  /** The contact being corrected, or null to start a new one. */
  personId: string | null
  initial: ContactDraft
  /** Where to go when it saves. A new contact opens on their own page; an edit
   *  stays exactly where it was. */
  onSaved?: () => void
}

const EMPTY: ContactDraft = {}

export function ContactCard({ base, params, personId, initial, onSaved }: Props) {
  const router = useRouter()
  const listId = useId()
  const [draft, setDraft] = useState<ContactDraft>({ ...EMPTY, ...initial })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refused, setRefused] = useState<string[]>([])
  const [organisations, setOrganisations] = useState<string[]>([])
  const [categories, setCategories] = useState<string[]>([])

  const set = useCallback((field: keyof ContactDraft) => (value: string) => {
    setDraft((current) => ({ ...current, [field]: value }))
  }, [])

  // The companies already on the site, offered under the organisation box. One
  // request when the card opens rather than one per keystroke: a site has tens
  // of these, not thousands, and a suggestion list that lags behind the typing
  // is worse than one that is a few minutes old.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [orgs, cats] = await Promise.all([
          fetch('/api/m/unified-inbox/organisations?perPage=100'),
          fetch('/api/m/unified-inbox/categories'),
        ])
        if (orgs.ok) {
          const body = await orgs.json() as { organisations?: Array<{ name: string }> }
          if (!cancelled) setOrganisations((body.organisations ?? []).map((o) => o.name))
        }
        if (cats.ok) {
          const body = await cats.json() as { categories?: Array<{ name: string }> }
          if (!cancelled) setCategories((body.categories ?? []).map((c) => c.name))
        }
      } catch {
        // A suggestion list that could not be fetched is a box with no
        // suggestions under it, which still works perfectly well.
      }
    })()
    return () => { cancelled = true }
  }, [])

  const save = async () => {
    setBusy(true)
    setError('')
    setRefused([])
    try {
      const response = await fetch(
        personId
          ? `/api/m/unified-inbox/people/${personId}`
          : '/api/m/unified-inbox/people',
        {
          method: personId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        },
      )
      const body = await response.json().catch(() => null) as
        { error?: string; id?: string; refused?: string[] } | null
      if (!response.ok) {
        setError(body?.error ?? 'That did not save.')
        return
      }
      // Said rather than swallowed: an address somebody else already holds is
      // left with them on purpose, and a card that saved everything except the
      // one field somebody came here to add is a card that looks broken.
      setRefused(body?.refused ?? [])
      if (!personId && body?.id) {
        router.push(inboxHref(base, params, { person: body.id, import: null }))
        return
      }
      router.refresh()
      onSaved?.()
    } catch {
      setError('The site could not be reached, so nothing was saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="uin-thread">
      <div className="uin-thread-head">
        <Link
          className="uin-chip uin-back"
          href={inboxHref(base, params, { person: null, import: null })}
          style={{ justifySelf: 'start' }}
        >
          <span className="uin-back-phone" aria-hidden="true">{BackIcon} Back to the list</span>
          <span className="uin-back-wide" aria-hidden="true">&times; Close</span>
          <span className="sr-only">Close this card and go back to the list</span>
        </Link>
        <h2 className="uin-thread-subject">{personId ? 'Edit this contact' : 'New contact'}</h2>
      </div>

      <div className="uin-thread-body">
        <div className="uin-card">
          {error && <div className="alert alert-danger" role="alert">{error}</div>}
          {refused.length > 0 && (
            <div className="alert alert-info" role="status">
              Everything else saved, but {refused.join(' and ')} already belongs to somebody
              else here, so it was left with them. Merge the two if they are the same person.
            </div>
          )}

          <CardSection label="Who they are">
            <CardField label="First name" value={draft.firstName ?? ''} onChange={set('firstName')} autoFocus />
            <CardField label="Last name" value={draft.lastName ?? ''} onChange={set('lastName')} />
            <CardField label="Job title" value={draft.jobTitle ?? ''} onChange={set('jobTitle')} />
            <div className="uin-field-row">
              <label htmlFor={`${listId}-org`}>Organisation</label>
              <div className="uin-field-control">
                <input
                  id={`${listId}-org`}
                  list={listId}
                  value={draft.organisation ?? ''}
                  onChange={(event) => set('organisation')(event.target.value)}
                />
                <datalist id={listId}>
                  {organisations.map((name) => <option key={name} value={name} />)}
                </datalist>
              </div>
            </div>
            <CategoryPicker
              available={categories}
              value={splitCategories(draft.categories)}
              disabled={busy}
              /* Always sent, even when it comes to nothing: an empty box on a
                 form means "none of them", which is a thing somebody means. */
              onChange={(names) => setDraft((current) => ({
                ...current, categories: joinCategories(names),
              }))}
            />
          </CardSection>

          <CardSection label="How to reach them">
            <CardField label="Email" type="email" value={draft.email ?? ''} onChange={set('email')} />
            <CardField label="Phone" type="tel" value={draft.phone ?? ''} onChange={set('phone')} />
            <CardField label="Website" type="url" value={draft.website ?? ''} onChange={set('website')} />
          </CardSection>

          <CardSection label="Where they are">
            <CardField label="Address" value={draft.addressLine1 ?? ''} onChange={set('addressLine1')} />
            <CardField label="Address 2" value={draft.addressLine2 ?? ''} onChange={set('addressLine2')} />
            <CardField label="Town" value={draft.addressCity ?? ''} onChange={set('addressCity')} />
            <CardField label="County" value={draft.addressCounty ?? ''} onChange={set('addressCounty')} />
            <CardField label="Postcode" value={draft.addressPostcode ?? ''} onChange={set('addressPostcode')} />
            <CardField label="Country" value={draft.addressCountry ?? ''} onChange={set('addressCountry')} />
          </CardSection>

          <CardNotes value={draft.notes ?? ''} onChange={set('notes')} disabled={busy} />

          <div className="uin-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
              {busy ? 'Saving...' : personId ? 'Save changes' : 'Add this contact'}
            </button>
            <Link
              className="btn btn-secondary btn-sm"
              href={inboxHref(base, params, personId ? { person: personId } : { person: null, import: null })}
            >
              Cancel
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
