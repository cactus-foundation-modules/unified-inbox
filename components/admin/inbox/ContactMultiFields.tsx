'use client'

import { useId } from 'react'
import type { LabelledAddress, LabelledPhone } from '@/modules/unified-inbox/lib/contacts'
import { CardField } from './ContactFieldRows'

// The parts of a contact card that come in any number: phone numbers and
// postal addresses, each with a word for what it is.
//
// A customer has an order number and a delivery number, a billing address and a
// delivery address, and a card with one box apiece cannot say which it holds.
// The words are suggestions, not a menu: somebody whose second address is "Head
// office" or "Site" types that, and an address book that will not let them is
// an address book they stop using.

/** What the label boxes offer. Free text beside them: these are only the words
 *  most often wanted. */
const LABEL_SUGGESTIONS = ['Order', 'Delivery', 'Billing', 'Work', 'Mobile', 'Home']

/** The one list the label boxes on a card share. */
export function LabelSuggestions({ id }: { id: string }) {
  return (
    <datalist id={id}>
      {LABEL_SUGGESTIONS.map((word) => <option key={word} value={word} />)}
    </datalist>
  )
}

export const EMPTY_PHONE: LabelledPhone = { label: '', value: '' }
export const EMPTY_ADDRESS: LabelledAddress = {
  label: '', addressLine1: '', addressLine2: '', addressCity: '',
  addressCounty: '', addressPostcode: '', addressCountry: '',
}

type PhonesProps = {
  phones: LabelledPhone[]
  onChange: (phones: LabelledPhone[]) => void
  labelListId: string
  disabled?: boolean
}

/** Every number, one a line: what it is for, then the number, then the cross
 *  that takes it off. At least one line is always drawn, so a card with none
 *  still has somewhere to type. */
export function PhoneRows({ phones, onChange, labelListId, disabled }: PhonesProps) {
  const rows = phones.length > 0 ? phones : [EMPTY_PHONE]
  const update = (index: number, patch: Partial<LabelledPhone>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  const remove = (index: number) => onChange(rows.filter((_, i) => i !== index))

  return (
    <>
      {rows.map((row, index) => (
        <div className="uin-multi-row" key={index}>
          <input
            className="uin-multi-label"
            aria-label={`What phone number ${index + 1} is for`}
            list={labelListId}
            placeholder="What for"
            value={row.label ?? ''}
            disabled={disabled}
            onChange={(event) => update(index, { label: event.target.value })}
          />
          <input
            className="uin-multi-value"
            type="tel"
            aria-label={`Phone number ${index + 1}`}
            placeholder="Phone number"
            value={row.value}
            disabled={disabled}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <button
            type="button"
            className="uin-ctx-x"
            disabled={disabled}
            onClick={() => remove(index)}
          >
            <span aria-hidden="true">&times;</span>
            <span className="sr-only">Take phone number {index + 1} off</span>
          </button>
        </div>
      ))}
      <div className="uin-multi-add">
        <button
          type="button"
          className="uin-field-add"
          disabled={disabled}
          onClick={() => onChange([...rows, { ...EMPTY_PHONE }])}
        >
          Add another number
        </button>
      </div>
    </>
  )
}

type AddressesProps = {
  addresses: LabelledAddress[]
  onChange: (addresses: LabelledAddress[]) => void
  labelListId: string
  disabled?: boolean
}

/** The further addresses, each a small ruled block of its own with the same
 *  boxes as the first one and a label on top. */
export function AddressBlocks({ addresses, onChange, labelListId, disabled }: AddressesProps) {
  const base = useId()
  const update = (index: number, patch: Partial<LabelledAddress>) =>
    onChange(addresses.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  const set = (index: number, field: keyof LabelledAddress) => (value: string) =>
    update(index, { [field]: value })

  return (
    <>
      {addresses.map((address, index) => (
        <div className="uin-multi-address" key={index}>
          <div className="uin-field-row">
            <label htmlFor={`${base}-${index}-label`}>What for</label>
            <div className="uin-field-control">
              <input
                id={`${base}-${index}-label`}
                list={labelListId}
                placeholder="Delivery, Head office..."
                value={address.label ?? ''}
                disabled={disabled}
                onChange={(event) => update(index, { label: event.target.value })}
              />
              <button
                type="button"
                className="uin-field-add"
                disabled={disabled}
                onClick={() => onChange(addresses.filter((_, i) => i !== index))}
              >
                Take off
              </button>
            </div>
          </div>
          <CardField label="Address" value={address.addressLine1 ?? ''} onChange={set(index, 'addressLine1')} disabled={disabled} />
          <CardField label="Address 2" value={address.addressLine2 ?? ''} onChange={set(index, 'addressLine2')} disabled={disabled} />
          <CardField label="Town" value={address.addressCity ?? ''} onChange={set(index, 'addressCity')} disabled={disabled} />
          <CardField label="County" value={address.addressCounty ?? ''} onChange={set(index, 'addressCounty')} disabled={disabled} />
          <CardField label="Postcode" value={address.addressPostcode ?? ''} onChange={set(index, 'addressPostcode')} disabled={disabled} />
          <CardField label="Country" value={address.addressCountry ?? ''} onChange={set(index, 'addressCountry')} disabled={disabled} />
        </div>
      ))}
      <div className="uin-multi-add">
        <button
          type="button"
          className="uin-field-add"
          disabled={disabled}
          onClick={() => onChange([...addresses, { ...EMPTY_ADDRESS }])}
        >
          Add another address
        </button>
      </div>
    </>
  )
}
