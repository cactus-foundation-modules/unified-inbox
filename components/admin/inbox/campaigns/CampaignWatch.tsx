'use client'

import { useCallback, useEffect, useState } from 'react'
import { RECIPIENT_STATES, type RecipientState } from '@/modules/unified-inbox/lib/campaigns/types'
import {
  campaignApi,
  when,
  type CampaignDetail,
  type EngagementFilterView,
  type RecipientView,
} from './api'

// Watching it go: everybody on the campaign and where they have got to.
//
// And what became of it, person by person: when it arrived, when they read it,
// whether they followed a link, whether they unsubscribed. Each is the FIRST
// time it happened across every step they were sent, because "did they ever
// open any of it" is the question and four columns per follow-up is a table
// nobody reads. "Arrived" is the mail service saying so where it does (Brevo);
// over a mailbox's own server nobody says so, and an open or a click - which
// cannot happen to an email that did not arrive - stands in for it.
//
// The filter is the useful half. "Show me the ones that bounced" is what
// somebody actually opens this for, and it is answered by an index rather than
// by reading five thousand rows - which is why it is a state rather than a
// search across states.

const LABELS: Record<RecipientState, string> = {
  queued: 'Waiting',
  sending: 'Going out',
  replied: 'Replied',
  unsubscribed: 'Unsubscribed',
  bounced: 'Bad address',
  complained: 'Marked as spam',
  failed: 'Did not send',
  skipped: 'Left out',
  done: 'Sent',
}

/** What came of pressing Send now, said the way somebody would say it. Every
 *  one of these is an ordinary outcome rather than a failure - a person who
 *  unsubscribed last week is skipped, and that is the system working. */
const SENT_WORD: Record<'sent' | 'failed' | 'skipped' | 'paused', string> = {
  sent: 'Gone.',
  failed: 'That one would not send. The reason is in its row.',
  skipped: 'Not sent - they have unsubscribed, replied, or already had this one.',
  paused: 'The campaign stopped itself instead. The reason is at the top of the page.',
}

export function CampaignWatch({
  campaignId, detail, onReload,
}: {
  campaignId: string
  detail: CampaignDetail
  onReload: () => Promise<void>
}) {
  const [rows, setRows] = useState<RecipientView[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [state, setState] = useState<RecipientState | null>(null)
  /** The "who read it" slice, which narrows the list on its own or beside a
   *  state. Pressing a number above the table sets it. */
  const [engagement, setEngagement] = useState<EngagementFilterView | null>(null)
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  /** Which row's Send now is in flight. One at a time on purpose - the address
   *  sends one at a time whatever this screen does, so two presses would only
   *  produce one send and one confusing refusal. */
  const [sending, setSending] = useState<string | null>(null)

  // What the campaign looked like when the page above last read it. In the
  // dependencies below so that topping the list up, pausing or resuming reloads
  // this table too - the page no longer remounts on a reload, which is what used
  // to refresh it, and a progress table that disagrees with the counts directly
  // above it is worse than no progress table.
  const stamp = `${detail.campaign.updatedAt}|${detail.tally.total}|${detail.tally.done}`

  const load = useCallback(async () => {
    const result = await campaignApi.recipients(campaignId, { state, engagement, q: search || null, page })
    if (!result.ok) { setError(result.error); return }
    setRows(result.data.rows)
    setTotal(result.data.total)
    setError('')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `stamp` is a reload trigger, not something the query reads
  }, [campaignId, engagement, page, search, state, stamp])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async loader; every setState runs after an await
  useEffect(() => { void load() }, [load])

  const sendNow = async (recipientId: string) => {
    setSending(recipientId)
    setError('')
    setNotice('')
    const result = await campaignApi.sendNow(campaignId, recipientId)
    setSending(null)
    if (!result.ok) { setError(result.error); return }
    setNotice(SENT_WORD[result.data.outcome])
    await load()
    await onReload()
  }

  const tally = detail.tally
  const reach = detail.engagement
  const pick = (next: EngagementFilterView | null) => {
    setEngagement((current) => (current === next ? null : next))
    setPage(1)
  }
  const pages = Math.max(1, Math.ceil(total / 50))
  // Nothing goes out of a draft by hand: everything that stands between a draft
  // and a real customer is checked when somebody presses start.
  const canSendNow = detail.campaign.status === 'running' || detail.campaign.status === 'paused'

  return (
    <div className="uin-camp-section">
      <h3>
        Where everybody has got to
        <small>{(tally.total).toLocaleString('en-GB')} on this campaign</small>
      </h3>

      {/* The headline numbers, once anything has gone. Each one narrows the
          table to the people it counts; pressing it again shows everybody. */}
      {reach.sent > 0 && (
        <div className="uin-camp-stats">
          <div className="uin-camp-stat">
            <b>{reach.sent.toLocaleString('en-GB')}</b>
            <span>Sent</span>
          </div>
          <div className="uin-camp-stat">
            <b>{reach.delivered.toLocaleString('en-GB')}</b>
            <span>Known to have arrived</span>
          </div>
          <button type="button" className="uin-camp-stat" aria-pressed={engagement === 'opened'} onClick={() => pick('opened')}>
            <b>{reach.opened.toLocaleString('en-GB')}</b>
            <span>Opened ({percent(reach.opened, reach.sent)})</span>
          </button>
          <button type="button" className="uin-camp-stat" aria-pressed={engagement === 'unopened'} onClick={() => pick('unopened')}>
            <b>{(reach.sent - reach.opened).toLocaleString('en-GB')}</b>
            <span>Not opened yet</span>
          </button>
          <button type="button" className="uin-camp-stat" aria-pressed={engagement === 'clicked'} onClick={() => pick('clicked')}>
            <b>{reach.clicked.toLocaleString('en-GB')}</b>
            <span>Followed a link</span>
          </button>
          <button type="button" className="uin-camp-stat" aria-pressed={engagement === 'unsubscribed'} onClick={() => pick('unsubscribed')}>
            <b>{reach.unsubscribed.toLocaleString('en-GB')}</b>
            <span>Unsubscribed</span>
          </button>
        </div>
      )}
      {reach.sent > 0 && (
        <span className="uin-camp-hint">
          Opens are counted by a tiny picture in the email, so somebody whose mail program does not load pictures
          reads it without being counted - treat the opened figure as at least, not exactly.
        </span>
      )}

      <div className="uin-camp-filters">
        <button
          type="button"
          className={`btn btn-sm ${state === null ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => { setState(null); setPage(1) }}
        >
          Everybody
        </button>
        {RECIPIENT_STATES.filter((s) => tally[s] > 0).map((s) => (
          <button
            key={s}
            type="button"
            className={`btn btn-sm ${state === s ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => { setState(s); setPage(1) }}
          >
            {LABELS[s]} ({tally[s].toLocaleString('en-GB')})
          </button>
        ))}
      </div>

      <div className="uin-camp-row">
        <div className="uin-camp-field" style={{ flex: '2 1 14rem' }}>
          <input
            className="form-control"
            value={search}
            placeholder="Find a name, address or company"
            onChange={(event) => { setSearch(event.target.value); setPage(1) }}
          />
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => { void load(); void onReload() }}>
          Refresh
        </button>
      </div>

      {error && <div className="alert alert-danger" role="alert">{error}</div>}
      {notice && <div className="alert alert-info" role="status">{notice}</div>}

      {rows.length === 0
        ? <div className="uin-empty">Nobody here{state || engagement ? ' in that state' : ''}.</div>
        : (
          <div className="uin-camp-scroll">
            <table className="uin-camp-table">
              <thead>
                <tr>
                  <th scope="col">Who</th>
                  <th scope="col">Address</th>
                  <th scope="col">State</th>
                  <th scope="col">Sent</th>
                  <th scope="col">Arrived</th>
                  <th scope="col">Opened</th>
                  <th scope="col">Clicked</th>
                  <th scope="col">Unsubscribed</th>
                  <th scope="col">Notes</th>
                  <th scope="col"><span className="sr-only">Send now</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.displayName || [row.firstName, row.lastName].filter(Boolean).join(' ') || '-'}
                      {row.organisationName && <><br /><span className="uin-camp-preview-to">{row.organisationName}</span></>}
                    </td>
                    <td>{row.address}</td>
                    <td data-state={row.state}>
                      {LABELS[row.state]}
                      {row.state === 'queued' && row.stepIndex > 0 && ` (follow-up ${row.stepIndex})`}
                    </td>
                    <Moment value={row.firstSentAt ?? row.lastSentAt} timezone={detail.timezone} />
                    <Moment value={row.deliveredAt} timezone={detail.timezone} />
                    <Moment value={row.openedAt} timezone={detail.timezone} />
                    <Moment value={row.clickedAt} timezone={detail.timezone} />
                    <Moment value={row.unsubscribedAt} timezone={detail.timezone} />
                    <td>{row.reason ?? ''}</td>
                    <td>
                      {row.state === 'queued' && canSendNow && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={sending !== null}
                          onClick={() => void sendNow(row.id)}
                        >
                          {sending === row.id ? 'Sending…' : 'Send now'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      {pages > 1 && (
        <div className="uin-camp-actions">
          <button type="button" className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Back
          </button>
          <span className="uin-camp-hint">Page {page} of {pages}</span>
          <button type="button" className="btn btn-secondary btn-sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      )}
    </div>
  )
}

/** One "when" cell: the moment, or a quiet dash for not yet. */
function Moment({ value, timezone }: { value: string | null | undefined; timezone: string }) {
  const said = when(value, timezone)
  return <td className="uin-camp-when" data-empty={said ? 'false' : 'true'}>{said || '-'}</td>
}

function percent(part: number, whole: number): string {
  if (whole <= 0) return '0%'
  return `${Math.round((part / whole) * 100)}%`
}
