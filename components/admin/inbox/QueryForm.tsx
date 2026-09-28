'use client'

import { useRouter } from 'next/navigation'
import type { ReactNode } from 'react'

// A form that changes the address without fetching the whole page again.
//
// Everything on this screen is drawn on the server from the query string, which
// is what makes a view sendable to a colleague and the back button behave. That
// part was right. Doing it with a plain GET form was not: a plain GET form is a
// full document load, so changing one word of a search pulled the entire admin
// down again, tabs, sidebar and all. The address is still the state; the change
// is handed to the router instead, and only the panel redraws.
//
// It is still a real form with a real action, so it does the right thing before
// the script arrives and for anybody browsing without one.

type Props = {
  /** Where the form points, i.e. the inbox page itself. */
  base: string
  /** Everything already chosen that should survive this change, as hidden
   *  fields. The field this form is about is left out by the caller. */
  hidden: Record<string, string>
  className?: string
  /** A field whose emptying should take effect straight away, without Enter:
   *  the search box, once a search is on. Clearing the words is plainly asking
   *  for the search to come off, and leaving its chip under an empty box says
   *  the list is narrowed by something nobody can see in the box any more.
   *  Only set it while that field is actually in the address, or clearing a
   *  box that was never searched would redraw the list for nothing. */
  applyWhenEmptied?: string
  children: ReactNode
}

export function QueryForm({ base, hidden, className, applyWhenEmptied, children }: Props) {
  const router = useRouter()

  const apply = (form: HTMLFormElement) => {
    const params = new URLSearchParams()
    for (const [key, value] of new FormData(form).entries()) {
      // A file has no business in a query string, and an empty box means
      // "not chosen" rather than "chosen as nothing".
      if (typeof value === 'string' && value) params.set(key, value)
    }
    const query = params.toString()
    router.push(query ? `${base}?${query}` : base)
  }

  return (
    <form
      method="get"
      action={base}
      className={className}
      onSubmit={(event) => {
        event.preventDefault()
        apply(event.currentTarget)
      }}
      // Typing it away and the little cross a search box carries both arrive
      // here, as a change to the field.
      onChange={(event) => {
        if (!applyWhenEmptied) return
        const field = event.nativeEvent.target
        if (field instanceof HTMLInputElement && field.name === applyWhenEmptied && field.value === '') {
          apply(event.currentTarget)
        }
      }}
    >
      {Object.entries(hidden).map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      {children}
    </form>
  )
}
