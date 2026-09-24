'use client'

import { useCallback, useEffect, useState } from 'react'
import { formatFull, formatWhen } from '@/modules/unified-inbox/lib/list'
import type { HistoryEventKind } from '@/modules/unified-inbox/lib/receipts'
import { TickIcon } from './icons'

// ---------------------------------------------------------------------------
// What became of a reply once it left - the label, and the whole story behind
// it.
//
// The labels under a sent message say the strongest thing known: Delivered,
// Opened, Followed a link. The wording is fussier than it looks, and
// deliberately. A mail app fetching the invisible picture in a message is not
// a person reading it, and somebody deciding whether to ring a customer who
// has "read" their quote deserves to know which of the two happened.
//
// Pressing a label opens the ledger behind it: every event, in order, with the
// moment and the network address it came from. The address is the whole point.
// An "open" three seconds after delivery from a cloud provider's range is the
// recipient's mail security looking the message over, and a person is far
// more likely to be the one from a phone company an hour later. Nothing here
// decides that for the reader; it puts the two facts side by side and lets
// them.
//
// Every message on a site with receipts switched off has none of these, and
// this renders nothing.
// ---------------------------------------------------------------------------

export type DeliveryReceiptView = {
  deliveredAt: Date | string | null
  openedAt: Date | string | null
  lastOpenAt: Date | string | null
  openCount: number
  openSource: string | null
  clickedAt: Date | string | null
  lastClickAt: Date | string | null
  clickCount: number
  bouncedAt: Date | string | null
  bounceKind: string | null
}

type HistoryRow = {
  id: string | null
  kind: HistoryEventKind
  source: 'brevo' | 'receipt'
  occurredAt: string
  detail: string | null
  ip: string | null
  userAgent: string | null
}

type HistoryAnswer = { live: boolean; note: string | null; events: HistoryRow[] }

const KIND_LABELS: Record<HistoryEventKind, string> = {
  sent: 'Taken by the email service',
  delivered: 'Delivered',
  opened: 'Opened',
  proxy_open: 'Their email app fetched it',
  clicked: 'Followed a link',
  bounced: 'Turned away',
  receipt: 'Their email program confirmed it was read',
  receipt_unread: 'Their email program said it was deleted unread',
}

/** Which of the labels' colours a line takes. The strong ones are the ones a
 *  person did; a machine fetching a picture stays plain. */
function toneOf(kind: HistoryEventKind): string {
  if (kind === 'opened' || kind === 'clicked' || kind === 'receipt') return 'uin-history-done'
  if (kind === 'bounced' || kind === 'receipt_unread') return 'uin-history-failed'
  return ''
}

const HARD_BOUNCES = ['hard', 'blocked', 'invalid', 'spam', 'error']

export function DeliveryHistory({
  messageId, receipt, now, timezone,
}: {
  messageId: string
  receipt: DeliveryReceiptView
  now: Date
  timezone: string
}) {
  const [open, setOpen] = useState(false)

  const hardBounce = receipt.bouncedAt && HARD_BOUNCES.includes(receipt.bounceKind ?? '')
  const softBounce = receipt.bouncedAt && !hardBounce

  const show = () => setOpen(true)
  const hide = useCallback(() => setOpen(false), [])

  return (
    <>
      {hardBounce && (
        // Whatever the far end said about it is kept off the label on purpose.
        // It is written for whoever runs a mail server, and a site owner reading
        // it learns nothing except that something technical went wrong.
        <button
          type="button"
          className="uin-tag uin-tag-failed uin-tag-btn"
          title="The address turned it away. It is worth checking it is spelt right, or reaching them another way. Press for the full history."
          onClick={show}
        >
          It did not arrive
        </button>
      )}
      {softBounce && (
        <button
          type="button"
          className="uin-tag uin-tag-btn"
          title="Something at the other end is holding it up. It may still get through on its own. Press for the full history."
          onClick={show}
        >
          Held up on the way
        </button>
      )}
      {receipt.clickedAt && (
        <button
          type="button"
          className="uin-tag uin-tag-done uin-tag-btn"
          title={
            `A link in it was followed: ${formatFull(receipt.clickedAt, timezone)}`
            + (receipt.clickCount > 1 ? ` - ${receipt.clickCount} in all, the last one ${formatFull(receipt.lastClickAt, timezone)}` : '')
            + '. Worth knowing: some office email systems check every link in a message when it arrives, so several at once within a minute of it landing is more likely to be their security than them. Press for the full history.'
          }
          onClick={show}
        >
          {TickIcon} Followed a link {formatWhen(receipt.clickedAt, now, timezone)}
          {receipt.clickCount > 1 ? ` (${receipt.clickCount} times)` : ''}
        </button>
      )}
      {receipt.openedAt ? (
        <button
          type="button"
          className="uin-tag uin-tag-done uin-tag-btn"
          title={
            (receipt.openSource === 'receipt'
              ? `Their email program confirmed it: ${formatFull(receipt.openedAt, timezone)}`
              : `First opened ${formatFull(receipt.openedAt, timezone)}`)
            + '. Press for the full history.'
          }
          onClick={show}
        >
          {TickIcon} Opened {formatWhen(receipt.openedAt, now, timezone)}
          {receipt.openCount > 1 ? ` (${receipt.openCount} times)` : ''}
        </button>
      ) : receipt.openSource === 'proxy' ? (
        <button
          type="button"
          className="uin-tag uin-tag-btn"
          title="Their email program downloaded the pictures in the message, which it often does before anybody has looked at it. Not proof that it was read. Press for the full history."
          onClick={show}
        >
          Their email app fetched it
        </button>
      ) : receipt.deliveredAt && !hardBounce ? (
        <button
          type="button"
          className="uin-tag uin-tag-btn"
          title={`Delivered ${formatFull(receipt.deliveredAt, timezone)}. Press for the full history.`}
          onClick={show}
        >
          Delivered {formatWhen(receipt.deliveredAt, now, timezone)}
        </button>
      ) : null}

      {open && <HistoryDialog messageId={messageId} timezone={timezone} onClose={hide} />}
    </>
  )
}

function HistoryDialog({ messageId, timezone, onClose }: { messageId: string; timezone: string; onClose: () => void }) {
  const [answer, setAnswer] = useState<HistoryAnswer | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // The dialog is mounted fresh on every press and unmounted on close, so the
  // state starts empty on its own and nothing needs resetting here.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/m/unified-inbox/messages/${encodeURIComponent(messageId)}/receipts`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
      .then(async (res) => {
        const body = await res.json().catch(() => null) as (HistoryAnswer & { error?: string }) | null
        if (!res.ok || !body) throw new Error(body?.error || 'The history could not be fetched just now.')
        return body
      })
      .then((body) => { if (!cancelled) setAnswer(body) })
      .catch((err: unknown) => {
        if (!cancelled) setFailure(err instanceof Error ? err.message : 'The history could not be fetched just now.')
      })
    return () => { cancelled = true }
  }, [messageId])

  return (
    <div
      className="uin-modal"
      role="dialog"
      aria-modal="true"
      aria-label="What became of this message"
      // Only a press that both starts and ends on the backdrop closes it, so a
      // drag that began on an address and ended outside does not.
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className="uin-modal-card uin-history-card">
        <div className="uin-modal-head">
          <strong>What became of this message</strong>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
        </div>

        <div className="uin-modal-body">
          {!answer && !failure && <p className="uin-camp-hint" style={{ margin: 0 }}>Asking the email service what it remembers...</p>}

          {failure && (
            <div className="alert alert-danger" role="alert">{failure}</div>
          )}

          {answer && answer.events.length === 0 && (
            <p className="uin-camp-hint" style={{ margin: 0 }}>
              Nothing has been reported about this message yet.
            </p>
          )}

          {answer && answer.events.length > 0 && (
            <ol className="uin-history">
              {answer.events.map((event, index) => (
                <li key={event.id ?? `${event.kind}-${event.occurredAt}-${index}`} className={`uin-history-row ${toneOf(event.kind)}`}>
                  <div className="uin-history-what">
                    <b>{KIND_LABELS[event.kind] ?? event.kind}</b>
                    <span className="uin-history-when" title={event.occurredAt}>
                      {formatFullWithSeconds(event.occurredAt, timezone)}
                    </span>
                  </div>
                  <div className="uin-history-from">
                    {event.ip
                      ? <code className="uin-history-ip">{event.ip}</code>
                      : <span className="uin-camp-hint">{addressMissing(event.kind)}</span>}
                    {event.userAgent && <span className="uin-history-agent" title={event.userAgent}>{event.userAgent}</span>}
                  </div>
                  {event.detail && (
                    <div className="uin-history-detail">
                      {event.kind === 'clicked' ? <code className="uin-peek-url">{event.detail}</code> : event.detail}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}

          {answer?.note && (
            <div className="alert alert-info" role="note">{answer.note}</div>
          )}

          {answer && answer.events.length > 0 && (
            <p className="uin-camp-hint" style={{ margin: 0 }}>
              The address on a delivery is the email service&apos;s own machine handing the message over,
              not the person it went to. On an open or a followed link it is whoever fetched the
              message - and within a minute of it landing, from a cloud or office network, that is
              usually their email security looking it over rather than them. A person tends to turn
              up later, from somewhere ordinary.
            </p>
          )}
        </div>

        <div className="uin-modal-foot">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

/** Why there is no address on a line. A delivery reported by the webhook alone
 *  never had one; an open the report could not be asked about is the other
 *  case, and the note under the list says why. */
function addressMissing(kind: HistoryEventKind): string {
  if (kind === 'receipt' || kind === 'receipt_unread') return 'Sent back by their email program'
  return 'No address reported'
}

/** The full date with seconds on the end. The list beside the message stops
 *  at minutes; here two events three seconds apart are the whole story. */
function formatFullWithSeconds(value: string, timezone: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(date)
  } catch {
    return formatFull(date, timezone)
  }
}
