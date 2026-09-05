'use client'

import { useId, useState } from 'react'
import type { Caller, ContactCategoryRow, Inbox, Settings } from './types'
import { CheckField, FieldGroup, FieldRow, FormActions, MUTED, Panel } from './ui'
import { CategoriesSection } from './CategoriesSection'

// ---------------------------------------------------------------------------
// People: who the messages are from, and how a number written in one gets
// matched to a record of your own.
// ---------------------------------------------------------------------------

/** A textarea of one-per-line values, back and forth. Commas are accepted too,
 *  because somebody will type them. */
function linesToList(value: string): string[] {
  return [...new Set(
    value.split(/[\n,]+/).map((line) => line.trim().toLowerCase()).filter(Boolean),
  )]
}

export function PeoplePanel({ settings, inboxes, counts, categories, busy, call }: {
  settings: Settings
  inboxes: Inbox[]
  counts: { people: number; organisations: number }
  categories: ContactCategoryRow[]
  busy: boolean
  call: Caller
}) {
  const [seeded, setSeeded] = useState(settings)
  const [own, setOwn] = useState((settings.ownDomains ?? []).join('\n'))
  const [overrideOwn, setOverrideOwn] = useState(settings.ownDomains !== null)
  const [personal, setPersonal] = useState(settings.personalDomains.join('\n'))
  const [order, setOrder] = useState(settings.orderNumberPattern ?? '')
  const [po, setPo] = useState(settings.poNumberPattern ?? '')
  const [quote, setQuote] = useState(settings.quoteNumberPattern ?? '')
  // A pattern that cannot be searched for used to be accepted here and only fall
  // over later, out of sight.
  const [patternError, setPatternError] = useState<string | null>(null)
  const fid = useId()
  if (seeded !== settings) {
    setSeeded(settings)
    setOwn((settings.ownDomains ?? []).join('\n'))
    setOverrideOwn(settings.ownDomains !== null)
    setPersonal(settings.personalDomains.join('\n'))
    setOrder(settings.orderNumberPattern ?? '')
    setPo(settings.poNumberPattern ?? '')
    setQuote(settings.quoteNumberPattern ?? '')
  }

  // What the module will treat as one of your own domains if you leave it to
  // work it out: the domains of the addresses you collect mail on.
  const inferred = [...new Set(
    inboxes
      .map((i) => i.address.split('@')[1]?.toLowerCase())
      .filter((d): d is string => !!d),
  )]

  async function save() {
    const patterns: Array<[string, string]> = [
      ['Order numbers look like', order],
      ['Purchase order numbers look like', po],
      ['Quote references look like', quote],
    ]
    for (const [label, value] of patterns) {
      if (value.trim() === '') continue
      try {
        // Built only to find out whether it can be.
        new RegExp(value)
      } catch {
        setPatternError(`"${label}" is not something we can search for. Digits are written [0-9]+, so a number like ABC-1024 is ABC-[0-9]+. Leave the box empty to use the usual one.`)
        return
      }
    }
    setPatternError(null)
    await call('/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        ownDomains: overrideOwn ? linesToList(own) : null,
        personalDomains: linesToList(personal),
        orderNumberPattern: order.trim() === '' ? null : order,
        poNumberPattern: po.trim() === '' ? null : po,
        quoteNumberPattern: quote.trim() === '' ? null : quote,
      }),
    }, 'People settings saved.')
  }

  return (
    <Panel
      title="People and companies"
      blurb={<>
        Messages from the same person are gathered together so you can see everything they have ever
        said in one place. What is held about them - names, numbers, an address, a category or two -
        is on the <strong>Contacts</strong> tab of the inbox itself. This is where the rules behind
        it live: who counts as a colleague, and what your own reference numbers look like.
      </>}
    >
      <p className="field-hint" style={{ margin: '0 0 1.25rem' }}>
        {counts.people === 0
          ? 'Nobody yet. People appear as mail is collected.'
          : `${counts.people} ${counts.people === 1 ? 'person' : 'people'} so far, across ${counts.organisations} ${counts.organisations === 1 ? 'company' : 'companies'}.`}
      </p>

      <FieldGroup
        first
        title="Telling colleagues from customers"
        hint="No record is kept of a colleague, so the list stays a list of the people you actually deal with."
      >
        <CheckField
          label="Work out which addresses are your colleagues’ from the addresses you collect mail on"
          checked={!overrideOwn}
          onChange={(auto) => setOverrideOwn(!auto)}
          hint={overrideOwn ? undefined : (inferred.length > 0
            ? `Anybody at ${inferred.join(', ')} is treated as one of you rather than as a customer.`
            : 'Add an inbox and the domain it uses will be treated as yours.')}
        />

        {overrideOwn && (
          <div className="field">
            <label htmlFor={`${fid}-own`}>Your own domains <span style={{ ...MUTED, fontWeight: 400 }}>(one per line)</span></label>
            <textarea id={`${fid}-own`} rows={3} value={own} onChange={(e) => setOwn(e.target.value)} />
            <span className="field-hint">
              Anybody writing from one of these is a colleague, not a customer, and no record is kept
              of them.
            </span>
          </div>
        )}

        <div className="field">
          <label htmlFor={`${fid}-personal`}>Other free email providers <span style={{ ...MUTED, fontWeight: 400 }}>(one per line)</span></label>
          <textarea id={`${fid}-personal`} rows={2} value={personal} onChange={(e) => setPersonal(e.target.value)} />
          <span className="field-hint">
            The usual ones are already known. Add any others your customers use, so their email
            provider does not get mistaken for the company they work for.
          </span>
        </div>
      </FieldGroup>

      <CategoriesSection categories={categories} busy={busy} call={call} />

      <FieldGroup
        title="Spotting references"
        hint={<>
          When somebody quotes an order or purchase order number, it gets attached to the
          conversation. Nothing is attached until the number has been checked against your own
          records, and anything attached this way says so and comes off in one click. Leave a box
          empty unless your numbers look unusual - and if you do fill one in, write it the way it is
          printed with the digits shown as <code>[0-9]+</code>.
        </>}
      >
        {patternError && (
          <div className="alert alert-danger" role="alert" style={{ marginBottom: '1rem' }}>{patternError}</div>
        )}
        <FieldRow>
          <div className="field">
            <label htmlFor={`${fid}-order`}>Order numbers look like</label>
            <input id={`${fid}-order`} value={order} placeholder="ABC-[0-9]+" onChange={(e) => setOrder(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${fid}-po`}>Purchase order numbers look like</label>
            <input id={`${fid}-po`} value={po} placeholder="PO-[0-9]+" onChange={(e) => setPo(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${fid}-quote`}>Quote references look like</label>
            <input id={`${fid}-quote`} value={quote} placeholder="Q-[0-9]+" onChange={(e) => setQuote(e.target.value)} />
          </div>
        </FieldRow>
      </FieldGroup>

      <FormActions>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Save people settings</button>
      </FormActions>
    </Panel>
  )
}
