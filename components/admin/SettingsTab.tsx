'use client'

import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import type { Data } from '@puckeditor/core'
import MarkdownEditor from './MarkdownEditor'
import { WebhooksSection, SETTINGS_SECTION_HEADING } from './WebhooksSection'
import { FolderPicker } from './FolderPicker'
import { ConfirmDialog } from './inbox/ConfirmDialog'
import { InboxStyles } from './inbox/styles'

// Puck and its stylesheet are a large import for a screen most people open to
// change a folder name, so the signature builder only arrives if they ask for
// it.
const SignaturePuckEditor = dynamic(() => import('./SignaturePuckEditor'), {
  ssr: false,
  loading: () => (
    <div style={{ height: 560, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)' }}>
      Loading the builder…
    </div>
  ),
})

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
  foldersOnly: boolean
  discardUnrouted: boolean
  /** What this account's mail server last said its folders were called, or null
   *  if nobody has asked it yet. Kept on the account rather than fetched when a
   *  form opens: listing folders means opening somebody's mailbox, which is not
   *  a thing to do on a page load. */
  discoveredFolders: MailFolder[] | null
  foldersCheckedAt: string | null
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
  signatureKind: SignatureKind
  signature: string | null
  signatureHtml: string | null
  signaturePuck: unknown
  appendToSent: boolean
  /** Reserved. Stored and validated, but nothing on any screen sets it yet -
   *  it is here for the day inboxes are colour-coded in the list. */
  colour: string | null
  sortOrder: number
}

type SignatureKind = 'markdown' | 'html' | 'puck'

const SIGNATURE_KIND_OPTIONS: Array<{ value: SignatureKind; label: string; hint: string }> = [
  { value: 'markdown', label: 'Rich text', hint: 'Type it. Bold, links, lists - nothing to think about.' },
  { value: 'html', label: 'HTML', hint: 'Paste the signature your organisation already uses.' },
  { value: 'puck', label: 'Page builder', hint: 'Build it out of blocks, the way you build a page.' },
]

const SIGNATURE_MERGE_TAGS: Array<{ tag: string; label: string }> = [
  { tag: '{{FROM_NAME}}', label: 'the name replies go out under' },
  { tag: '{{INBOX_NAME}}', label: 'what this inbox is called' },
  { tag: '{{EMAIL}}', label: 'this inbox\u2019s address' },
]

type AccessRow = { inboxId: string; userId: string; canReply: boolean }

type Settings = {
  backfillMonths: number
  retentionMonths: number | null
  retentionKeepLinked: boolean
  retentionLastRunAt: string | null
  attachmentFetch: 'lazy' | 'always' | 'never'
  autoLink: boolean
  newestFirst: boolean
  defaultInboxId: string | null
  ownDomains: string[] | null
  personalDomains: string[]
  orderNumberPattern: string | null
  poNumberPattern: string | null
  quoteNumberPattern: string | null
  trackOpens: boolean
  requestReadReceipts: boolean
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
  /** What the window would remove on its next pass, and what is being held back
   *  only because it is attached to one of the site's own records. Null when no
   *  window is set, which is where every site starts. */
  retention: { cutoff: string; due: number; keptForLinks: number } | null
  users: StaffMember[]
  encryptionReady: boolean
}

type MailFolder = { path: string; name: string; role: string | null }

const MUTED = { color: 'var(--color-text-muted)' } as const

// One heading style for every section on this screen, including the Webhooks
// one below. It is defined in that file rather than this one only because this
// file already imports it and the other way round would be a circle; the two of
// them used to disagree, and the last heading looked nothing like the five
// above it.
const LABEL_STYLE = SETTINGS_SECTION_HEADING

/** The look of a `.field` label, for the two places where the thing being named
 *  is a group of controls rather than one of them. A `<label>` there would have
 *  nothing to point at, which is how a screen reader ends up announcing a row of
 *  unnamed tickboxes. */
const GROUP_LABEL = {
  display: 'block',
  fontSize: 'var(--text-sm)',
  fontWeight: 'var(--font-medium)',
  color: 'var(--color-text)',
  lineHeight: 'var(--leading-sm)',
} as const

/** Something to tell the person at the screen, and whether it is good news.
 *  Success and failure used to be the same grey box, so "Connected. Found 5
 *  folders." and "That did not work." looked identical. */
type Note = { tone: 'ok' | 'bad'; text: string }

function NoteAlert({ note }: { note: Note | null }) {
  if (!note) return null
  return (
    <div
      className={note.tone === 'ok' ? 'alert alert-success' : 'alert alert-danger'}
      role={note.tone === 'ok' ? 'status' : 'alert'}
      style={{ marginBottom: '1rem' }}
    >
      {note.text}
    </div>
  )
}

/** What to say when the request never arrived at all. Every caller in here says
 *  the same thing, because from the screen's point of view it is the same
 *  thing. */
const OFFLINE = 'Could not reach the site. Check your connection and try again.'

/** Ask a mail account what its folders are called. The answer is kept against
 *  the account server-side, so every caller finishes with a reload rather than
 *  holding a list of its own - the two folder pickers and the mail account list
 *  all draw the same one, and only one of them used to. */
async function fetchFolders(connectionId: string): Promise<
  { ok: true; count: number } | { ok: false; error: string }
> {
  try {
    const res = await fetch(`${API}/connections/${connectionId}/test`, { method: 'POST' })
    const body = await res.json().catch(() => ({}))
    // Both: the request has to have been answered at all, and the answer has to
    // say the mailbox opened. Reading only the second one meant a refusal was
    // told apart from a bad password by luck rather than by asking.
    if (res.ok && body.ok) {
      return { ok: true, count: Array.isArray(body.folders) ? body.folders.length : 0 }
    }
    return { ok: false, error: (body as { error?: string }).error ?? 'That did not work.' }
  } catch {
    return { ok: false, error: OFFLINE }
  }
}

function blankConnection() {
  return {
    label: '', imapHost: '', imapPort: 993, imapUsername: '', imapPassword: '', imapTls: true, extraFolders: '',
    foldersOnly: false, discardUnrouted: false,
  }
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
    signatureKind: 'markdown' as SignatureKind,
    signature: '',
    signatureHtml: '',
    signaturePuck: null as unknown,
    appendToSent: false,
    sortOrder: 0,
  }
}

type ConnectionDraft = ReturnType<typeof blankConnection>
type InboxDraft = ReturnType<typeof blankInbox>

export function UnifiedInboxSettingsTab() {
  const [data, setData] = useState<Payload | null>(null)
  const [message, setMessage] = useState<Note | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/settings`)
      if (!res.ok) {
        setMessage({ tone: 'bad', text: 'Could not load the inbox settings.' })
        return
      }
      setData(await res.json())
    } catch {
      setMessage({ tone: 'bad', text: OFFLINE })
    }
  }, [])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async loader; every setState runs after an await
  useEffect(() => { void load() }, [load])

  const call = useCallback(async (path: string, init: RequestInit, okText?: string | null): Promise<unknown | null> => {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch(`${API}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setMessage({ tone: 'bad', text: (body as { error?: string }).error ?? 'That did not work.' })
        return null
      }
      // Said before the reload, so that if the reload is the thing that fails,
      // its own bad news is what stays on the screen.
      if (okText) setMessage({ tone: 'ok', text: okText })
      await load()
      return body
    } catch {
      // Without this the request that never landed would leave every Save button
      // on the screen greyed out until the page was loaded again, and nothing
      // would say why.
      setMessage({ tone: 'bad', text: OFFLINE })
      return null
    } finally {
      setBusy(false)
    }
  }, [load])

  // A screen that could not load says so and offers to try again. It used to
  // render as nothing at all, message and all.
  if (!data) {
    return (
      <div>
        {message ? (
          <>
            <NoteAlert note={message} />
            <button type="button" className="btn btn-secondary" onClick={() => void load()}>Try again</button>
          </>
        ) : (
          <p style={MUTED}>Loading&hellip;</p>
        )}
      </div>
    )
  }

  return (
    <div>
      {/* The module's own stylesheet, for the are-you-sure dialogs below. */}
      <InboxStyles />
      <p style={{ ...MUTED, marginBottom: '1.5rem' }}>
        One place for every conversation with a customer or a supplier. Point it at the mail account
        you already use, tell it which addresses people write to, and decide who is allowed to read
        which of them.
      </p>

      <NoteAlert note={message} />

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
        setMessage={setMessage}
        reload={load}
      />

      <ModuleSettingsSection
        settings={data.settings}
        inboxes={data.inboxes}
        retention={data.retention ?? null}
        busy={busy}
        call={call}
      />

      <DeliveryReceiptsSection
        settings={data.settings}
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

      <WebhooksSection inboxes={data.inboxes} />
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

type Caller = (path: string, init: RequestInit, okText?: string | null) => Promise<unknown | null>

function ConnectionsSection({ connections, collection, busy, call, setMessage, reload }: {
  connections: Connection[]
  collection: CollectionStat[]
  busy: boolean
  call: Caller
  setMessage: (n: Note | null) => void
  reload: () => Promise<void>
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<ConnectionDraft>(blankConnection())
  const [testing, setTesting] = useState<string | null>(null)
  const [checking, setChecking] = useState<string | null>(null)
  // Which mail account the Remove question is about. Null when nothing is asked.
  const [removing, setRemoving] = useState<Connection | null>(null)
  const fid = useId()
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
      foldersOnly: connection.foldersOnly,
      discardUnrouted: connection.discardUnrouted,
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
      foldersOnly: draft.foldersOnly,
      discardUnrouted: draft.discardUnrouted,
      ...(draft.imapPassword ? { imapPassword: draft.imapPassword } : {}),
    }
    const result = editing === 'new'
      ? await call('/connections', { method: 'POST', body: JSON.stringify(body) }, 'Mail account saved.')
      : await call(`/connections/${editing}`, { method: 'PATCH', body: JSON.stringify(body) }, 'Mail account saved.')
    if (result) setEditing(null)
  }

  async function remove(id: string) {
    await call(`/connections/${id}`, { method: 'DELETE' }, 'Mail account removed.')
  }

  async function test(id: string) {
    setTesting(id)
    setMessage(null)
    try {
      const result = await fetchFolders(id)
      if (result.ok) {
        setMessage({ tone: 'ok', text: `Connected. Found ${result.count} folder${result.count === 1 ? '' : 's'}.` })
        // The folders it found are kept against the account, so they arrive
        // back with everything else rather than in a copy held here.
        await reload()
      } else {
        setMessage({ tone: 'bad', text: result.error })
      }
    } finally {
      // In a finally, so a test that never comes back does not leave the button
      // greyed out and reading "Testing..." for the rest of the visit.
      setTesting(null)
    }
  }

  // Deliberately a longer wait than the hourly check gets: this runs with a
  // minute of its own rather than a slice of the shared one, because somebody
  // is stood here watching it.
  async function checkNow(id: string) {
    setChecking(id)
    setMessage(null)
    try {
      const res = await fetch(`${API}/check-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: id }),
      })
      const body = await res.json().catch(() => ({}))
      setMessage(res.ok
        ? { tone: 'ok', text: body.message ?? 'Checked.' }
        : { tone: 'bad', text: body.error ?? 'That did not work.' })
      await reload()
    } catch {
      setMessage({ tone: 'bad', text: OFFLINE })
    } finally {
      setChecking(null)
    }
  }

  return (
    <section className="card" style={{ marginBottom: '1.5rem' }}>
      <h3 style={LABEL_STYLE}>Mail accounts</h3>
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
              // Destructive-hover rather than danger: danger on text this small
              // does not clear AA on a pale ground.
              <span style={{ color: 'var(--color-destructive-hover)', fontSize: '0.875rem' }}>No password saved</span>
            )}
          </div>
          <div style={{ ...MUTED, fontSize: '0.8125rem', marginTop: '0.25rem' }}>
            {connection.lastSyncAt
              // Whatever the mail server said is deliberately not repeated here:
              // it is written for whoever runs the mail server, and Test
              // connection is the button that gets to the bottom of it.
              ? `Last checked ${new Date(connection.lastSyncAt).toLocaleString('en-GB')}${
                  connection.lastSyncStatus === 'error' ? ' - it did not work. Try Test connection.' : ''
                }`
              : 'Never checked yet.'}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => startEdit(connection)}>Edit</button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={testing === connection.id} onClick={() => test(connection.id)}>
              {testing === connection.id ? 'Testing…' : 'Test connection'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={checking === connection.id} onClick={() => checkNow(connection.id)}>
              {checking === connection.id ? 'Checking…' : 'Check now'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setRemoving(connection)}>Remove</button>
          </div>
          <CollectionProgress stat={stats.get(connection.id)} />
          {connection.discoveredFolders && connection.discoveredFolders.length > 0 && (
            <div style={{ ...MUTED, fontSize: '0.8125rem', marginTop: '0.5rem' }}>
              Folders found: {connection.discoveredFolders.map((f) => f.path).join(', ')}
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
            <label htmlFor={`${fid}-label`}>What to call it</label>
            <input id={`${fid}-label`} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Office mail" />
          </div>
          <div className="field">
            <label htmlFor={`${fid}-host`}>Mail server</label>
            <input id={`${fid}-host`} value={draft.imapHost} onChange={(e) => setDraft({ ...draft, imapHost: e.target.value })} placeholder="imap.mail.me.com" />
          </div>
          <div className="field">
            <label htmlFor={`${fid}-port`}>Port</label>
            <input id={`${fid}-port`} type="number" value={draft.imapPort} onChange={(e) => setDraft({ ...draft, imapPort: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label htmlFor={`${fid}-user`}>Username</label>
            <input id={`${fid}-user`} value={draft.imapUsername} onChange={(e) => setDraft({ ...draft, imapUsername: e.target.value })} placeholder="you@yourcompany.co.uk" />
          </div>
          <div className="field">
            <label htmlFor={`${fid}-pass`}>
              Password{' '}
              {editing !== 'new' && <span style={{ ...MUTED, fontWeight: 400 }}>(leave blank to keep the one saved)</span>}
            </label>
            <input id={`${fid}-pass`} type="password" value={draft.imapPassword} onChange={(e) => setDraft({ ...draft, imapPassword: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor={`${fid}-extra`}>Other folders to read <span style={{ ...MUTED, fontWeight: 400 }}>(optional, separated by commas)</span></label>
            <input id={`${fid}-extra`} value={draft.extraFolders} onChange={(e) => setDraft({ ...draft, extraFolders: e.target.value })} placeholder="Archive, Suppliers" />
          </div>
          <div className="field">
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontWeight: 400 }}>
              <input type="checkbox" checked={draft.foldersOnly} onChange={(e) => setDraft({ ...draft, foldersOnly: e.target.checked })} />
              Read only the folders named here and on the addresses below
            </label>
            <div style={{ ...MUTED, fontSize: '0.8125rem', marginTop: '0.25rem' }}>
              Normally the main inbox, the archive and the sent folder are read as well, so nothing is missed when
              you file something on your phone. Tick this if the account also carries post of your own: it then
              reads the folders you have named and nothing else.
            </div>
          </div>
          <div className="field">
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontWeight: 400 }}>
              <input type="checkbox" checked={draft.discardUnrouted} onChange={(e) => setDraft({ ...draft, discardUnrouted: e.target.checked })} />
              Ignore mail that is not addressed to one of your addresses
            </label>
            <div style={{ ...MUTED, fontSize: '0.8125rem', marginTop: '0.25rem' }}>
              Normally that mail is kept out of the way under Unrouted, in case somebody writes to an address you
              have not set up yet. Tick this and it is not kept at all. Replies to conversations already here
              still arrive either way.
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Save mail account</button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={removing !== null}
        title="Remove this mail account?"
        body={removing
          ? `Nothing more will be collected from ${removing.label}. Everything already gathered stays exactly where it is.`
          : ''}
        confirmLabel="Remove it"
        destructive
        busy={busy}
        onCancel={() => { if (!busy) setRemoving(null) }}
        // Left open while the removal is in flight: the dialog greys its own two
        // answers out, and closes once the work is finished either way, so the
        // outcome is read on the screen behind it.
        onConfirm={() => {
          const connection = removing
          if (connection) void remove(connection.id).finally(() => setRemoving(null))
        }}
      />
    </section>
  )
}

// ---------------------------------------------------------------------------
// Inboxes
// ---------------------------------------------------------------------------

function InboxesSection({ inboxes, connections, access, users, busy, call, setMessage, reload }: {
  inboxes: Inbox[]
  connections: Connection[]
  access: AccessRow[]
  users: StaffMember[]
  busy: boolean
  call: Caller
  setMessage: (n: Note | null) => void
  reload: () => Promise<void>
}) {
  const [senderWarning, setSenderWarning] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<InboxDraft>(blankInbox())
  const [staff, setStaff] = useState<AccessRow[]>([])
  // Which inbox the Remove question is about. Null when nothing is asked.
  const [removing, setRemoving] = useState<Inbox | null>(null)
  const [refreshingFolders, setRefreshingFolders] = useState(false)
  const fid = useId()

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
      signatureKind: inbox.signatureKind ?? 'markdown',
      signature: inbox.signature ?? '',
      signatureHtml: inbox.signatureHtml ?? '',
      signaturePuck: inbox.signaturePuck ?? null,
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
      // All three kinds go up on every save, not only the one showing: somebody
      // trying the builder out must not lose the signature they typed first.
      signatureKind: draft.signatureKind,
      signature: draft.signature || null,
      signatureHtml: draft.signatureHtml || null,
      signaturePuck: draft.signaturePuck ?? null,
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
    // Who may read it goes up separately. The form stays open if that half does
    // not land, because closing on it left the staff list silently unapplied
    // with a cheerful message on the screen.
    const access = await call(`/inboxes/${saved.inbox.id}/access`, {
      method: 'PUT',
      body: JSON.stringify({ entries: staff.map((s) => ({ userId: s.userId, canReply: s.canReply })) }),
    }, 'Inbox saved.')
    if (!access) return
    // Saved either way. This only says whether replies will actually leave the
    // building yet, which is a different question and one worth answering while
    // the person who can fix it is still here (E15).
    setSenderWarning(saved.senderWarning ?? null)
    setEditing(null)
  }

  async function remove(id: string) {
    await call(`/inboxes/${id}`, { method: 'DELETE' }, 'Inbox removed.')
  }

  function toggleStaff(userId: string) {
    setStaff((current) => current.some((s) => s.userId === userId)
      ? current.filter((s) => s.userId !== userId)
      : [...current, { inboxId: editing ?? '', userId, canReply: true }])
  }

  function toggleReply(userId: string) {
    setStaff((current) => current.map((s) => s.userId === userId ? { ...s, canReply: !s.canReply } : s))
  }

  // The mail account this address is collected from, and therefore whose
  // folders the two pickers below offer. An address needs no mail account at
  // all - a contact form writes into one - and in that case there is nothing to
  // list, so the pickers say so rather than offering an empty menu.
  const chosen = connections.find((c) => c.id === draft.connectionId) ?? null

  async function refreshFolders() {
    if (!chosen) return
    setRefreshingFolders(true)
    setMessage(null)
    try {
      const result = await fetchFolders(chosen.id)
      if (result.ok) {
        setMessage({ tone: 'ok', text: `Folder list updated. ${result.count} folder${result.count === 1 ? '' : 's'} on ${chosen.label}.` })
        // The form stays open and the draft stays exactly as it is: this
        // reloads the account's folder list, not the address being edited.
        await reload()
      } else {
        setMessage({ tone: 'bad', text: result.error })
      }
    } finally {
      setRefreshingFolders(false)
    }
  }

  return (
    <section className="card" style={{ marginBottom: '1.5rem' }}>
      <h3 style={LABEL_STYLE}>Inboxes</h3>
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
              {inbox.isCatchAll && <span style={{ ...MUTED, fontSize: '0.75rem' }}>Catch-all</span>}
            </div>
            <div style={{ ...MUTED, fontSize: '0.8125rem', marginTop: '0.25rem' }}>
              {rows.length === 0
                ? 'Anybody who can see the inbox can read this one.'
                : `Restricted to ${rows.length} ${rows.length === 1 ? 'person' : 'people'}.`}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => startEdit(inbox)}>Edit</button>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setRemoving(inbox)}>Remove</button>
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
            <label htmlFor={`${fid}-name`}>What to call it</label>
            <input id={`${fid}-name`} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Customer enquiries" />
          </div>
          <div className="field">
            <label htmlFor={`${fid}-address`}>Address</label>
            <input id={`${fid}-address`} value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} placeholder="hi@yourcompany.co.uk" />
          </div>
          <div className="field">
            <label htmlFor={`${fid}-conn`}>Mail account</label>
            <select id={`${fid}-conn`} value={draft.connectionId} onChange={(e) => setDraft({ ...draft, connectionId: e.target.value })}>
              <option value="">Not collected from a mailbox</option>
              {connections.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
          <FolderPicker
            id={`${fid}-folder`}
            label="Folder to read"
            value={draft.imapFolder}
            onChange={(imapFolder) => setDraft({ ...draft, imapFolder })}
            folders={chosen?.discoveredFolders ?? null}
            checkedAt={chosen?.foldersCheckedAt ?? null}
            connectionChosen={chosen !== null}
            refreshing={refreshingFolders}
            onRefresh={() => { void refreshFolders() }}
            placeholder="INBOX"
          />
          <FolderPicker
            id={`${fid}-sent`}
            label={<>Sent folder <span style={{ ...MUTED, fontWeight: 400 }}>(optional)</span></>}
            value={draft.sentFolder}
            onChange={(sentFolder) => setDraft({ ...draft, sentFolder })}
            folders={chosen?.discoveredFolders ?? null}
            checkedAt={chosen?.foldersCheckedAt ?? null}
            connectionChosen={chosen !== null}
            refreshing={refreshingFolders}
            onRefresh={() => { void refreshFolders() }}
            blankLabel="Work it out from the mail account"
            placeholder="Sent Messages"
          />
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
            <label htmlFor={`${fid}-fromname`}>Name on replies</label>
            <input id={`${fid}-fromname`} value={draft.fromName} onChange={(e) => setDraft({ ...draft, fromName: e.target.value })} placeholder="Your company" />
          </div>
          <div className="field">
            <label htmlFor={`${fid}-transport`}>How replies are sent</label>
            <select
              id={`${fid}-transport`}
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
                <label htmlFor={`${fid}-smtphost`}>Outgoing server</label>
                <input id={`${fid}-smtphost`} value={draft.smtpHost} onChange={(e) => setDraft({ ...draft, smtpHost: e.target.value })} />
              </div>
              <div className="field">
                {/* Same kind of box as the incoming port above it, which used to
                    be a number field while this one was not. */}
                <label htmlFor={`${fid}-smtpport`}>Port</label>
                <input id={`${fid}-smtpport`} type="number" value={draft.smtpPort} onChange={(e) => setDraft({ ...draft, smtpPort: e.target.value })} placeholder="587" />
              </div>
              <div className="field">
                <label htmlFor={`${fid}-smtpuser`}>Username</label>
                <input id={`${fid}-smtpuser`} value={draft.smtpUsername} onChange={(e) => setDraft({ ...draft, smtpUsername: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor={`${fid}-smtppass`}>Password <span style={{ ...MUTED, fontWeight: 400 }}>(leave blank to keep the one saved)</span></label>
                <input id={`${fid}-smtppass`} type="password" value={draft.smtpPassword} onChange={(e) => setDraft({ ...draft, smtpPassword: e.target.value })} />
              </div>
            </>
          )}
          <SignatureEditor draft={draft} setDraft={setDraft} />

          <div className="field" role="group" aria-labelledby={`${fid}-access-label`}>
            <span id={`${fid}-access-label`} style={GROUP_LABEL}>Who can read this inbox</span>
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
                        Can reply
                      </label>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Save inbox</button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={removing !== null}
        title="Remove this inbox?"
        body={removing
          ? `Conversations already collected for ${removing.address} are kept, but nothing new will be filed here.`
          : ''}
        confirmLabel="Remove it"
        destructive
        busy={busy}
        onCancel={() => { if (!busy) setRemoving(null) }}
        // Left open while the removal is in flight; see the mail account above.
        onConfirm={() => {
          const inbox = removing
          if (inbox) void remove(inbox.id).finally(() => setRemoving(null))
        }}
      />
    </section>
  )
}

// ---------------------------------------------------------------------------
// An inbox's signature
// ---------------------------------------------------------------------------

/** One signature per inbox, written whichever way suits the person writing it:
 *  typed as rich text, pasted as the markup the organisation already uses, or
 *  built out of the same blocks the site's emails are built from. All three are
 *  kept, so switching between them loses nothing.
 *
 *  The preview is rendered on the server on purpose - the block-built kind
 *  resolves the site's colours and fonts there, and a preview drawn any other
 *  way is a preview that can disagree with the email that goes out. */
function SignatureEditor({ draft, setDraft }: {
  draft: InboxDraft
  setDraft: React.Dispatch<React.SetStateAction<InboxDraft>>
}) {
  const [preview, setPreview] = useState<string | null>(null)
  const [previewShown, setPreviewShown] = useState(false)
  const [previewBusy, setPreviewBusy] = useState(false)
  // Whether the last attempt got an answer at all. Without this, a preview that
  // could not be drawn was reported as an empty signature, which is a lie about
  // somebody's own data.
  const [previewFailed, setPreviewFailed] = useState(false)
  const fid = useId()

  const handlePuckChange = useCallback(
    (data: Data) => setDraft((d) => ({ ...d, signaturePuck: data })),
    [setDraft],
  )

  async function refreshPreview() {
    setPreviewBusy(true)
    setPreviewFailed(false)
    try {
      const res = await fetch(`${API}/signature-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: draft.signatureKind,
          signature: draft.signature || null,
          signatureHtml: draft.signatureHtml || null,
          signaturePuck: draft.signaturePuck ?? null,
          name: draft.name,
          address: draft.address,
          fromName: draft.fromName || null,
        }),
      })
      if (!res.ok) {
        setPreview(null)
        setPreviewFailed(true)
      } else {
        const body = (await res.json()) as { html: string | null }
        setPreview(body.html)
      }
    } catch {
      setPreview(null)
      setPreviewFailed(true)
    } finally {
      setPreviewShown(true)
      setPreviewBusy(false)
    }
  }

  return (
    <div className="field" role="group" aria-labelledby={`${fid}-sig-label`}>
      {/* A group rather than one box: what it names is the row of choices below
          and whichever editor they open. */}
      <span id={`${fid}-sig-label`} style={GROUP_LABEL}>Signature <span style={{ ...MUTED, fontWeight: 400 }}>(optional)</span></span>
      <span style={{ ...MUTED, fontSize: '0.8125rem', display: 'block', marginBottom: '0.5rem' }}>
        Goes below a dividing line at the foot of every reply sent from this address, whoever sends it.
      </span>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.75rem' }}>
        {SIGNATURE_KIND_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setDraft((d) => ({ ...d, signatureKind: option.value }))}
            aria-pressed={draft.signatureKind === option.value}
            style={{
              flex: '1 1 12rem', textAlign: 'left', cursor: 'pointer',
              padding: '0.75rem', borderRadius: 6,
              // --color-primary, not --color-accent: the latter is not a token
              // this site has, and an unresolved variable takes the whole border
              // with it - so the chosen one was the only one without an edge.
              border: `1px solid ${draft.signatureKind === option.value ? 'var(--color-primary)' : 'var(--color-border)'}`,
              background: draft.signatureKind === option.value ? 'var(--color-primary-subtle)' : 'var(--color-bg)',
              color: 'var(--color-text)',
            }}
          >
            <span style={{ display: 'block', fontWeight: 600, fontSize: '0.875rem' }}>{option.label}</span>
            <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--color-text-secondary)', marginTop: '0.25rem' }}>
              {option.hint}
            </span>
          </button>
        ))}
      </div>

      {draft.signatureKind === 'markdown' && (
        <MarkdownEditor
          value={draft.signature}
          onChange={(value) => setDraft((d) => ({ ...d, signature: value }))}
          rows={6}
          ariaLabel="Signature"
          placeholder={'Kind regards,\nThe Sales Team\n\nYour company'}
        />
      )}

      {draft.signatureKind === 'html' && (
        <>
          <label htmlFor={`${fid}-sig-html`} className="sr-only">The signature markup</label>
          <textarea
            id={`${fid}-sig-html`}
            rows={12}
            spellCheck={false}
            maxLength={50000}
            value={draft.signatureHtml}
            onChange={(e) => setDraft((d) => ({ ...d, signatureHtml: e.target.value }))}
            placeholder="<table>…</table>"
            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.8125rem' }}
          />
          <span style={{ ...MUTED, fontSize: '0.75rem', display: 'block', marginTop: '0.5rem' }}>
            Tables, inline styles, images and links all come through as written. Scripts and anything
            that runs on its own - <code>onerror</code> and the like - are removed when you save,
            because this markup ends up in a customer&rsquo;s inbox rather than in here.
          </span>
        </>
      )}

      {draft.signatureKind === 'puck' && (
        <>
          <span style={{ ...MUTED, fontSize: '0.8125rem', display: 'block', marginBottom: '0.5rem' }}>
            The same blocks the site&rsquo;s emails are built from. Text blocks accept the tags below.
          </span>
          <SignaturePuckEditor value={draft.signaturePuck} onChange={handlePuckChange} />
        </>
      )}

      {draft.signatureKind !== 'markdown' && (
        <span style={{ ...MUTED, fontSize: '0.75rem', display: 'block', marginTop: '0.5rem' }}>
          Fill-in tags:{' '}
          {SIGNATURE_MERGE_TAGS.map((t, i) => (
            <span key={t.tag}>{i > 0 ? ', ' : ''}<code>{t.tag}</code> ({t.label})</span>
          ))}
        </span>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.75rem' }}>
        <button type="button" className="btn btn-secondary btn-sm" disabled={previewBusy} onClick={refreshPreview}>
          {previewBusy ? 'Working…' : 'Show me how it will look'}
        </button>
      </div>

      {previewShown && (
        preview ? (
          <div
            style={{
              marginTop: '0.75rem', padding: '1rem', borderRadius: 6,
              border: '1px solid var(--color-border)',
              // The one hex in the module, and it has to stay one. This is a
              // picture of what an email will look like where it lands, and an
              // inbox has a white page whichever theme the admin is wearing. A
              // token here would repaint the preview and stop it being a preview.
              background: '#ffffff', colorScheme: 'light', overflowX: 'auto',
            }}
            dangerouslySetInnerHTML={{ __html: preview }}
          />
        ) : previewFailed ? (
          <span role="alert" style={{ color: 'var(--color-destructive-hover)', fontSize: '0.8125rem', display: 'block', marginTop: '0.75rem' }}>
            The preview could not be drawn just now, so this is not a picture of an empty signature - it is
            no picture at all. Try it again in a moment.
          </span>
        ) : (
          <span style={{ ...MUTED, fontSize: '0.8125rem', display: 'block', marginTop: '0.75rem' }}>
            Nothing to show - this signature is empty, so replies go out without one.
          </span>
        )
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Module settings
// ---------------------------------------------------------------------------

function ModuleSettingsSection({ settings, inboxes, retention, busy, call }: {
  settings: Settings
  inboxes: Inbox[]
  retention: { cutoff: string; due: number; keptForLinks: number } | null
  busy: boolean
  call: Caller
}) {
  const [draft, setDraft] = useState(settings)
  // Re-seed the form when a save brings fresh settings back. Adjusting state
  // during render rather than in an effect: React re-runs this component
  // immediately with the new value instead of painting the stale one first.
  const [seeded, setSeeded] = useState(settings)
  const fid = useId()
  if (seeded !== settings) {
    setSeeded(settings)
    setDraft(settings)
  }

  // The count below is worked out from what is saved, not from what is being
  // typed above it, so while the two differ it is answering an old question.
  const windowEdited = draft.retentionMonths !== settings.retentionMonths
    || draft.retentionKeepLinked !== settings.retentionKeepLinked

  async function save() {
    await call('/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        backfillMonths: Number(draft.backfillMonths) || 12,
        retentionMonths: draft.retentionMonths === null ? null : Number(draft.retentionMonths) || null,
        retentionKeepLinked: draft.retentionKeepLinked,
        attachmentFetch: draft.attachmentFetch,
        autoLink: draft.autoLink,
        newestFirst: draft.newestFirst,
        defaultInboxId: draft.defaultInboxId || null,
      }),
    }, 'Settings saved.')
  }

  return (
    <section className="card" style={{ marginBottom: '1.5rem' }}>
      <h3 style={LABEL_STYLE}>How much mail to keep</h3>
      <p style={{ ...MUTED, fontSize: '0.875rem', marginTop: 0 }}>
        Mail is collected on a schedule rather than the second it arrives - about once an hour on a
        paid hosting plan, and once a day on the free one. There is a Check now button for when you
        cannot wait.
      </p>

      <div className="field">
        <label htmlFor={`${fid}-backfill`}>How far back to go when starting out <span style={{ ...MUTED, fontWeight: 400 }}>(months)</span></label>
        <input
          id={`${fid}-backfill`}
          type="number"
          value={draft.backfillMonths}
          onChange={(e) => setDraft({ ...draft, backfillMonths: Number(e.target.value) })}
        />
      </div>
      <div className="field">
        <label htmlFor={`${fid}-retention`}>Delete conversations older than <span style={{ ...MUTED, fontWeight: 400 }}>(months, blank to keep everything)</span></label>
        <input
          id={`${fid}-retention`}
          type="number"
          value={draft.retentionMonths ?? ''}
          onChange={(e) => setDraft({ ...draft, retentionMonths: e.target.value === '' ? null : Number(e.target.value) })}
        />
        <p style={{ ...MUTED, fontSize: '0.8125rem', margin: '0.375rem 0 0' }}>
          Blank means keep everything, which is how every site starts. Set a number and the
          conversations older than that are removed for good, a few hundred a night, along with any
          files attached to them. There is no way to get them back afterwards.
        </p>
      </div>
      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={draft.retentionKeepLinked}
            onChange={(e) => setDraft({ ...draft, retentionKeepLinked: e.target.checked })}
          />
          Keep a conversation for ever if it has an order, a purchase order or a quote attached
        </label>
        <p style={{ ...MUTED, fontSize: '0.8125rem', margin: '0.375rem 0 0' }}>
          Leave this on unless you have a reason not to. It is what stops a tidy-up aimed at old
          mailing lists taking the correspondence behind a disputed invoice with it.
        </p>
      </div>
      {retention && windowEdited && (
        <div className="alert alert-info">
          <p style={{ margin: 0 }}>
            Save to see what this would remove. The count below the box is worked out from the setting
            as it stands, not from what you have just typed.
          </p>
        </div>
      )}
      {retention && !windowEdited && (
        <div className="alert alert-info">
          <p style={{ margin: 0 }}>
            As things stand, the next tidy-up would remove <strong>{retention.due}</strong>{' '}
            conversation{retention.due === 1 ? '' : 's'} last written to before{' '}
            {new Date(retention.cutoff).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.
            {retention.keptForLinks > 0 && (
              <> Another <strong>{retention.keptForLinks}</strong> {retention.keptForLinks === 1 ? 'is' : 'are'} old
              enough but {retention.keptForLinks === 1 ? 'is' : 'are'} being kept because something is attached to{' '}
              {retention.keptForLinks === 1 ? 'it' : 'them'}.</>
            )}
          </p>
          {settings.retentionLastRunAt && (
            <p style={{ margin: '0.375rem 0 0', fontSize: '0.8125rem' }}>
              Last tidy-up: {new Date(settings.retentionLastRunAt).toLocaleString('en-GB')}.
            </p>
          )}
        </div>
      )}
      <div className="field">
        <label htmlFor={`${fid}-attach`}>Attachments</label>
        <select
          id={`${fid}-attach`}
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
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={draft.newestFirst}
            onChange={(e) => setDraft({ ...draft, newestFirst: e.target.checked })}
          />
          Show the newest message at the top of a conversation
        </label>
        <p style={{ ...MUTED, fontSize: '0.8125rem', margin: '0.375rem 0 0' }}>
          Off, a conversation reads top to bottom the way it happened. On, the latest message is
          the first thing you see and the writing box sits with it, which saves scrolling past a
          long back and forth to find out what was last said.
        </p>
      </div>
      <div className="field">
        <label htmlFor={`${fid}-default`}>Which inbox opens first</label>
        <select
          id={`${fid}-default`}
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
// Delivery receipts
// ---------------------------------------------------------------------------

type AccountRegistration = { label: string; ok: boolean; message: string }

/**
 * Whether to find out what became of a reply after it left.
 *
 * Both switches are off until somebody turns them on, and the copy says plainly
 * what each one does, because both of them amount to watching what a customer
 * did with an email. A site owner is entitled to do that; they are not entitled
 * to have it switched on for them by an update, and their privacy notice has to
 * mention it.
 */
function DeliveryReceiptsSection({ settings, busy, call }: {
  settings: Settings
  busy: boolean
  call: Caller
}) {
  const [draft, setDraft] = useState(settings)
  const [seeded, setSeeded] = useState(settings)
  if (seeded !== settings) {
    setSeeded(settings)
    setDraft(settings)
  }
  const [accounts, setAccounts] = useState<AccountRegistration[] | null>(null)

  async function save() {
    const body = await call('/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        trackOpens: draft.trackOpens,
        requestReadReceipts: draft.requestReadReceipts,
      }),
    }, 'Settings saved.')
    setAccounts((body as { brevoRegistrations?: AccountRegistration[] | null })?.brevoRegistrations ?? null)
  }

  return (
    <section className="card" style={{ marginBottom: '1.5rem' }}>
      <h3 style={LABEL_STYLE}>What happened to a reply after you sent it</h3>
      <p style={{ ...MUTED, fontSize: '0.875rem', marginTop: 0 }}>
        On its own, &ldquo;Sent&rdquo; only means the email service took the message off your hands.
        Switch these on and a reply can also tell you it arrived, that somebody opened it, or that it
        bounced straight back. Worth having when you are deciding whether to chase somebody.
      </p>

      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={draft.trackOpens}
            onChange={(e) => setDraft({ ...draft, trackOpens: e.target.checked })}
          />
          Tell me when a reply is delivered, opened or bounces
        </label>
        <p style={{ ...MUTED, fontSize: '0.8125rem', margin: '0.375rem 0 0' }}>
          Only works for addresses sending through Brevo. An open is worked out from a tiny invisible
          picture in the message, so it is a good clue rather than proof: some mail apps fetch that
          picture before anybody has read a word, and when that happens you are told so rather than
          told a fib. Anything sent through your own mail server carries on saying nothing but
          &ldquo;Sent&rdquo;.
        </p>
      </div>

      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={draft.requestReadReceipts}
            onChange={(e) => setDraft({ ...draft, requestReadReceipts: e.target.checked })}
          />
          Ask the person&rsquo;s own email program for a read receipt
        </label>
        <p style={{ ...MUTED, fontSize: '0.8125rem', margin: '0.375rem 0 0' }}>
          The old-fashioned kind. Most email programs ignore it and the rest ask the reader first, so
          expect an answer perhaps one time in ten, mostly from people in offices. When one does come
          back it lands on the message it belongs to rather than cluttering up the conversation.
        </p>
      </div>

      <div className="alert alert-info">
        <p style={{ margin: 0, fontSize: '0.875rem' }}>
          Both of these mean keeping a note of what somebody did with an email you sent them. If your
          privacy notice does not mention it yet, add a line before you switch them on.
        </p>
      </div>

      {accounts && accounts.length > 0 && (
        <div style={{ display: 'grid', gap: '0.375rem', margin: '0 0 0.75rem' }}>
          {accounts.map((account) => (
            <div
              key={account.label}
              className={account.ok ? 'alert alert-info' : 'alert alert-danger'}
              style={{ margin: 0 }}
            >
              <strong>{account.label}:</strong> {account.message}
            </div>
          ))}
        </div>
      )}

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
  // A pattern that cannot be searched for used to be accepted here and only fall
  // over later, out of sight.
  const [patternError, setPatternError] = useState<string | null>(null)
  const fid = useId()
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
    const patterns: Array<[string, string]> = [
      ['Order numbers look like', order],
      ['Purchase order numbers look like', po],
      ['Quote references look like', quote],
    ]
    for (const [label, value] of patterns) {
      if (value.trim() === '') continue
      try {
        // Built only to find out whether it can be.
        new RegExp(value)
      } catch {
        setPatternError(`"${label}" is not something we can search for. Digits are written [0-9]+, so a number like ABC-1024 is ABC-[0-9]+. Leave the box empty to use the usual one.`)
        return
      }
    }
    setPatternError(null)
    await call('/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        ownDomains: overrideOwn ? linesToList(own) : null,
        personalDomains: linesToList(personal),
        orderNumberPattern: order.trim() === '' ? null : order,
        poNumberPattern: po.trim() === '' ? null : po,
        quoteNumberPattern: quote.trim() === '' ? null : quote,
      }),
    }, 'People settings saved.')
  }

  return (
    <section className="card">
      <h3 style={LABEL_STYLE}>People</h3>
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
          <label htmlFor={`${fid}-own`}>Your own domains <span style={{ ...MUTED, fontWeight: 400 }}>(one per line)</span></label>
          <textarea id={`${fid}-own`} rows={3} value={own} onChange={(e) => setOwn(e.target.value)} />
          <p style={{ ...MUTED, fontSize: '0.8125rem' }}>
            Anybody writing from one of these is a colleague, not a customer, and no record is kept
            of them.
          </p>
        </div>
      )}

      <div className="field">
        <label htmlFor={`${fid}-personal`}>Other free email providers <span style={{ ...MUTED, fontWeight: 400 }}>(one per line)</span></label>
        <textarea id={`${fid}-personal`} rows={2} value={personal} onChange={(e) => setPersonal(e.target.value)} />
        <p style={{ ...MUTED, fontSize: '0.8125rem' }}>
          The usual ones are already known. Add any others your customers use, so their email
          provider does not get mistaken for the company they work for.
        </p>
      </div>

      <h3 style={{ ...LABEL_STYLE, marginTop: '1rem' }}>Spotting references</h3>
      <p style={{ ...MUTED, fontSize: '0.875rem', marginTop: 0 }}>
        When somebody quotes an order or purchase order number, it gets attached to the
        conversation. Nothing is attached until we have checked the number really exists, and
        anything attached this way says so and comes off in one click. Leave a box empty unless
        your numbers look unusual.
      </p>
      <p style={{ ...MUTED, fontSize: '0.8125rem', marginTop: 0 }}>
        If you do fill one in, write it the way it is printed with the digits shown as{' '}
        <code>[0-9]+</code>. A number like ABC-1024 is <code>ABC-[0-9]+</code>.
      </p>
      {patternError && (
        <div className="alert alert-danger" role="alert" style={{ marginBottom: '1rem' }}>{patternError}</div>
      )}
      <div className="field">
        <label htmlFor={`${fid}-order`}>Order numbers look like</label>
        <input id={`${fid}-order`} value={order} placeholder="ABC-[0-9]+" onChange={(e) => setOrder(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${fid}-po`}>Purchase order numbers look like</label>
        <input id={`${fid}-po`} value={po} placeholder="PO-[0-9]+" onChange={(e) => setPo(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${fid}-quote`}>Quote references look like</label>
        <input id={`${fid}-quote`} value={quote} placeholder="Q-[0-9]+" onChange={(e) => setQuote(e.target.value)} />
      </div>

      <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Save people settings</button>
    </section>
  )
}
