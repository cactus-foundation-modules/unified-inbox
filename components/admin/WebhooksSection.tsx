'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import { ConfirmDialog } from './inbox/ConfirmDialog'

// "When something arrives, tell this address about it."
//
// Written for somebody who has been handed a URL by whatever they want to
// connect the inbox to, not for somebody who knows what a webhook is. The word
// appears once, in the heading, and everything after it is in plain English.
// Nothing the other end says back is repeated here as it said it: a number or a
// line of its own diagnostics is meaningless to the person reading this screen,
// so it is turned into a sentence first.
//
// Deliberately self-contained: it loads and saves its own data rather than
// taking it through the settings payload, so adding it to the settings tab is
// two lines and removing it again is two lines.

const API = '/api/m/unified-inbox/admin'

const MUTED = { color: 'var(--color-text-muted)' } as const

/** The look of a section heading on the Unified Inbox settings screen.
 *
 *  It lives here rather than in SettingsTab because SettingsTab already imports
 *  this file, and the other way round would be a circle. Both files use this one
 *  constant: they render as headings on the same page, and the two of them used
 *  to disagree, so the Webhooks heading looked nothing like the five above it. */
export const SETTINGS_SECTION_HEADING = {
  fontSize: '0.75rem',
  fontWeight: 400,
  color: 'var(--color-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  margin: '0 0 0.75rem',
} as const

type Webhook = {
  id: string
  name: string
  inboxId: string | null
  url: string
  enabled: boolean
  events: string[]
  payloadStyle: 'event' | 'literal'
  literalBody: string | null
  includeBody: boolean
  hasSecret: boolean
  hasHeaders: boolean
  lastStatus: string | null
  lastAttemptAt: string | null
  lastError: string | null
  consecutiveFailures: number
  autoDisabledAt: string | null
}

type Delivery = {
  id: string
  status: 'pending' | 'sent' | 'failed' | 'dead'
  attempts: number
  responseCode: number | null
  error: string | null
  createdAt: string
  deliveredAt: string | null
}

type Draft = {
  id: string | null
  name: string
  inboxId: string
  url: string
  enabled: boolean
  payloadStyle: 'event' | 'literal'
  literalBody: string
  includeBody: boolean
  secret: string
  headersText: string
}

/** What is on the screen and whether it is good news. Success and failure used
 *  to be told apart by reading them. */
type Note = { tone: 'ok' | 'bad'; text: string }

function blank(): Draft {
  return {
    id: null,
    name: '',
    inboxId: '',
    url: '',
    enabled: true,
    payloadStyle: 'event',
    literalBody: '',
    includeBody: false,
    secret: '',
    headersText: '',
  }
}

/** Headers are typed one per line as `Name: value`, which is how anybody who
 *  has been given a pair of them by a service will have them written down. */
function parseHeaders(text: string): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const at = trimmed.indexOf(':')
    if (at < 1) return null
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
  }
  return out
}

/** What became of one attempt, said rather than reported. The other end's own
 *  numbers and messages stay out of the page: they are written for whoever
 *  built it, and the person reading this did not. */
function deliveryLine(row: Delivery): string {
  const when = new Date(row.createdAt).toLocaleString('en-GB')
  const tries = `${row.attempts} ${row.attempts === 1 ? 'try' : 'tries'}`
  if (row.status === 'sent') return `${when} · Sent, and the address took it.`
  if (row.status === 'pending') return `${when} · Waiting to go.`
  if (row.status === 'failed') return `${when} · Not through yet, after ${tries}. It will keep trying.`
  return `${when} · Given up after ${tries}.`
}

export function WebhooksSection({ inboxes }: { inboxes: { id: string; name: string }[] }) {
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<{ id: string; rows: Delivery[] } | null>(null)
  const [historyBusy, setHistoryBusy] = useState<string | null>(null)
  // Which one the Remove question is about. Null when nothing is being asked.
  const [removing, setRemoving] = useState<Webhook | null>(null)
  const fieldId = useId()

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/webhooks`)
      if (!res.ok) {
        setNote({ tone: 'bad', text: 'Could not load what the inbox is set to tell.' })
        return
      }
      const body = await res.json()
      setWebhooks(body.webhooks ?? [])
    } catch {
      setNote({ tone: 'bad', text: 'Could not reach the site to load what the inbox is set to tell. Check your connection and try again.' })
    }
  }, [])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async loader; every setState runs after an await
  useEffect(() => { void load() }, [load])

  const call = useCallback(async (path: string, init: RequestInit, okText?: string): Promise<unknown | null> => {
    setBusy(true)
    setNote(null)
    try {
      const res = await fetch(`${API}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setNote({ tone: 'bad', text: (body as { error?: string }).error ?? 'That did not work.' })
        return null
      }
      await load()
      if (okText) setNote({ tone: 'ok', text: okText })
      return body
    } catch {
      // A request that never arrived. Without this the button stays greyed out
      // for the rest of the visit and nothing on the screen says why.
      setNote({ tone: 'bad', text: 'Could not reach the site. Check your connection and try again.' })
      return null
    } finally {
      setBusy(false)
    }
  }, [load])

  function startNew() {
    setHistory(null)
    setDraft(blank())
  }

  function startEdit(hook: Webhook) {
    setHistory(null)
    setDraft({
      id: hook.id,
      name: hook.name,
      inboxId: hook.inboxId ?? '',
      url: hook.url,
      enabled: hook.enabled,
      payloadStyle: hook.payloadStyle,
      literalBody: hook.literalBody ?? '',
      includeBody: hook.includeBody,
      // Never pre-filled. The secret is not readable once saved, and showing a
      // row of dots that is not the real thing only teaches people to trust it.
      secret: '',
      headersText: '',
    })
  }

  async function save() {
    if (!draft) return

    const headers = draft.headersText.trim() ? parseHeaders(draft.headersText) : undefined
    if (headers === null) {
      setNote({ tone: 'bad', text: 'Each extra header goes on its own line, written as Name: value.' })
      return
    }

    const body: Record<string, unknown> = {
      name: draft.name,
      inboxId: draft.inboxId || null,
      url: draft.url.trim(),
      enabled: draft.enabled,
      events: ['message.received'],
      payloadStyle: draft.payloadStyle,
      literalBody: draft.payloadStyle === 'literal' ? draft.literalBody : null,
      includeBody: draft.includeBody,
    }
    // Absent leaves whatever is stored alone; an empty box on an existing one
    // therefore means "no change", not "wipe it".
    if (draft.secret) body.secret = draft.secret
    if (headers !== undefined) body.headers = headers

    const saved = draft.id
      ? await call(`/webhooks/${draft.id}`, { method: 'PATCH', body: JSON.stringify(body) }, 'Saved.')
      : await call('/webhooks', { method: 'POST', body: JSON.stringify(body) }, 'Saved.')
    if (saved) setDraft(null)
  }

  async function remove(id: string) {
    const gone = await call(`/webhooks/${id}`, { method: 'DELETE' }, 'Removed.')
    if (gone) setDraft(null)
  }

  async function test(id: string) {
    const result = await call(`/webhooks/${id}/test`, { method: 'POST' }) as
      { ok?: boolean; status?: number; error?: string } | null
    if (!result) return
    setNote(result.ok
      ? { tone: 'ok', text: 'That worked. The address answered, and it was happy with what it got.' }
      : { tone: 'bad', text: 'No luck. The address either did not answer or was not happy with what it got - worth checking it with whoever gave it to you.' })
  }

  async function showHistory(id: string) {
    if (history?.id === id) { setHistory(null); return }
    setHistoryBusy(id)
    setNote(null)
    try {
      const res = await fetch(`${API}/webhooks/${id}/deliveries`)
      if (!res.ok) { setNote({ tone: 'bad', text: 'Could not load what has been sent.' }); return }
      const body = await res.json()
      setHistory({ id, rows: body.deliveries ?? [] })
    } catch {
      setNote({ tone: 'bad', text: 'Could not reach the site to load what has been sent. Check your connection and try again.' })
    } finally {
      setHistoryBusy(null)
    }
  }

  const noteBlock = note && (
    <div
      className={note.tone === 'ok' ? 'alert alert-success' : 'alert alert-danger'}
      role={note.tone === 'ok' ? 'status' : 'alert'}
      style={{ marginBottom: '1rem' }}
    >
      {note.text}
    </div>
  )

  // A section that could not load says so. It used to disappear altogether,
  // taking the explanation with it.
  if (webhooks === null) {
    return (
      <section className="card" style={{ marginTop: '1.5rem' }}>
        <h3 style={SETTINGS_SECTION_HEADING}>Telling something else when the post arrives</h3>
        {note ? (
          <>
            {noteBlock}
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>Try again</button>
          </>
        ) : (
          <p style={{ ...MUTED, fontSize: '0.875rem', margin: 0 }}>Loading&hellip;</p>
        )}
      </section>
    )
  }

  return (
    <section className="card" style={{ marginTop: '1.5rem' }}>
      <h3 style={SETTINGS_SECTION_HEADING}>Telling something else when the post arrives</h3>
      <p style={{ ...MUTED, fontSize: '0.875rem', marginTop: 0 }}>
        Every time a message lands, this can send a note about it to a web address you choose -
        useful for setting something else going on its own. Nothing here changes what happens in
        the inbox itself, and switching it all off breaks nothing.
      </p>

      {noteBlock}

      {webhooks.length === 0 && !draft && (
        <p style={{ ...MUTED, fontSize: '0.875rem' }}>
          Nothing is being told about new messages at the moment.
        </p>
      )}

      {webhooks.map((hook) => (
        <div
          key={hook.id}
          style={{
            border: '1px solid var(--color-border)',
            borderRadius: '0.5rem',
            padding: '0.75rem 1rem',
            marginBottom: '0.75rem',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
            <div>
              <strong>{hook.name}</strong>
              {!hook.enabled && <span style={{ ...MUTED, marginLeft: '0.5rem' }}>(switched off)</span>}
              {hook.autoDisabledAt && (
                // Destructive-hover rather than danger: danger on text this small
                // measures under AA on a pale ground.
                <span style={{ marginLeft: '0.5rem', color: 'var(--color-destructive-hover)' }}>
                  (stopped by itself after too many failures)
                </span>
              )}
              <div style={{ ...MUTED, fontSize: '0.8125rem', overflowWrap: 'anywhere' }}>{hook.url}</div>
              <div style={{ ...MUTED, fontSize: '0.8125rem' }}>
                {hook.inboxId
                  ? inboxes.find((i) => i.id === hook.inboxId)?.name ?? 'One inbox'
                  : 'Every inbox'}
                {hook.hasSecret ? ' · signed' : ' · not signed'}
                {hook.includeBody ? ' · sends the message itself' : ''}
              </div>
              {hook.lastAttemptAt && (
                <div style={{ ...MUTED, fontSize: '0.8125rem' }}>
                  Last tried {new Date(hook.lastAttemptAt).toLocaleString('en-GB')} - {hook.lastError ? 'no luck.' : 'the address took it.'}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void test(hook.id)}>Send a test</button>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy || historyBusy === hook.id} onClick={() => void showHistory(hook.id)}>
                {historyBusy === hook.id ? 'Fetching…' : history?.id === hook.id ? 'Hide' : 'History'}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => startEdit(hook)}>Edit</button>
              <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => setRemoving(hook)}>Remove</button>
            </div>
          </div>

          {history?.id === hook.id && (
            <div style={{ marginTop: '0.75rem', borderTop: '1px solid var(--color-border)', paddingTop: '0.75rem' }}>
              {history.rows.length === 0 && (
                <p style={{ ...MUTED, fontSize: '0.8125rem', margin: 0 }}>Nothing has been sent yet.</p>
              )}
              {history.rows.map((row) => (
                <div key={row.id} style={{ ...MUTED, fontSize: '0.8125rem' }}>
                  {deliveryLine(row)}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {!draft && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={startNew} disabled={busy}>
          Tell something about new messages
        </button>
      )}

      {draft && (
        <div style={{ borderTop: '1px solid var(--color-border)', marginTop: '1rem', paddingTop: '1rem' }}>
          <div className="field">
            <label htmlFor={`${fieldId}-name`}>What is it for</label>
            <input
              id={`${fieldId}-name`}
              value={draft.name}
              placeholder="Marcus reads the post"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>

          <div className="field">
            <label htmlFor={`${fieldId}-url`}>Web address to tell</label>
            <input
              id={`${fieldId}-url`}
              value={draft.url}
              placeholder="https://example.com/something"
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            />
            <p style={{ ...MUTED, fontSize: '0.8125rem', margin: '0.375rem 0 0' }}>
              Has to start with https, and has to be somewhere on the open internet.
            </p>
          </div>

          <div className="field">
            <label htmlFor={`${fieldId}-inbox`}>Which inbox</label>
            <select
              id={`${fieldId}-inbox`}
              value={draft.inboxId}
              onChange={(e) => setDraft({ ...draft, inboxId: e.target.value })}
            >
              <option value="">Every inbox</option>
              {inboxes.map((inbox) => (
                <option key={inbox.id} value={inbox.id}>{inbox.name}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor={`${fieldId}-style`}>What to send</label>
            <select
              id={`${fieldId}-style`}
              value={draft.payloadStyle}
              onChange={(e) => setDraft({ ...draft, payloadStyle: e.target.value as 'event' | 'literal' })}
            >
              <option value="event">Details of the message that arrived</option>
              <option value="literal">The same fixed message every time</option>
            </select>
            <p style={{ ...MUTED, fontSize: '0.8125rem', margin: '0.375rem 0 0' }}>
              The second one is for an address that expects its own wording and only needs to know
              that something happened.
            </p>
          </div>

          {draft.payloadStyle === 'literal' && (
            <div className="field">
              <label htmlFor={`${fieldId}-literal`}>What to send every time</label>
              <textarea
                id={`${fieldId}-literal`}
                rows={4}
                value={draft.literalBody}
                placeholder={'{"text": "Something has arrived in the inbox"}'}
                onChange={(e) => setDraft({ ...draft, literalBody: e.target.value })}
              />
              <p style={{ ...MUTED, fontSize: '0.8125rem', margin: '0.375rem 0 0' }}>
                Whatever the other end asked you to send it, word for word. If they have not given
                you anything to put here, the other choice above is the one you want.
              </p>
            </div>
          )}

          {draft.payloadStyle === 'event' && (
            <div className="field">
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontWeight: 400 }}>
                <input
                  type="checkbox"
                  checked={draft.includeBody}
                  onChange={(e) => setDraft({ ...draft, includeBody: e.target.checked })}
                />
                Include what the message actually said
              </label>
              <p style={{ ...MUTED, fontSize: '0.8125rem', margin: '0.375rem 0 0' }}>
                Off by default, and worth leaving off unless the other end needs it: switching it on
                sends a copy of your post to that address every time one arrives.
              </p>
            </div>
          )}

          <div className="field">
            <label htmlFor={`${fieldId}-secret`}>Signing password <span style={{ ...MUTED, fontWeight: 400 }}>(optional)</span></label>
            <input
              id={`${fieldId}-secret`}
              type="password"
              value={draft.secret}
              placeholder={draft.id ? 'Leave blank to keep the one you have' : ''}
              onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
            />
            <p style={{ ...MUTED, fontSize: '0.8125rem', margin: '0.375rem 0 0' }}>
              If the other end expects one, put it here and each note is stamped with it, so it can
              tell that the message really came from your site.
            </p>
          </div>

          <div className="field">
            <label htmlFor={`${fieldId}-headers`}>Extra headers <span style={{ ...MUTED, fontWeight: 400 }}>(optional, one per line)</span></label>
            <textarea
              id={`${fieldId}-headers`}
              rows={3}
              value={draft.headersText}
              placeholder={draft.id ? 'Leave blank to keep the ones you have' : 'X-Api-Key: the key they gave you'}
              onChange={(e) => setDraft({ ...draft, headersText: e.target.value })}
            />
            <p style={{ ...MUTED, fontSize: '0.8125rem', margin: '0.375rem 0 0' }}>
              Written as Name: value. This is where a key goes if the address you are telling asks
              for one. They are kept locked away and never shown again.
            </p>
          </div>

          <div className="field">
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              />
              Switched on
            </label>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void save()}>Save</button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={removing !== null}
        title="Stop telling this address about new messages?"
        body={removing
          ? `Nothing more will be sent to ${removing.url}. The inbox itself carries on exactly as it is.`
          : ''}
        confirmLabel="Stop telling it"
        destructive
        busy={busy}
        onCancel={() => { if (!busy) setRemoving(null) }}
        // Left open while the removal is in flight: the dialog greys its own two
        // answers out, and closes once the work is finished either way, so the
        // outcome is read on the screen behind it.
        onConfirm={() => {
          const hook = removing
          if (hook) void remove(hook.id).finally(() => setRemoving(null))
        }}
      />
    </section>
  )
}
