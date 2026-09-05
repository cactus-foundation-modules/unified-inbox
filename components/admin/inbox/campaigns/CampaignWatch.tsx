'use client'

import { useCallback, useEffect, useState } from 'react'
import { RECIPIENT_STATES, type RecipientState } from '@/modules/unified-inbox/lib/campaigns/types'
import { campaignApi, when, type CampaignDetail, type RecipientView } from './api'

// Watching it go: everybody on the campaign and where they have got to.
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
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const result = await campaignApi.recipients(campaignId, { state, q: search || null, page })
    if (!result.ok) { setError(result.error); return }
    setRows(result.data.rows)
    setTotal(result.data.total)
    setError('')
  }, [campaignId, page, search, state])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async loader; every setState runs after an await
  useEffect(() => { void load() }, [load])

  const tally = detail.tally
  const pages = Math.max(1, Math.ceil(total / 50))

  return (
    <div className="uin-camp-step">
      <h3>
        Where everybody has got to
        <small>{(tally.total).toLocaleString('en-GB')} on this campaign</small>
      </h3>

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

      {rows.length === 0
        ? <div className="uin-empty">Nobody here{state ? ' in that state' : ''}.</div>
        : (
          <div className="uin-camp-scroll">
            <table className="uin-camp-table">
              <thead>
                <tr>
                  <th scope="col">Who</th>
                  <th scope="col">Address</th>
                  <th scope="col">State</th>
                  <th scope="col">Last sent</th>
                  <th scope="col">Notes</th>
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
                    <td>{when(row.lastSentAt, detail.timezone) || '-'}</td>
                    <td>{row.reason ?? ''}</td>
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
