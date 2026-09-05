'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { inboxHref } from '@/modules/unified-inbox/lib/list'
import { campaignApi, when, type CampaignListRow } from './api'
import { CampaignEditor } from './CampaignEditor'
import { CampaignTicker } from './CampaignTicker'
import { SuppressionsPanel } from './SuppressionsPanel'

// The Campaigns tab.
//
// Everything on it is fetched rather than server-rendered, which is the one
// place this module departs from the rest of the hub - and it is deliberate. A
// campaign screen is a thing somebody sits in front of while it works: the
// count goes up, the next send time moves, a bounce turns a row red. Rendering
// that from the query string would mean a full page refresh every ninety
// seconds, and the tab it lives in belongs to core.
//
// The address bar still carries which campaign is open and which step, so a
// colleague can be sent a link and the back button behaves.

export type CampaignInbox = { id: string; name: string; address: string }
export type CampaignCategory = { id: string; name: string }

type Props = {
  base: string
  params: Record<string, string>
  inboxes: CampaignInbox[]
  categories: CampaignCategory[]
  /** Which campaign is open, from the address bar. */
  campaignId: string | null
  /** Which step of it, or 'suppressions' for the do-not-email list. */
  view: string | null
  /** The address a pinger can be pointed at, with its key already in it. Shown
   *  once, on the campaign that is running, because the pace of the whole
   *  feature depends on somebody knowing it exists. */
  tickUrl: string | null
}

export function CampaignsPanel({ base, params, inboxes, categories, campaignId, view, tickUrl }: Props) {
  const router = useRouter()
  const [rows, setRows] = useState<CampaignListRow[] | null>(null)
  const [timezone, setTimezone] = useState('UTC')
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const load = useCallback(async () => {
    const result = await campaignApi.list()
    if (!result.ok) {
      setError(result.error)
      return
    }
    setRows(result.data.campaigns)
    setTimezone(result.data.timezone)
    setError('')
  }, [])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async loader; every setState runs after an await
  useEffect(() => { void load() }, [load])

  const go = useCallback((changes: Record<string, string | null>) => {
    router.push(inboxHref(base, params, { id: null, person: null, ...changes }))
  }, [base, params, router])

  const create = useCallback(async () => {
    const name = newName.trim()
    if (!name) return
    // The address is chosen on the Who step. Starting with the first one the
    // person may send from is a sensible guess and saves a click on the site
    // where there is only one.
    const result = await campaignApi.create(name, inboxes[0]?.id ?? null)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setCreating(false)
    setNewName('')
    go({ campaign: result.data.id, view: 'who' })
  }, [go, inboxes, newName])

  // Anything running keeps the screen honest: the counts move while somebody
  // watches, and the ticker below is what actually moves them.
  const anyRunning = (rows ?? []).some((row) => row.status === 'running')

  if (view === 'suppressions') {
    return <SuppressionsPanel onBack={() => go({ view: null, campaign: null })} />
  }

  if (campaignId) {
    return (
      <>
        {anyRunning && <CampaignTicker onTick={load} />}
        <CampaignEditor
          campaignId={campaignId}
          inboxes={inboxes}
          categories={categories}
          step={view ?? 'who'}
          tickUrl={tickUrl}
          onStep={(next) => go({ campaign: campaignId, view: next })}
          onClose={() => { void load(); go({ campaign: null, view: null }) }}
        />
      </>
    )
  }

  return (
    <>
      {anyRunning && <CampaignTicker onTick={load} />}

      <div className="uin-camp-head">
        <h2>Campaigns</h2>
        <div className="uin-camp-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => go({ view: 'suppressions' })}>
            Do-not-email list
          </button>
          {inboxes.length > 0 && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              New campaign
            </button>
          )}
        </div>
      </div>

      {error && <div className="alert alert-danger" role="alert">{error}</div>}

      {creating && (
        <div className="uin-camp-step">
          <h3>What is this one called? <small>Only you see this</small></h3>
          <div className="uin-camp-row">
            <div className="uin-camp-field" style={{ flex: '2 1 16rem' }}>
              <input
                className="form-control"
                value={newName}
                autoFocus
                placeholder="September chair offer"
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void create() }}
              />
            </div>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void create()}>Start writing it</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </div>
      )}

      {inboxes.length === 0 && (
        <div className="uin-empty">
          <strong>No address to send from</strong>
          You need an address you are allowed to send from before you can write a campaign.
          Ask whoever looks after the site to give you one.
        </div>
      )}

      {rows === null && inboxes.length > 0 && <div className="uin-empty">Looking&hellip;</div>}

      {rows !== null && rows.length === 0 && inboxes.length > 0 && !creating && (
        <div className="uin-empty">
          <strong>No campaigns yet</strong>
          A campaign sends the same email to a list of your contacts, one at a time, slowly, inside working
          hours - so it reads as a person writing rather than a mailshot. Write one and see.
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <ul className="uin-camp-list">
          {rows.map((row) => (
            <li key={row.id}>
              <CampaignCard
                row={row}
                timezone={timezone}
                inbox={inboxes.find((i) => i.id === row.inboxId) ?? null}
                onOpen={() => go({ campaign: row.id, view: 'who' })}
                onChanged={load}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function CampaignCard({
  row, timezone, inbox, onOpen, onChanged,
}: {
  row: CampaignListRow
  timezone: string
  inbox: CampaignInbox | null
  onOpen: () => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const act = async (action: 'pause' | 'resume' | 'stop') => {
    setBusy(true)
    setError('')
    const result = await campaignApi.state(row.id, action)
    setBusy(false)
    if (!result.ok && !result.needsAcceptance) {
      setError(result.error)
      return
    }
    onChanged()
  }

  const sent = row.tally.done + row.tally.replied + row.tally.bounced
    + row.tally.complained + row.tally.failed + row.tally.unsubscribed
  const total = Math.max(1, row.tally.total - row.tally.skipped)
  const pct = (value: number) => `${Math.round((value / total) * 100)}%`

  return (
    <div className="uin-camp-card" data-state={row.status}>
      <div className="uin-camp-card-top">
        <button type="button" className="uin-camp-name" onClick={onOpen}>{row.name}</button>
        <span className="uin-camp-pill" data-state={row.status}>{statusWord(row)}</span>
      </div>

      <div className="uin-camp-bar" role="img" aria-label={`${sent} of ${total} sent`}>
        <span data-kind="done" style={{ width: pct(row.tally.done) }} />
        <span data-kind="replied" style={{ width: pct(row.tally.replied) }} />
        <span data-kind="bad" style={{ width: pct(row.tally.bounced + row.tally.complained + row.tally.failed) }} />
        <span data-kind="off" style={{ width: pct(row.tally.unsubscribed) }} />
      </div>

      <div className="uin-camp-legend">
        <span><b>{sent.toLocaleString('en-GB')}</b> of {(row.tally.total - row.tally.skipped).toLocaleString('en-GB')} sent</span>
        {row.tally.replied > 0 && <span><b>{row.tally.replied.toLocaleString('en-GB')}</b> replied</span>}
        {row.tally.bounced + row.tally.complained > 0 && (
          <span><b>{(row.tally.bounced + row.tally.complained).toLocaleString('en-GB')}</b> did not arrive</span>
        )}
        {row.tally.unsubscribed > 0 && <span><b>{row.tally.unsubscribed.toLocaleString('en-GB')}</b> unsubscribed</span>}
      </div>

      <div className="uin-camp-meta">
        {inbox && <span>From {inbox.address}</span>}
        {row.finishesAbout && <span>Finishes about {when(row.finishesAbout, timezone)}</span>}
        {row.status === 'paused' && row.pauseReason && <span>{row.pauseReason}</span>}
      </div>

      {error && <div className="alert alert-danger" role="alert">{error}</div>}

      <div className="uin-camp-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onOpen}>Open</button>
        {row.status === 'running' && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void act('pause')}>
            Pause
          </button>
        )}
        {row.status === 'paused' && (
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void act('resume')}>
            Resume
          </button>
        )}
        {(row.status === 'running' || row.status === 'paused') && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void act('stop')}>
            Stop for good
          </button>
        )}
      </div>
    </div>
  )
}

function statusWord(row: CampaignListRow): string {
  switch (row.status) {
    case 'running': return 'Sending'
    case 'paused': return row.pauseKind === 'manual' ? 'Paused' : 'Stopped itself'
    case 'draft': return 'Draft'
    case 'stopped': return 'Stopped'
    case 'done': return 'Finished'
  }
}
