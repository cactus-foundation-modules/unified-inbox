'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { inboxHref } from '@/modules/unified-inbox/lib/list'
import { joinCategories, splitCategories, type ContactDraft } from '@/modules/unified-inbox/lib/contacts'
import { CardField, CardNotes, CardSection } from './ContactFieldRows'
import { AddressBlocks, LabelSuggestions, PhoneRows } from './ContactMultiFields'
import { CategoryPicker } from './CategoryPicker'
import { BackIcon, CloseIcon, SaveIcon } from './icons'
import { ComposeModal } from './ComposeModal'
import { AdminTooltip } from '@/components/admin/Tooltip'

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
  /** Drawn as a dialog over the list, the way a discussion or a text is, rather
   *  than in the reading pane. Only ever for a new contact: that is what the
   *  new-message menu starts, and an edit belongs beside the person it edits. */
  modal?: boolean
}

const EMPTY: ContactDraft = {}

/** What goes over the wire. The numbers and addresses are always sent, as the
 *  whole list, with the rows nobody filled in taken out: an empty line on the
 *  card is a place to type, not a number. Sent as a list even when it is empty,
 *  because an empty list on a card is somebody having taken the last one off. */
function toBody(draft: ContactDraft) {
  const { phone: _phone, phones, addresses, ...rest } = draft
  return {
    ...rest,
    phones: (phones ?? []).filter((p) => p.value.trim() !== ''),
    addresses: (addresses ?? []).filter((a) =>
      [a.addressLine1, a.addressLine2, a.addressCity, a.addressCounty, a.addressPostcode, a.addressCountry]
        .some((line) => (line ?? '').trim() !== '')),
  }
}

export function ContactCard({ base, params, personId, initial, onSaved, modal = false }: Props) {
  const router = useRouter()
  const listId = useId()
  const labelListId = `${listId}-labels`
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
          body: JSON.stringify(toBody(draft)),
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

  // Where the cross goes in the dialog: back to the list, with nothing
  // started. Anything typed is worth a question first.
  const closeHref = inboxHref(base, params, {})
  const guard = Object.values(draft).some((value) => typeof value === 'string' && value.trim() !== '')
    || (draft.phones ?? []).some((p) => p.value.trim() !== '')
    || (draft.addresses ?? []).length > 0

  const form = () => (
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
        <PhoneRows
          phones={draft.phones ?? []}
          onChange={(phones) => setDraft((current) => ({ ...current, phones }))}
          labelListId={labelListId}
          disabled={busy}
        />
        <CardField label="Website" type="url" value={draft.website ?? ''} onChange={set('website')} />
      </CardSection>

      <CardSection label="Where they are">
        <CardField
          label="What for"
          value={draft.addressLabel ?? ''}
          onChange={set('addressLabel')}
          placeholder="Billing, Delivery..."
          listId={labelListId}
        />
        <CardField label="Address" value={draft.addressLine1 ?? ''} onChange={set('addressLine1')} />
        <CardField label="Address 2" value={draft.addressLine2 ?? ''} onChange={set('addressLine2')} />
        <CardField label="Town" value={draft.addressCity ?? ''} onChange={set('addressCity')} />
        <CardField label="County" value={draft.addressCounty ?? ''} onChange={set('addressCounty')} />
        <CardField label="Postcode" value={draft.addressPostcode ?? ''} onChange={set('addressPostcode')} />
        <CardField label="Country" value={draft.addressCountry ?? ''} onChange={set('addressCountry')} />
        <AddressBlocks
          addresses={draft.addresses ?? []}
          onChange={(addresses) => setDraft((current) => ({ ...current, addresses }))}
          labelListId={labelListId}
          disabled={busy}
        />
      </CardSection>
      <LabelSuggestions id={labelListId} />

      <CardNotes value={draft.notes ?? ''} onChange={set('notes')} disabled={busy} />
    </div>
  )

  // Up in the head, left of the cross, in the same round frame as the icons
  // on a contact's own page - rather than a Save and a Cancel at the foot of a
  // form long enough that nobody scrolls to them. The cross is the way out.
  const saveLabel = busy ? 'Saving...' : personId ? 'Save changes' : 'Add this contact'
  const saveButton = (
    <div className="uin-thread-actions uin-person-actions">
      <AdminTooltip body={saveLabel}>
        <button type="button" className="uin-icon-btn uin-icon-btn-framed" onClick={save} disabled={busy}>
          {SaveIcon}
          <span className="sr-only">{saveLabel}</span>
        </button>
      </AdminTooltip>
    </div>
  )

  if (modal) {
    return (
      <ComposeModal
        title="New contact"
        closeHref={closeHref}
        guard={guard}
        noun="contact"
        focusId="uin-contact-first-name"
        headActions={saveButton}
      >
        {() => form()}
      </ComposeModal>
    )
  }

  return (
    <div className="uin-thread">
      <div className="uin-thread-head">
        <div className="uin-thread-top">
          <h2 className="uin-thread-subject">{personId ? 'Edit this contact' : 'New contact'}</h2>
          {saveButton}
          <Link className="uin-thread-close" href={inboxHref(base, params, { person: null, import: null })}>
            <span className="uin-back-phone" aria-hidden="true">{BackIcon}<span className="uin-back-words">Back</span></span>
            <span className="uin-back-wide" aria-hidden="true">{CloseIcon}</span>
            <span className="sr-only">Close this card and go back to the list</span>
          </Link>
        </div>
      </div>

      <div className="uin-thread-body">
        {form()}
      </div>
    </div>
  )
}
