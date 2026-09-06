'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { inboxHref } from '@/modules/unified-inbox/lib/list'
import { campaignApi, when, type CampaignListRow } from './api'
import { CampaignEditor } from './CampaignEditor'
import { CampaignTicker } from './CampaignTicker'
import { MegaphoneIcon } from '../icons'
import { SuppressionsPanel } from './SuppressionsPanel'

// The Campaigns tab.
//
// Laid out the way the post is, because it is the same shape: every campaign
// down the list column, the one that is open in the reading pane beside it.
// It was a full-width form with a Back button on top of it, which meant that
// glancing at what another campaign was doing cost you the one you were in.
//
// Everything on it is fetched rather than server-rendered, which is the one
// place this module departs from the rest of the hub - and it is deliberate. A
// campaign screen is a thing somebody sits in front of while it works: the
// count goes up, the next send time moves, a bounce turns a row red. Rendering
// that from the query string would mean a full page refresh every ninety
// seconds, and the tab it lives in belongs to core.
//
// The address bar still carries which campaign is open, so a colleague can be
// sent a link and the back button behaves.
//
// It renders TWO grid children of the frame - the list column and the reading
// pane - out of one fragment, so the frame above can stay the same three
// columns the inbox has.

export type CampaignInbox = { id: string; name: string; address: string }
export type CampaignCategory = { id: string; name: string }

type Props = {
  base: string
  params: Record<string, string>
  inboxes: CampaignInbox[]
  categories: CampaignCategory[]
  /** Which campaign is open, from the address bar. */
  campaignId: string | null
  /** Only 'suppressions' means anything now: the do-not-email list is the one
   *  thing on this screen that is not a campaign. Links made before the editor
   *  became one page carry who/what/when/watch/progress, and every one of them
   *  now opens the campaign itself, which is where all of that lives. */
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
    go({ campaign: result.data.id, view: null })
  }, [go, inboxes, newName])

  // Anything running keeps the screen honest: the counts move while somebody
  // watches, and the ticker below is what actually moves them.
  const anyRunning = (rows ?? []).some((row) => row.status === 'running')
  const suppressing = view === 'suppressions'

  return (
    <>
      <div className="uin-col">
        <div className="uin-col-head">
          <div className="uin-col-title">
            <h2>Campaigns</h2>
            <span className="uin-col-total">
              {rows === null ? '' : rows.length === 1 ? '1 campaign' : `${rows.length.toLocaleString('en-GB')} campaigns`}
            </span>
          </div>

          <div className="uin-camp-actions">
            {inboxes.length > 0 && (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
                New campaign
              </button>
            )}
            <button
              type="button"
              className={`btn btn-sm ${suppressing ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => go({ campaign: null, view: suppressing ? null : 'suppressions' })}
            >
              Do-not-email list
            </button>
          </div>

          {/* Naming it happens where the list is, because that is what it adds
              a row to. It opens on the right the moment it is named. */}
          {creating && (
            <div className="uin-camp-new">
              <label className="sr-only" htmlFor="uin-camp-new-name">What this campaign is called - only you see it</label>
              <input
                id="uin-camp-new-name"
                className="form-control"
                value={newName}
                autoFocus
                placeholder="September chair offer"
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void create()
                  if (event.key === 'Escape') setCreating(false)
                }}
              />
              <div className="uin-camp-actions">
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void create()}>Start writing it</button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCreating(false)}>Cancel</button>
              </div>
            </div>
          )}

          {anyRunning && <CampaignTicker onTick={load} />}
        </div>

        <div className="uin-col-scroll">
          {error && <div className="alert alert-danger" role="alert">{error}</div>}

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
            <ul className="uin-list">
              {rows.map((row) => (
                <li key={row.id} className="uin-list-item">
                  <CampaignRow
                    row={row}
                    timezone={timezone}
                    inbox={inboxes.find((i) => i.id === row.inboxId) ?? null}
                    open={row.id === campaignId}
                    onOpen={() => go({ campaign: row.id, view: null })}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {suppressing ? (
        <div className="uin-read uin-camp-pane">
          <SuppressionsPanel onBack={() => go({ campaign: null, view: null })} />
        </div>
      ) : campaignId ? (
        <div className="uin-read uin-camp-pane">
          <CampaignEditor
            campaignId={campaignId}
            inboxes={inboxes}
            categories={categories}
            tickUrl={tickUrl}
            onStatusChanged={load}
            onClose={() => { void load(); go({ campaign: null, view: null }) }}
          />
        </div>
      ) : (
        <div className="uin-read">
          <div className="uin-nothing">
            {MegaphoneIcon}
            <strong>Nothing open</strong>
            Pick a campaign to see who it goes to, what it says, when it goes and how far it has got -
            all on the one page.
          </div>
        </div>
      )}
    </>
  )
}

/** One campaign in the list: what it is called, where it stands, and how far
 *  along it is. Nothing else. Pausing it, stopping it and sending it again are
 *  in the pane beside it, where the campaign they are about is open - a row
 *  that carries its own buttons is a row somebody presses by accident. */
function CampaignRow({
  row, timezone, inbox, open, onOpen,
}: {
  row: CampaignListRow
  timezone: string
  inbox: CampaignInbox | null
  open: boolean
  onOpen: () => void
}) {
  const sent = row.tally.done + row.tally.replied + row.tally.bounced
    + row.tally.complained + row.tally.failed + row.tally.unsubscribed
  const onTheList = row.tally.total - row.tally.skipped
  const total = Math.max(1, onTheList)
  const pct = (value: number) => `${Math.round((value / total) * 100)}%`

  return (
    <button
      type="button"
      className="uin-camp-item"
      aria-current={open ? 'true' : undefined}
      onClick={onOpen}
    >
      <span className="uin-camp-item-top">
        <span className="uin-camp-item-name">{row.name}</span>
        <span className="uin-camp-pill" data-state={row.status}>{statusWord(row)}</span>
      </span>

      <span className="uin-camp-bar" role="img" aria-label={`${sent} of ${onTheList} sent`}>
        <span data-kind="done" style={{ width: pct(row.tally.done) }} />
        <span data-kind="replied" style={{ width: pct(row.tally.replied) }} />
        <span data-kind="bad" style={{ width: pct(row.tally.bounced + row.tally.complained + row.tally.failed) }} />
        <span data-kind="off" style={{ width: pct(row.tally.unsubscribed) }} />
      </span>

      <span className="uin-camp-item-meta">
        <span><b>{sent.toLocaleString('en-GB')}</b> of {onTheList.toLocaleString('en-GB')} sent</span>
        {row.tally.replied > 0 && <span><b>{row.tally.replied.toLocaleString('en-GB')}</b> replied</span>}
        {row.tally.bounced + row.tally.complained > 0 && (
          <span><b>{(row.tally.bounced + row.tally.complained).toLocaleString('en-GB')}</b> did not arrive</span>
        )}
        {row.finishesAbout && <span>Finishes about {when(row.finishesAbout, timezone)}</span>}
        {inbox && <span className="uin-camp-item-from">From {inbox.address}</span>}
      </span>
    </button>
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
