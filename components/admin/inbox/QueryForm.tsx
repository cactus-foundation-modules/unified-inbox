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
  children: ReactNode
}

export function QueryForm({ base, hidden, className, children }: Props) {
  const router = useRouter()

  return (
    <form
      method="get"
      action={base}
      className={className}
      onSubmit={(event) => {
        event.preventDefault()
        const params = new URLSearchParams()
        for (const [key, value] of new FormData(event.currentTarget).entries()) {
          // A file has no business in a query string, and an empty box means
          // "not chosen" rather than "chosen as nothing".
          if (typeof value === 'string' && value) params.set(key, value)
        }
        const query = params.toString()
        router.push(query ? `${base}?${query}` : base)
      }}
    >
      {Object.entries(hidden).map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      {children}
    </form>
  )
}
