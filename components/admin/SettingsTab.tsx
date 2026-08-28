'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

// Settings for the Unified Inbox: the mail accounts it reads, the addresses
// people write to, who may read which of them, and how far back to go.
//
// Copy here is written for somebody who runs a business, not a mail server:
// "mail account" rather than "IMAP connection", "the folder your mail app files
// things into" rather than "special-use mailbox". Every colour is a token, so
// the whole thing follows the admin into dark mode without a second palette.

const API = '/api/m/unified-inbox/admin'

type Connection = {
  id: string
  label: string
  imapHost: string
  imapPort: number
  imapUsername: string
  hasPassword: boolean
  imapTls: boolean
  extraFolders: string[]
  lastSyncAt: string | null
  lastSyncStatus: 'ok' | 'error' | null
  lastSyncError: string | null
}

type Inbox = {
  id: string
  name: string
  address: string
  connectionId: string | null
  imapFolder: string
  sentFolder: string | null
  isCatchAll: boolean
  sendTransport: 'brevo' | 'smtp'
  hasBrevoKey: boolean
  smtpHost: string | null
  smtpPort: number | null
  smtpUsername: string | null
  hasSmtpPassword: boolean
  fromName: string | null
  signatureHtml: string | null
  appendToSent: boolean
  colour: string | null
  sortOrder: number
}

type AccessRow = { inboxId: string; userId: string; canReply: boolean }

type Settings = {
  backfillMonths: number
  retentionMonths: number | null
  attachmentFetch: 'lazy' | 'always' | 'never'
  autoLink: boolean
  defaultInboxId: string | null
  ownDomains: string[] | null
  personalDomains: string[]
  orderNumberPattern: string | null
  poNumberPattern: string | null
  quoteNumberPattern: string | null
}

type StaffMember = { id: string; name: string; email: string }

type CollectionStat = {
  connectionId: string
  folders: number
  collected: number
  estimated: number | null
  backfillComplete: boolean
  lastRunAt: string | null
  lastError: string | null
}

type Payload = {
  connections: Connection[]
  inboxes: Inbox[]
  access: AccessRow[]
  settings: Settings
  collection: CollectionStat[]
  unrouted: number
  /** Mailboxes something else on this site is already watching, and what to do
   *  about it. One per mail account, never more. */
  warnings: Array<{ connectionId: string; message: string }>
  people: { people: number; organisations: number }
  users: StaffMember[]
  encryptionReady: boolean
}

type MailFolder = { path: string; name: string; role: string | null }

const MUTED = { color: 'var(--color-text-muted)' } as const
const LABEL_STYLE = {
  fontSize: '0.75rem',
  color: 'var(--color-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: '0.75rem',
} as const

function blankConnection() {
  return { label: '', imapHost: '', imapPort: 993, imapUsername: '', imapPassword: '', imapTls: true, extraFolders: '' }
}

function blankInbox() {
  return {
    name: '',
    address: '',
    connectionId: '',
    imapFolder: 'INBOX',
    sentFolder: '',
    isCatchAll: false,
    sendTransport: 'brevo' as 'brevo' | 'smtp',
    brevoApiKey: '',
    smtpHost: '',
    smtpPort: '',
    smtpUsername: '',
    smtpPassword: '',
    fromName: '',
    signatureHtml: '',
    appendToSent: false,
    sortOrder: 0,
  }
}

type ConnectionDraft = ReturnType<typeof blankConnection>
type InboxDraft = ReturnType<typeof blankInbox>

export function UnifiedInboxSettingsTab() {
  const [data, setData] = useState<Payload | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch(`${API}/settings`)
    if (!res.ok) {
      setMessage('Could not load the inbox settings.')
      return
    }
    setData(await res.json())
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

  if (!data) return null

  return (
    <div>
      <p style={{ ...MUTED, marginBottom: '1.5rem' }}>
        One place for every conversation with a customer or a supplier. Point it at the mail account
        you already use, tell it which addresses people write to, and decide who is allowed to read
        which of them.
      </p>

      {message && <div className="card" style={{ marginBottom: '1rem' }}>{message}</div>}

      {!data.encryptionReady && (
        <div className="alert alert-danger" style={{ marginBottom: '1.5rem' }}>
          This site has no encryption key set, so there is nowhere safe to keep a mailbox password.
          Set one up before adding a mail account.
        </div>
      )}

      {(data.warnings ?? []).map((warning) => (
        <div key={warning.connectionId} className="alert alert-danger" style={{ marginBottom: '1.5rem' }}>
          {warning.message}
        </div>
      ))}

      {data.unrouted > 0 && (
        <div className="alert alert-info" style={{ marginBottom: '1.5rem' }}>
          {data.unrouted === 1
            ? 'One message arrived at an address that is not set up here, so it has nowhere to go.'
            : `${data.unrouted} messages arrived at addresses that are not set up here, so they have nowhere to go.`}
          {' '}Add the address as an inbox, or mark one of your inboxes as the catch-all, and they will be filed the next time mail is checked.
        </div>
      )}

      <ConnectionsSection
        connections={data.connections}
        collection={data.collection}
        busy={busy}
        call={call}
        setMessage={setMessage}
        reload={load}
      />

      <InboxesSection
        inboxes={data.inboxes}
        connections={data.connections}
        access={data.access}
        users={data.users}
        busy={busy}
        call={call}
      />

      <ModuleSettingsSection
        settings={data.settings}
        inboxes={data.inboxes}
        busy={busy}
        call={call}
      />

      <PeopleSettingsSection
        settings={data.settings}
        inboxes={data.inboxes}
        counts={data.people}
        busy={busy}
        call={call}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Mail accounts
// ---------------------------------------------------------------------------

/** How collection is getting on, in words an owner can use. Mail is gathered a
 *  bit at a time - every hour on most plans, once a day on the smallest one -
 *  so the honest answer to "is it done yet?" is usually "not yet, here is how
 *  far it has got". */
function CollectionProgress({ stat }: { stat?: CollectionStat }) {
  if (!stat) return null
  const collected = stat.collected.toLocaleString('en-GB')
  if (stat.backfillComplete) {
    return (
      <div style={{ ...MUTED, fontSize: '0.8125rem', marginTop: '0.5rem' }}>
        {collected} message{stat.collected === 1 ? '' : 's'} collected. All caught up.
      </div>
    )
  }
  const estimate = stat.estimated ? ` of about ${stat.estimated.toLocaleString('en-GB')}` : ''
  return (
    <div style={{ ...MUTED, fontSize: '0.8125rem', marginTop: '0.5rem' }}>
      {collected}{estimate} message{stat.collected === 1 ? '' : 's'} collected so far. Older mail is
      still being fetched a bit at a time in the background.
    </div>
  )
}

type Caller = (path: string, init: RequestInit) => Promise<unknown | null>

function ConnectionsSection({ connections, collection, busy, call, setMessage, reload }: {
  connections: Connection[]
  collection: CollectionStat[]
  busy: boolean
  call: Caller
  setMessage: (m: string | null) => void
  reload: () => Promise<void>
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<ConnectionDraft>(blankConnection())
  const [folders, setFolders] = useState<Record<string, MailFolder[]>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const [checking, setChecking] = useState<string | null>(null)
  const stats = useMemo(
    () => new Map(collection.map((c) => [c.connectionId, c])),
    [collection]
  )

  function startNew() {
    setDraft(blankConnection())
    setEditing('new')
  }

  function startEdit(connection: Connection) {
    setDraft({
      label: connection.label,
      imapHost: connection.imapHost,
      imapPort: connection.imapPort,
      imapUsername: connection.imapUsername,
      imapPassword: '',
      imapTls: connection.imapTls,
      extraFolders: connection.extraFolders.join(', '),
    })
    setEditing(connection.id)
  }

  async function save() {
    const extraFolders = draft.extraFolders.split(',').map((f) => f.trim()).filter(Boolean)
    const body = {
      label: draft.label,
      imapHost: draft.imapHost,
      imapPort: Number(draft.imapPort) || 993,
      imapUsername: draft.imapUsername,
      imapTls: draft.imapTls,
      extraFolders,
      ...(draft.imapPassword ? { imapPassword: draft.imapPassword } : {}),
    }
    const result = editing === 'new'
      ? await call('/connections', { method: 'POST', body: JSON.stringify(body) })
      : await call(`/connections/${editing}`, { method: 'PATCH', body: JSON.stringify(body) })
    if (result) setEditing(null)
  }

  async function remove(id: string) {
    if (!window.confirm('Remove this mail account? Conversations already collected are kept.')) return
    await call(`/connections/${id}`, { method: 'DELETE' })
  }

  async function test(id: string) {
    setTesting(id)
    setMessage(null)
    const res = await fetch(`${API}/connections/${id}/test`, { method: 'POST' })
    const body = await res.json().catch(() => ({}))
    setTesting(null)
    if (body.ok) {
      setFolders((f) => ({ ...f, [id]: body.folders }))
      setMessage(`Connected. Found ${body.folders.length} folder${body.folders.length === 1 ? '' : 's'}.`)
    } else {
      setMessage(body.error ?? 'That did not work.')
    }
  }

  // Deliberately a longer wait than the hourly check gets: this runs with a
  // minute of its own rather than a slice of the shared one, because somebody
  // is stood here watching it.
  async function checkNow(id: string) {
    setChecking(id)
    setMessage(null)
    const res = await fetch(`${API}/check-now`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: id }),
    })
    const body = await res.json().catch(() => ({}))
    setChecking(null)
    setMessage(res.ok ? (body.message ?? 'Checked.') : (body.error ?? 'That did not work.'))
    await reload()
  }

  return (
    <section className="card" style={{ marginBottom: '1.5rem' }}>
      <div style={LABEL_STYLE}>Mail accounts</div>
      <p style={{ ...MUTED, fontSize: '0.875rem', marginTop: 0 }}>
        The mailbox this reads from. One account can serve several addresses - most sites need one.
        If this is an iCloud, Google or Outlook account you will need an app password rather than the
        one you log in with.
      </p>

      {connections.length === 0 && <p style={MUTED}>No mail accounts yet.</p>}

      {connections.map((connection) => (
        <div key={connection.id} style={{
          borderTop: '1px solid var(--color-border)',
          paddingTop: '0.75rem',
          marginTop: '0.75rem',
        }}>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
            <strong>{connection.label}</strong>
            <span style={{ ...MUTED, fontSize: '0.875rem' }}>{connection.imapUsername}</span>
            {!connection.hasPassword && (
              <span style={{ color: 'var(--color-danger)', fontSize: '0.875rem' }}>no password saved</span>
            )}
          </div>
          <div style={{ ...MUTED, fontSize: '0.8125rem', marginTop: '0.25rem' }}>
            {connection.lastSyncAt
              ? `Last checked ${new Date(connection.lastSyncAt).toLocaleString('en-GB')}${
                  connection.lastSyncStatus === 'error' ? ` - ${connection.lastSyncError ?? 'it did not work'}` : ''
                }`
              : 'Never checked yet.'}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => startEdit(connection)}>Edit</button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={testing === connection.id} onClick={() => test(connection.id)}>
              {testing === connection.id ? 'Testing…' : 'Test connection'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={checking === connection.id} onClick={() => checkNow(connection.id)}>
              {checking === connection.id ? 'Checking…' : 'Check now'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => remove(connection.id)}>Remove</button>
          </div>
          <CollectionProgress stat={stats.get(connection.id)} />
          {folders[connection.id] && (
            <div style={{ ...MUTED, fontSize: '0.8125rem', marginTop: '0.5rem' }}>
              Folders: {folders[connection.id]!.map((f) => f.path).join(', ')}
            </div>
          )}
        </div>
      ))}

      {editing === null ? (
        <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: '1rem' }} onClick={startNew}>
          Add a mail account
        </button>
      ) : (
        <div style={{ borderTop: '1px solid var(--color-border)', marginTop: '1rem', paddingTop: '1rem' }}>
          <div className="field">
            <label>What to call it</label>
            <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Office mail" />
          </div>
          <div className="field">
            <label>Mail server</label>
            <input value={draft.imapHost} onChange={(e) => setDraft({ ...draft, imapHost: e.target.value })} placeholder="imap.mail.me.com" />
          </div>
          <div className="field">
            <label>Port</label>
            <input type="number" value={draft.imapPort} onChange={(e) => setDraft({ ...draft, imapPort: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label>Username</label>
            <input value={draft.imapUsername} onChange={(e) => setDraft({ ...draft, imapUsername: e.target.value })} placeholder="you@yourcompany.co.uk" />
          </div>
          <div className="field">
            <label>
              Password{' '}
              {editing !== 'new' && <span style={{ ...MUTED, fontWeight: 400 }}>(leave blank to keep the one saved)</span>}
            </label>
            <input type="password" value={draft.imapPassword} onChange={(e) => setDraft({ ...draft, imapPassword: e.target.value })} />
          </div>
          <div className="field">
            <label>Other folders to read <span style={{ ...MUTED, fontWeight: 400 }}>(optional, separated by commas)</span></label>
            <input value={draft.extraFolders} onChange={(e) => setDraft({ ...draft, extraFolders: e.target.value })} placeholder="Archive, Suppliers" />
          </div>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Save mail account</button>
            <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Inboxes
// ---------------------------------------------------------------------------

function InboxesSection({ inboxes, connections, access, users, busy, call }: {
  inboxes: Inbox[]
  connections: Connection[]
  access: AccessRow[]
  users: StaffMember[]
  busy: boolean
  call: Caller
}) {
  const [senderWarning, setSenderWarning] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<InboxDraft>(blankInbox())
  const [staff, setStaff] = useState<AccessRow[]>([])

  const accessByInbox = useMemo(() => {
    const map = new Map<string, AccessRow[]>()
    for (const row of access) {
      const list = map.get(row.inboxId)
      if (list) list.push(row)
      else map.set(row.inboxId, [row])
    }
    return map
  }, [access])

  function startNew() {
    setDraft(blankInbox())
    setStaff([])
    setEditing('new')
  }

  function startEdit(inbox: Inbox) {
    setDraft({
      name: inbox.name,
      address: inbox.address,
      connectionId: inbox.connectionId ?? '',
      imapFolder: inbox.imapFolder,
      sentFolder: inbox.sentFolder ?? '',
      isCatchAll: inbox.isCatchAll,
      sendTransport: inbox.sendTransport,
      brevoApiKey: '',
      smtpHost: inbox.smtpHost ?? '',
      smtpPort: inbox.smtpPort === null ? '' : String(inbox.smtpPort),
      smtpUsername: inbox.smtpUsername ?? '',
      smtpPassword: '',
      fromName: inbox.fromName ?? '',
      signatureHtml: inbox.signatureHtml ?? '',
      appendToSent: inbox.appendToSent,
      sortOrder: inbox.sortOrder,
    })
    setStaff(accessByInbox.get(inbox.id) ?? [])
    setEditing(inbox.id)
  }

  async function save() {
    const body = {
      name: draft.name,
      address: draft.address,
      connectionId: draft.connectionId || null,
      imapFolder: draft.imapFolder || 'INBOX',
      sentFolder: draft.sentFolder || null,
      isCatchAll: draft.isCatchAll,
      sendTransport: draft.sendTransport,
      smtpHost: draft.smtpHost || null,
      smtpPort: draft.smtpPort ? Number(draft.smtpPort) : null,
      smtpUsername: draft.smtpUsername || null,
      fromName: draft.fromName || null,
      signatureHtml: draft.signatureHtml || null,
      appendToSent: draft.appendToSent,
      sortOrder: Number(draft.sortOrder) || 0,
      ...(draft.brevoApiKey ? { brevoApiKey: draft.brevoApiKey } : {}),
      ...(draft.smtpPassword ? { smtpPassword: draft.smtpPassword } : {}),
    }
    type Saved = { inbox?: Inbox; senderWarning?: string | null }
    const saved = editing === 'new'
      ? await call('/inboxes', { method: 'POST', body: JSON.stringify(body) }) as Saved | null
      : await call(`/inboxes/${editing}`, { method: 'PATCH', body: JSON.stringify(body) }) as Saved | null
    if (!saved?.inbox) return
    await call(`/inboxes/${saved.inbox.id}/access`, {
      method: 'PUT',
      body: JSON.stringify({ entries: staff.map((s) => ({ userId: s.userId, canReply: s.canReply })) }),
    })
    // Saved either way. This only says whether replies will actually leave the
    // building yet, which is a different question and one worth answering while
    // the person who can fix it is still here (E15).
    setSenderWarning(saved.senderWarning ?? null)
    setEditing(null)
  }

  async function remove(id: string) {
    if (!window.confirm('Remove this inbox? Conversations already collected are kept, but nothing new will be filed here.')) return
    await call(`/inboxes/${id}`, { method: 'DELETE' })
  }

  function toggleStaff(userId: string) {
    setStaff((current) => current.some((s) => s.userId === userId)
      ? current.filter((s) => s.userId !== userId)
      : [...current, { inboxId: editing ?? '', userId, canReply: true }])
  }

  function toggleReply(userId: string) {
    setStaff((current) => current.map((s) => s.userId === userId ? { ...s, canReply: !s.canReply } : s))
  }

  return (
    <section className="card" style={{ marginBottom: '1.5rem' }}>
      <div style={LABEL_STYLE}>Inboxes</div>
      <p style={{ ...MUTED, fontSize: '0.875rem', marginTop: 0 }}>
        An address people write to. Each one can have its own staff, its own signature and its own
        name on the replies, even when they all arrive in the same mail account.
      </p>

      {senderWarning && (
        <div className="alert alert-info" style={{ marginBottom: '1rem' }}>
          {senderWarning}
        </div>
      )}

      {inboxes.length === 0 && <p style={MUTED}>No inboxes yet.</p>}

      {inboxes.map((inbox) => {
        const rows = accessByInbox.get(inbox.id) ?? []
        return (
          <div key={inbox.id} style={{
            borderTop: '1px solid var(--color-border)',
            paddingTop: '0.75rem',
            marginTop: '0.75rem',
          }}>
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
              <strong>{inbox.name}</strong>
              <span style={{ ...MUTED, fontSize: '0.875rem' }}>{inbox.address}</span>
              {inbox.isCatchAll && <span style={{ ...MUTED, fontSize: '0.75rem' }}>catch-all</span>}
            </div>
            <div style={{ ...MUTED, fontSize: '0.8125rem', marginTop: '0.25rem' }}>
              {rows.length === 0
                ? 'Anybody who can see the inbox can read this one.'
                : `Restricted to ${rows.length} ${rows.length === 1 ? 'person' : 'people'}.`}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => startEdit(inbox)}>Edit</button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => remove(inbox.id)}>Remove</button>
            </div>
          </div>
        )
      })}

      {editing === null ? (
        <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: '1rem' }} onClick={startNew}>
          Add an inbox
        </button>
      ) : (
        <div style={{ borderTop: '1px solid var(--color-border)', marginTop: '1rem', paddingTop: '1rem' }}>
          <div className="field">
            <label>What to call it</label>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Customer enquiries" />
          </div>
          <div className="field">
            <label>Address</label>
            <input value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} placeholder="hi@yourcompany.co.uk" />
          </div>
          <div className="field">
            <label>Mail account</label>
            <select value={draft.connectionId} onChange={(e) => setDraft({ ...draft, connectionId: e.target.value })}>
              <option value="">Not collected from a mailbox</option>
              {connections.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Folder to read</label>
            <input value={draft.imapFolder} onChange={(e) => setDraft({ ...draft, imapFolder: e.target.value })} placeholder="INBOX" />
          </div>
          <div className="field">
            <label>Sent folder <span style={{ ...MUTED, fontWeight: 400 }}>(optional)</span></label>
            <input value={draft.sentFolder} onChange={(e) => setDraft({ ...draft, sentFolder: e.target.value })} placeholder="Sent Messages" />
          </div>
          <div className="field">
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontWeight: 400 }}>
              <input type="checkbox" checked={draft.isCatchAll} onChange={(e) => setDraft({ ...draft, isCatchAll: e.target.checked })} />
              Anything that does not match another address lands here
            </label>
          </div>
          <div className="field">
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontWeight: 400 }}>
              <input type="checkbox" checked={draft.appendToSent} onChange={(e) => setDraft({ ...draft, appendToSent: e.target.checked })} />
              Put a copy of every reply in the mailbox&rsquo;s Sent folder
            </label>
            <span style={{ ...MUTED, fontSize: '0.8125rem' }}>
              Leave this off and replies live here only. Switch it on and your phone&rsquo;s mail app shows
              them too.
            </span>
          </div>
          <div className="field">
            <label>Name on replies</label>
            <input value={draft.fromName} onChange={(e) => setDraft({ ...draft, fromName: e.target.value })} placeholder="Deskwell" />
          </div>
          <div className="field">
            <label>How replies are sent</label>
            <select
              value={draft.sendTransport}
              onChange={(e) => setDraft({ ...draft, sendTransport: e.target.value as 'brevo' | 'smtp' })}
            >
              <option value="brevo">The site&rsquo;s usual email service</option>
              <option value="smtp">Its own mail server</option>
            </select>
            <span style={{ ...MUTED, fontSize: '0.8125rem' }}>
              Whichever you pick, this address has to be verified with the service that sends it, or
              the first reply will bounce straight back.
            </span>
          </div>
          {draft.sendTransport === 'smtp' && (
            <>
              <div className="field">
                <label>Outgoing server</label>
                <input value={draft.smtpHost} onChange={(e) => setDraft({ ...draft, smtpHost: e.target.value })} />
              </div>
              <div className="field">
                <label>Port</label>
                <input value={draft.smtpPort} onChange={(e) => setDraft({ ...draft, smtpPort: e.target.value })} placeholder="587" />
              </div>
              <div className="field">
                <label>Username</label>
                <input value={draft.smtpUsername} onChange={(e) => setDraft({ ...draft, smtpUsername: e.target.value })} />
              </div>
              <div className="field">
                <label>Password <span style={{ ...MUTED, fontWeight: 400 }}>(leave blank to keep the one saved)</span></label>
                <input type="password" value={draft.smtpPassword} onChange={(e) => setDraft({ ...draft, smtpPassword: e.target.value })} />
              </div>
            </>
          )}
          <div className="field">
            <label>Signature <span style={{ ...MUTED, fontWeight: 400 }}>(optional)</span></label>
            <textarea rows={3} value={draft.signatureHtml} onChange={(e) => setDraft({ ...draft, signatureHtml: e.target.value })} />
          </div>

          <div className="field">
            <label>Who can read this inbox</label>
            <span style={{ ...MUTED, fontSize: '0.8125rem', display: 'block', marginBottom: '0.5rem' }}>
              Tick nobody and it is open to everyone who can see the inbox at all. Tick anybody and it
              becomes theirs alone - which is how the accounts address stays away from the rest of the team.
            </span>
            <div style={{ display: 'grid', gap: '0.375rem' }}>
              {users.map((u) => {
                const row = staff.find((s) => s.userId === u.id)
                return (
                  <div key={u.id} style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontWeight: 400 }}>
                      <input type="checkbox" checked={!!row} onChange={() => toggleStaff(u.id)} />
                      {u.name} <span style={{ ...MUTED, fontSize: '0.8125rem' }}>{u.email}</span>
                    </label>
                    {row && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontWeight: 400, ...MUTED, fontSize: '0.8125rem' }}>
                        <input type="checkbox" checked={row.canReply} onChange={() => toggleReply(u.id)} />
                        can reply
                      </label>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Save inbox</button>
            <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Module settings
// ---------------------------------------------------------------------------

function ModuleSettingsSection({ settings, inboxes, busy, call }: {
  settings: Settings
  inboxes: Inbox[]
  busy: boolean
  call: Caller
}) {
  const [draft, setDraft] = useState(settings)
  // Re-seed the form when a save brings fresh settings back. Adjusting state
  // during render rather than in an effect: React re-runs this component
  // immediately with the new value instead of painting the stale one first.
  const [seeded, setSeeded] = useState(settings)
  if (seeded !== settings) {
    setSeeded(settings)
    setDraft(settings)
  }

  async function save() {
    await call('/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        backfillMonths: Number(draft.backfillMonths) || 12,
        retentionMonths: draft.retentionMonths === null ? null : Number(draft.retentionMonths) || null,
        attachmentFetch: draft.attachmentFetch,
        autoLink: draft.autoLink,
        defaultInboxId: draft.defaultInboxId || null,
      }),
    })
  }

  return (
    <section className="card">
      <div style={LABEL_STYLE}>How much mail to keep</div>
      <p style={{ ...MUTED, fontSize: '0.875rem', marginTop: 0 }}>
        Mail is collected on a schedule rather than the second it arrives - about once an hour on a
        paid hosting plan, and once a day on the free one. There is a Check now button for when you
        cannot wait.
      </p>

      <div className="field">
        <label>How far back to go when starting out <span style={{ ...MUTED, fontWeight: 400 }}>(months)</span></label>
        <input
          type="number"
          value={draft.backfillMonths}
          onChange={(e) => setDraft({ ...draft, backfillMonths: Number(e.target.value) })}
        />
      </div>
      <div className="field">
        <label>Delete conversations older than <span style={{ ...MUTED, fontWeight: 400 }}>(months, blank to keep everything)</span></label>
        <input
          type="number"
          value={draft.retentionMonths ?? ''}
          onChange={(e) => setDraft({ ...draft, retentionMonths: e.target.value === '' ? null : Number(e.target.value) })}
        />
      </div>
      <div className="field">
        <label>Attachments</label>
        <select
          value={draft.attachmentFetch}
          onChange={(e) => setDraft({ ...draft, attachmentFetch: e.target.value as Settings['attachmentFetch'] })}
        >
          <option value="lazy">Fetch one when somebody opens it</option>
          <option value="always">Fetch everything as it arrives</option>
          <option value="never">Never fetch them</option>
        </select>
      </div>
      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontWeight: 400 }}>
          <input type="checkbox" checked={draft.autoLink} onChange={(e) => setDraft({ ...draft, autoLink: e.target.checked })} />
          Attach an order or a purchase order to a conversation when the message mentions one
        </label>
      </div>
      <div className="field">
        <label>Which inbox opens first</label>
        <select
          value={draft.defaultInboxId ?? ''}
          onChange={(e) => setDraft({ ...draft, defaultInboxId: e.target.value || null })}
        >
          <option value="">Whichever comes first</option>
          {inboxes.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
      </div>

      <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Save settings</button>
    </section>
  )
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** A textarea of one-per-line values, back and forth. Commas are accepted too,
 *  because somebody will type them. */
function linesToList(value: string): string[] {
  return [...new Set(
    value.split(/[\n,]+/).map((line) => line.trim().toLowerCase()).filter(Boolean),
  )]
}

function PeopleSettingsSection({ settings, inboxes, counts, busy, call }: {
  settings: Settings
  inboxes: Inbox[]
  counts: { people: number; organisations: number }
  busy: boolean
  call: Caller
}) {
  const [seeded, setSeeded] = useState(settings)
  const [own, setOwn] = useState((settings.ownDomains ?? []).join('\n'))
  const [overrideOwn, setOverrideOwn] = useState(settings.ownDomains !== null)
  const [personal, setPersonal] = useState(settings.personalDomains.join('\n'))
  const [order, setOrder] = useState(settings.orderNumberPattern ?? '')
  const [po, setPo] = useState(settings.poNumberPattern ?? '')
  const [quote, setQuote] = useState(settings.quoteNumberPattern ?? '')
  if (seeded !== settings) {
    setSeeded(settings)
    setOwn((settings.ownDomains ?? []).join('\n'))
    setOverrideOwn(settings.ownDomains !== null)
    setPersonal(settings.personalDomains.join('\n'))
    setOrder(settings.orderNumberPattern ?? '')
    setPo(settings.poNumberPattern ?? '')
    setQuote(settings.quoteNumberPattern ?? '')
  }

  // What the module will treat as one of your own domains if you leave it to
  // work it out: the domains of the addresses you collect mail on.
  const inferred = [...new Set(
    inboxes
      .map((i) => i.address.split('@')[1]?.toLowerCase())
      .filter((d): d is string => !!d),
  )]

  async function save() {
    await call('/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        ownDomains: overrideOwn ? linesToList(own) : null,
        personalDomains: linesToList(personal),
        orderNumberPattern: order.trim() === '' ? null : order,
        poNumberPattern: po.trim() === '' ? null : po,
        quoteNumberPattern: quote.trim() === '' ? null : quote,
      }),
    })
  }

  return (
    <section className="card">
      <div style={LABEL_STYLE}>People</div>
      <p style={{ ...MUTED, fontSize: '0.875rem', marginTop: 0 }}>
        Messages from the same person are gathered together so you can see everything they have
        ever said in one place. It is deliberately simple: who somebody is, how to reach them, and
        which company their address belongs to. Nothing more than that.
      </p>
      <p style={{ ...MUTED, fontSize: '0.875rem' }}>
        {counts.people === 0
          ? 'Nobody yet. People appear as mail is collected.'
          : `${counts.people} ${counts.people === 1 ? 'person' : 'people'} so far, across ${counts.organisations} ${counts.organisations === 1 ? 'company' : 'companies'}.`}
      </p>

      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={!overrideOwn}
            onChange={(e) => setOverrideOwn(!e.target.checked)}
          />
          Work out which addresses are your colleagues&rsquo; from the addresses you collect mail on
        </label>
        {!overrideOwn && (
          <p style={{ ...MUTED, fontSize: '0.8125rem' }}>
            {inferred.length > 0
              ? `Anybody at ${inferred.join(', ')} is treated as one of you rather than as a customer.`
              : 'Add an inbox and the domain it uses will be treated as yours.'}
          </p>
        )}
      </div>

      {overrideOwn && (
        <div className="field">
          <label>Your own domains <span style={{ ...MUTED, fontWeight: 400 }}>(one per line)</span></label>
          <textarea rows={3} value={own} onChange={(e) => setOwn(e.target.value)} />
          <p style={{ ...MUTED, fontSize: '0.8125rem' }}>
            Anybody writing from one of these is a colleague, not a customer, and no record is kept
            of them.
          </p>
        </div>
      )}

      <div className="field">
        <label>Other free email providers <span style={{ ...MUTED, fontWeight: 400 }}>(one per line)</span></label>
        <textarea rows={2} value={personal} onChange={(e) => setPersonal(e.target.value)} />
        <p style={{ ...MUTED, fontSize: '0.8125rem' }}>
          The usual ones are already known. Add any others your customers use, so their email
          provider does not get mistaken for the company they work for.
        </p>
      </div>

      <div style={{ ...LABEL_STYLE, marginTop: '1rem' }}>Spotting references</div>
      <p style={{ ...MUTED, fontSize: '0.875rem', marginTop: 0 }}>
        When somebody quotes an order or purchase order number, it gets attached to the
        conversation. Nothing is attached until we have checked the number really exists, and
        anything attached this way says so and comes off in one click. Leave a box empty unless
        your numbers look unusual.
      </p>
      <div className="field">
        <label>Order numbers look like</label>
        <input value={order} placeholder="the usual pattern" onChange={(e) => setOrder(e.target.value)} />
      </div>
      <div className="field">
        <label>Purchase order numbers look like</label>
        <input value={po} placeholder="the usual pattern" onChange={(e) => setPo(e.target.value)} />
      </div>
      <div className="field">
        <label>Quote references look like</label>
        <input value={quote} placeholder="the usual pattern" onChange={(e) => setQuote(e.target.value)} />
      </div>

      <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Save people settings</button>
    </section>
  )
}
