'use client'

import { useCallback, useEffect, useState } from 'react'

// "When something arrives, tell this address about it."
//
// Written for somebody who has been handed a URL by whatever they want to
// connect the inbox to, not for somebody who knows what a webhook is. The word
// appears once, in the heading, and everything after it is in plain English.
//
// Deliberately self-contained: it loads and saves its own data rather than
// taking it through the settings payload, so adding it to the settings tab is
// two lines and removing it again is two lines.

const API = '/api/m/unified-inbox/admin'

const MUTED = { color: 'var(--color-text-muted)' } as const
const LABEL_STYLE = {
  fontWeight: 600,
  fontSize: '1.0625rem',
  marginBottom: '0.75rem',
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

export function WebhooksSection({ inboxes }: { inboxes: { id: string; name: string }[] }) {
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<{ id: string; rows: Delivery[] } | null>(null)

  const load = useCallback(async () => {
    const res = await fetch(`${API}/webhooks`)
    if (!res.ok) {
      setMessage('Could not load what the inbox is set to tell.')
      return
    }
    const body = await res.json()
    setWebhooks(body.webhooks ?? [])
  }, [])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async loader; every setState runs after an await
  useEffect(() => { void load() }, [load])

  const call = useCallback(async (path: string, init: RequestInit): Promise<unknown | null> => {
    setBusy(true)
    setMessage(null)
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    })
    const body = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) {
      setMessage((body as { error?: string }).error ?? 'That did not work.')
      return null
    }
    await load()
    return body
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
      setMessage('Each extra header goes on its own line, written as Name: value.')
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
      ? await call(`/webhooks/${draft.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      : await call('/webhooks', { method: 'POST', body: JSON.stringify(body) })
    if (saved) setDraft(null)
  }

  async function remove(id: string) {
    if (!confirm('Stop telling this address about new messages?')) return
    await call(`/webhooks/${id}`, { method: 'DELETE' })
    setDraft(null)
  }

  async function test(id: string) {
    const result = await call(`/webhooks/${id}/test`, { method: 'POST' }) as
      { ok?: boolean; status?: number; error?: string } | null
    if (!result) return
    setMessage(result.ok
      ? `That worked - the address answered ${result.status}.`
      : `No luck: ${result.error ?? 'it did not answer.'}`)
  }

  async function showHistory(id: string) {
    if (history?.id === id) { setHistory(null); return }
    const res = await fetch(`${API}/webhooks/${id}/deliveries`)
    if (!res.ok) { setMessage('Could not load what has been sent.'); return }
    const body = await res.json()
    setHistory({ id, rows: body.deliveries ?? [] })
  }

  if (webhooks === null) return null

  return (
    <section className="card" style={{ marginTop: '1.5rem' }}>
      <div style={LABEL_STYLE}>Telling something else when the post arrives</div>
      <p style={{ ...MUTED, fontSize: '0.875rem', marginTop: 0 }}>
        Every time a message lands, this can send a note about it to a web address you choose -
        useful for setting something else going on its own. Nothing here changes what happens in
        the inbox itself, and switching it all off breaks nothing.
      </p>

      {message && <div className="alert alert-info" style={{ marginBottom: '1rem' }}>{message}</div>}

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
                <span style={{ marginLeft: '0.5rem', color: 'var(--color-danger)' }}>
                  (stopped by itself after too many failures)
                </span>
              )}
              <div style={{ ...MUTED, fontSize: '0.8125rem', wordBreak: 'break-all' }}>{hook.url}</div>
              <div style={{ ...MUTED, fontSize: '0.8125rem' }}>
                {hook.inboxId
                  ? inboxes.find((i) => i.id === hook.inboxId)?.name ?? 'One inbox'
                  : 'Every inbox'}
                {hook.hasSecret ? ' · signed' : ' · not signed'}
                {hook.includeBody ? ' · sends the message itself' : ''}
              </div>
              {hook.lastAttemptAt && (
                <div style={{ ...MUTED, fontSize: '0.8125rem' }}>
                  Last tried {new Date(hook.lastAttemptAt).toLocaleString('en-GB')} - {hook.lastError ? `no luck: ${hook.lastError}` : `answered ${hook.lastStatus}`}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void test(hook.id)}>Send a test</button>
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void showHistory(hook.id)}>
                {history?.id === hook.id ? 'Hide' : 'History'}
              </button>
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => startEdit(hook)}>Edit</button>
              <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void remove(hook.id)}>Remove</button>
            </div>
          </div>

          {history?.id === hook.id && (
            <div style={{ marginTop: '0.75rem', borderTop: '1px solid var(--color-border)', paddingTop: '0.75rem' }}>
              {history.rows.length === 0 && (
                <p style={{ ...MUTED, fontSize: '0.8125rem', margin: 0 }}>Nothing has been sent yet.</p>
              )}
              {history.rows.map((row) => (
                <div key={row.id} style={{ ...MUTED, fontSize: '0.8125rem' }}>
                  {new Date(row.createdAt).toLocaleString('en-GB')} ·{' '}
                  {row.status === 'sent' ? `sent, answered ${row.responseCode}`
                    : row.status === 'pending' ? 'waiting to go'
                    : row.status === 'failed' ? `no luck so far (${row.attempts} tries) - ${row.error ?? ''}`
                    : `given up after ${row.attempts} tries - ${row.error ?? ''}`}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {!draft && (
        <button className="btn btn-secondary btn-sm" onClick={startNew} disabled={busy}>
          Tell something about new messages
        </button>
      )}

      {draft && (
        <div style={{ borderTop: '1px solid var(--color-border)', marginTop: '1rem', paddingTop: '1rem' }}>
          <div className="field">
            <label>What is it for</label>
            <input
              value={draft.name}
              placeholder="Marcus reads the post"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>

          <div className="field">
            <label>Web address to tell</label>
            <input
              value={draft.url}
              placeholder="https://example.com/something"
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            />
            <p style={{ ...MUTED, fontSize: '0.8125rem', margin: '0.375rem 0 0' }}>
              Has to start with https, and has to be somewhere on the open internet.
            </p>
          </div>

          <div className="field">
            <label>Which inbox</label>
            <select
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
            <label>What to send</label>
            <select
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
              <label>What to send every time</label>
              <textarea
                rows={4}
                value={draft.literalBody}
                placeholder={'{"skill": "marcus"}'}
                onChange={(e) => setDraft({ ...draft, literalBody: e.target.value })}
              />
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
            <label>Signing password <span style={{ ...MUTED, fontWeight: 400 }}>(optional)</span></label>
            <input
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
            <label>Extra headers <span style={{ ...MUTED, fontWeight: 400 }}>(optional, one per line)</span></label>
            <textarea
              rows={3}
              value={draft.headersText}
              placeholder={draft.id ? 'Leave blank to keep the ones you have' : 'CF-Access-Client-Id: ...'}
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
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void save()}>Save</button>
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  )
}
