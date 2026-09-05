'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { inboxHref } from '@/modules/unified-inbox/lib/list'
import { CardField, CardNotes, CardSection } from './ContactFieldRows'
import { ConfirmDialog } from './ConfirmDialog'
import { BackIcon } from './icons'

// One organisation, written down.
//
// The domain is the one field here that is not just information: it is what the
// mail pass matches a new correspondent on, and it is unique across the site. So
// it is offered plainly with a note saying what it does, rather than filled in
// automatically from whatever address somebody happened to type - a guessed
// domain would quietly claim every future writer at that domain for whichever
// company was typed first.

export type OrganisationDraft = {
  name: string
  domain: string
  email: string
  phone: string
  website: string
  addressLine1: string
  addressLine2: string
  addressCity: string
  addressCounty: string
  addressPostcode: string
  addressCountry: string
  notes: string
}

export const EMPTY_ORGANISATION: OrganisationDraft = {
  name: '', domain: '', email: '', phone: '', website: '',
  addressLine1: '', addressLine2: '', addressCity: '', addressCounty: '',
  addressPostcode: '', addressCountry: '', notes: '',
}

type Props = {
  base: string
  params: Record<string, string>
  organisationId: string | null
  initial: OrganisationDraft
  peopleCount: number
  /** Whether this reader may remove it. Wider than correcting one, because it
   *  takes a badge off everybody in it at once. */
  canDelete: boolean
}

export function OrganisationCard({
  base, params, organisationId, initial, peopleCount, canDelete,
}: Props) {
  const router = useRouter()
  const [draft, setDraft] = useState<OrganisationDraft>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [asked, setAsked] = useState(false)

  const set = (field: keyof OrganisationDraft) => (value: string) => {
    setDraft((current) => ({ ...current, [field]: value }))
  }

  const save = async () => {
    if (!draft.name.trim()) {
      setError('An organisation needs a name.')
      return
    }
    setBusy(true)
    setError('')
    try {
      // Empty boxes go as null rather than as empty strings: "not known" and
      // "known to be blank" are the same thing here, and one of them sorts
      // differently from the other.
      const body = Object.fromEntries(
        Object.entries(draft).map(([key, value]) => [key, value.trim() || null]),
      )
      const response = await fetch(
        organisationId
          ? `/api/m/unified-inbox/organisations/${organisationId}`
          : '/api/m/unified-inbox/organisations',
        {
          method: organisationId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, name: draft.name.trim() }),
        },
      )
      const result = await response.json().catch(() => null) as { error?: string; id?: string } | null
      if (!response.ok) {
        setError(result?.error ?? 'That did not save.')
        return
      }
      if (!organisationId && result?.id) {
        router.push(inboxHref(base, params, { org: result.id, view: 'organisations' }))
        return
      }
      router.refresh()
    } catch {
      setError('The site could not be reached, so nothing was saved.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!organisationId) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/m/unified-inbox/organisations/${organisationId}`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        setError((await response.json().catch(() => null))?.error ?? 'That did not work.')
        return
      }
      router.push(inboxHref(base, params, { org: null, view: 'organisations' }))
    } catch {
      setError('The site could not be reached, so nothing changed.')
    } finally {
      setBusy(false)
      setAsked(false)
    }
  }

  return (
    <div className="uin-thread">
      <div className="uin-thread-head">
        <Link
          className="uin-chip uin-back"
          href={inboxHref(base, params, { org: null })}
          style={{ justifySelf: 'start' }}
        >
          <span className="uin-back-phone" aria-hidden="true">{BackIcon} Back to the list</span>
          <span className="uin-back-wide" aria-hidden="true">&times; Close</span>
          <span className="sr-only">Close this organisation and go back to the list</span>
        </Link>
        <h2 className="uin-thread-subject">{organisationId ? draft.name || 'This organisation' : 'New organisation'}</h2>
        {organisationId && peopleCount > 0 && (
          <div className="uin-thread-meta">
            <Link href={inboxHref(base, params, { view: null, org: organisationId })}>
              {peopleCount === 1 ? '1 contact here' : `${peopleCount} contacts here`}
            </Link>
          </div>
        )}
      </div>

      <div className="uin-thread-body">
        <div className="uin-card">
          {error && <div className="alert alert-danger" role="alert">{error}</div>}

          <CardSection label="Who they are">
            <CardField label="Name" value={draft.name} onChange={set('name')} autoFocus />
            <CardField
              label="Mail domain"
              value={draft.domain}
              onChange={set('domain')}
              placeholder="acme.co.uk"
              hint="New writers from here join this organisation"
            />
          </CardSection>

          <CardSection label="How to reach them">
            <CardField label="Email" type="email" value={draft.email} onChange={set('email')} />
            <CardField label="Phone" type="tel" value={draft.phone} onChange={set('phone')} />
            <CardField label="Website" type="url" value={draft.website} onChange={set('website')} />
          </CardSection>

          <CardSection label="Where they are">
            <CardField label="Address" value={draft.addressLine1} onChange={set('addressLine1')} />
            <CardField label="Address 2" value={draft.addressLine2} onChange={set('addressLine2')} />
            <CardField label="Town" value={draft.addressCity} onChange={set('addressCity')} />
            <CardField label="County" value={draft.addressCounty} onChange={set('addressCounty')} />
            <CardField label="Postcode" value={draft.addressPostcode} onChange={set('addressPostcode')} />
            <CardField label="Country" value={draft.addressCountry} onChange={set('addressCountry')} />
          </CardSection>

          <CardNotes value={draft.notes} onChange={set('notes')} disabled={busy} />

          <div className="uin-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => { void save() }} disabled={busy}>
              {busy ? 'Saving...' : organisationId ? 'Save changes' : 'Add this organisation'}
            </button>
            <Link className="btn btn-secondary btn-sm" href={inboxHref(base, params, { org: null })}>
              Cancel
            </Link>
            {organisationId && canDelete && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAsked(true)} disabled={busy}>
                Remove this organisation
              </button>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={asked}
        title="Remove this organisation?"
        body={
          <>
            <p>
              {peopleCount === 0
                ? 'Nobody is in it, so nothing else changes.'
                : peopleCount === 1
                  ? 'The one contact in it keeps their own record and simply stops showing this name.'
                  : `The ${peopleCount} contacts in it keep their own records and simply stop showing this name.`}
            </p>
            <p>No conversations, orders or invoices are touched.</p>
          </>
        }
        confirmLabel="Remove it"
        destructive
        busy={busy}
        onCancel={() => { if (!busy) setAsked(false) }}
        onConfirm={() => { void remove() }}
      />
    </div>
  )
}
