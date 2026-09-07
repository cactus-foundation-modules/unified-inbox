'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createPortal } from 'react-dom'
import { AdminTooltip } from '@/components/admin/Tooltip'
import { BlockedAddressesIcon, CloseIcon } from './icons'

// ---------------------------------------------------------------------------
// Everybody the site turns away, read from the folder their post lands in.
//
// The same list as Settings -> Unified Inbox -> Collecting, and deliberately
// the same list rather than a second one: one route, one order, one way to lift
// a block. What is new is where it can be reached from. Post from a blocked
// sender is now collected and filed straight into the Spam folder, so the Spam
// folder is where somebody is standing when the question occurs to them - "who
// IS blocked?", or "why has this customer stopped getting through?" - and
// sending them off to a settings page to find out is sending them somewhere
// they then have to find their way back from.
//
// ADDING ONE IS NOT HERE, exactly as it is not on the settings page. A sender
// is blocked from a conversation, where whoever presses the button has the
// evidence in front of them and reads the address off the message. A box that
// blocks whatever is typed into it is a box that eventually holds a customer's
// address with one letter wrong in it.
//
// NEWEST FIRST, which is the order the route already returns. The block
// somebody is hunting for is nearly always the one they have just made, or the
// one a colleague made this week that a customer is now on the phone about.
//
// Only drawn for somebody who may read the site's settings, because that is the
// grant the list itself takes - it is a fact about how the site is set up and
// it names colleagues. Lifting a block takes the grant to reply, the same one
// making it does, so the button to let somebody through is offered only to
// whoever could have shut the door in the first place.
// ---------------------------------------------------------------------------

type Row = {
  id: string
  address: string
  blockedByUserId: string | null
  createdAt: string
}

export function BlockedAddresses({ staff, canUnblock }: {
  /** Names for the "blocked by" line. The id on its own means nothing to
   *  anybody, and the list is already on this screen for the assignee filter. */
  staff: Array<{ id: string; name: string }>
  /** Whether this reader may let somebody back in. Reading who is blocked and
   *  changing it are two different grants - see the route. */
  canUnblock: boolean
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      {/* The admin's own tooltip rather than `title=`: the native one waits a
          second before it says anything and never appears for a keyboard, and
          every control in this row is a drawing with no word on its face. */}
      <AdminTooltip body="Blocked addresses">
        <button
          type="button"
          className="uin-icon-btn"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          {BlockedAddressesIcon}
          <span className="sr-only">Blocked addresses. See who the site turns away.</span>
        </button>
      </AdminTooltip>
      {open && (
        <BlockedAddressesDialog
          staff={staff}
          canUnblock={canUnblock}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/** The dialog itself, mounted only while it is open so the list is fetched when
 *  somebody asks for it rather than on every draw of every conversation list. */
function BlockedAddressesDialog({ staff, canUnblock, onClose }: {
  staff: Array<{ id: string; name: string }>
  canUnblock: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [failed, setFailed] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  /** What just happened, kept on the screen after the row has gone. A row that
   *  vanishes with nothing said in its place reads as a mis-click. */
  const [note, setNote] = useState('')

  const closeRef = useRef(onClose)
  const returnTo = useRef<HTMLElement | null>(null)
  const card = useRef<HTMLDivElement | null>(null)
  /** Whether anything was actually let through. The list behind this dialog is
   *  drawn on the server and does not change until it is asked again, so the
   *  refresh happens once on the way out rather than after every press. */
  const changed = useRef(false)

  useEffect(() => { closeRef.current = onClose })

  useEffect(() => {
    let live = true
    fetch('/api/m/unified-inbox/blocked-senders')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('refused'))))
      .then((data: { blocked?: Row[] }) => {
        if (!live) return
        setRows(Array.isArray(data.blocked) ? data.blocked : [])
      })
      .catch(() => {
        if (!live) return
        setRows([])
        setFailed('That list could not be read. You may not be allowed to see it, or the site did not answer.')
      })
    return () => { live = false }
  }, [])

  // The keyboard starts on the card and goes back where it came from. Escape
  // shuts it, caught on the page so a dialog opened over something else does
  // not shut that as well.
  useEffect(() => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    card.current?.focus()
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeRef.current()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = previous
      returnTo.current?.focus()
    }
  }, [])

  // Anything let through changes what the folder behind this holds from the
  // next collection onwards, and the settings page lists the same rows. One
  // refresh on the way out rather than one per press.
  const close = useCallback(() => {
    if (changed.current) router.refresh()
    onClose()
  }, [onClose, router])

  const unblock = useCallback(async (row: Row) => {
    setBusy(row.id)
    setFailed('')
    try {
      const response = await fetch('/api/m/unified-inbox/blocked-senders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: row.address, blocked: false }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        setFailed(body?.error ?? 'They were not let through.')
        return
      }
      changed.current = true
      setRows((current) => (current ?? []).filter((r) => r.id !== row.id))
      setNote(`${row.address} can get through again.`)
    } catch {
      setFailed('The site could not be reached, so nothing changed.')
    } finally {
      setBusy(null)
    }
  }, [])

  const nameOf = (id: string | null): string | null =>
    (id ? staff.find((s) => s.id === id)?.name ?? null : null)

  // Into the page itself rather than where it is written: this sits in the head
  // of a column that scrolls its own contents, and a dialog inside one of those
  // is a dialog clipped by it.
  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="uin-modal"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}
    >
      <div
        ref={card}
        className="uin-modal-card uin-modal-card-short"
        role="dialog"
        aria-modal="true"
        aria-label="Blocked addresses"
        tabIndex={-1}
      >
        <div className="uin-modal-head">
          <h2 className="uin-modal-title">Blocked addresses</h2>
          <button
            type="button"
            className="uin-modal-close"
            aria-label="Close"
            title="Close"
            onClick={close}
          >
            {CloseIcon}
          </button>
        </div>

        <div className="uin-modal-body">
          {failed && <div className="alert alert-danger" role="alert">{failed}</div>}
          {note && <div className="alert alert-success" role="status">{note}</div>}

          {rows === null && <p className="uin-recipients">Looking...</p>}

          {rows !== null && rows.length === 0 && !failed && (
            <p className="uin-recipients">
              Nobody is blocked. Open a conversation and press the junk button at the top of it,
              and you will be asked whether to turn the sender away in future too.
            </p>
          )}

          {rows !== null && rows.length > 0 && (
            <>
              <p className="uin-recipients">
                Post from these addresses is collected and dropped straight in here, marked as
                dealt with and left unread. It never reaches an inbox, shared or personal. Nothing
                of theirs was deleted - their old conversations are exactly where they were.
              </p>
              <ul className="uin-blocked-list">
                {rows.map((row) => {
                  const by = nameOf(row.blockedByUserId)
                  return (
                    <li key={row.id} className="uin-blocked-row">
                      <span className="uin-blocked-main">
                        {/* Allowed to run out of room and end in an ellipsis, so
                            one very long address cannot stretch the dialog; the
                            whole of it stays on the tooltip. */}
                        <span className="uin-blocked-address" title={row.address}>{row.address}</span>
                        <span className="uin-blocked-sub">
                          {whenBlocked(row.createdAt)}{by ? ` by ${by}` : ''}
                        </span>
                      </span>
                      {canUnblock && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={busy !== null}
                          onClick={() => { void unblock(row) }}
                        >
                          Let them through
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
              {!canUnblock && (
                <p className="uin-recipients">
                  Letting somebody back in needs permission to reply, since it changes what the
                  whole site receives from then on.
                </p>
              )}
            </>
          )}
        </div>

        <div className="uin-modal-foot">
          <button type="button" className="btn btn-primary btn-sm" onClick={close}>Done</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** The date in the site's own reading of it. "Blocked 3 September 2026" -
 *  vague enough to be readable and exact enough to answer "was that before or
 *  after they rang?". A date the browser cannot make sense of says nothing at
 *  all rather than "Invalid Date", which is the sort of thing that makes a site
 *  look unfinished. */
function whenBlocked(iso: string): string {
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return 'Blocked'
  return `Blocked ${when.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`
}
