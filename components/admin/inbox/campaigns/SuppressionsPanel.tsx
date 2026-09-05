'use client'

import { useCallback, useEffect, useState } from 'react'
import { campaignApi } from './api'

// The do-not-email list.
//
// Global and permanent on purpose: deleting a campaign must never quietly
// re-permit mail to somebody who unsubscribed from it. It is visible here so
// that "why is that customer not getting anything" has an answer somebody can
// look up, and removable because an address that bounced during an outage works
// again on Thursday.

const REASONS: Record<string, string> = {
  unsubscribed: 'They unsubscribed',
  bounced: 'The address bounced',
  complained: 'They marked it as spam',
  manual: 'Added by hand',
}

export function SuppressionsPanel({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<Array<{ id: string; address: string; reason: string; note: string | null; createdAt: string }>>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    const result = await campaignApi.suppressions({ q: search || null, page })
    if (!result.ok) { setError(result.error); return }
    setRows(result.data.rows)
    setTotal(result.data.total)
    setError('')
  }, [page, search])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async loader; every setState runs after an await
  useEffect(() => { void load() }, [load])

  const add = async () => {
    const address = adding.trim()
    if (!address) return
    const result = await campaignApi.suppress(address, 'Added by hand.')
    if (!result.ok) { setError(result.error); return }
    setAdding('')
    setNotice(result.data.cleared > 0
      ? `Added. They have also been taken out of ${result.data.cleared} campaign queue${result.data.cleared === 1 ? '' : 's'}.`
      : 'Added.')
    await load()
  }

  const remove = async (id: string) => {
    const result = await campaignApi.unsuppress(id)
    if (!result.ok) { setError(result.error); return }
    setNotice('Taken off the list. Campaigns may write to that address again.')
    await load()
  }

  const pages = Math.max(1, Math.ceil(total / 50))

  return (
    <>
      <div className="uin-camp-head">
        <div>
          <h2>Do-not-email list</h2>
          <div className="uin-camp-meta">
            <span>{total.toLocaleString('en-GB')} addresses no campaign will ever write to</span>
          </div>
        </div>
        <div className="uin-camp-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onBack}>Back to campaigns</button>
        </div>
      </div>

      {error && <div className="alert alert-danger" role="alert">{error}</div>}
      {notice && <div className="alert alert-info" role="status">{notice}</div>}

      <div className="uin-camp-step">
        <h3>Add one <small>Somebody who has asked you directly</small></h3>
        <div className="uin-camp-row">
          <div className="uin-camp-field" style={{ flex: '2 1 16rem' }}>
            <input
              className="form-control"
              type="email"
              value={adding}
              placeholder="them@theircompany.co.uk"
              onChange={(event) => setAdding(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void add() }}
            />
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void add()}>Add to the list</button>
        </div>
        <span className="uin-camp-hint">
          This stops campaigns only. Replies, order confirmations and anything they have specifically asked you for
          still go out as normal - which is right, and is what the law expects.
        </span>
      </div>

      <div className="uin-camp-step">
        <div className="uin-camp-row">
          <div className="uin-camp-field" style={{ flex: '2 1 14rem' }}>
            <input
              className="form-control"
              value={search}
              placeholder="Find an address"
              onChange={(event) => { setSearch(event.target.value); setPage(1) }}
            />
          </div>
        </div>

        {rows.length === 0
          ? <div className="uin-empty">Nobody on it yet.</div>
          : (
            <div className="uin-camp-scroll">
              <table className="uin-camp-table">
                <thead>
                  <tr>
                    <th scope="col">Address</th>
                    <th scope="col">Why</th>
                    <th scope="col">Since</th>
                    <th scope="col"><span className="sr-only">Remove</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.address}</td>
                      <td>{REASONS[row.reason] ?? row.reason}{row.note && <><br /><span className="uin-camp-preview-to">{row.note}</span></>}</td>
                      <td>{new Date(row.createdAt).toLocaleDateString('en-GB')}</td>
                      <td>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void remove(row.id)}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

        {pages > 1 && (
          <div className="uin-camp-actions">
            <button type="button" className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Back</button>
            <span className="uin-camp-hint">Page {page} of {pages}</span>
            <button type="button" className="btn btn-secondary btn-sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
          </div>
        )}
      </div>
    </>
  )
}
