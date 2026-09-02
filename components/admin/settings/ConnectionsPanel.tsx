'use client'

import { useId, useMemo, useState } from 'react'
import { ConfirmDialog } from '../inbox/ConfirmDialog'
import { API, OFFLINE, fetchFolders } from './api'
import type { Caller, CollectionStat, Connection, Note } from './types'
import {
  CheckField, Chip, EditPanel, EmptyState, FieldGroup, FieldRow, FormActions,
  ListRow, ListRowHeader, MUTED, Panel,
} from './ui'

// ---------------------------------------------------------------------------
// Mail accounts: the mailboxes this reads.
//
// Copy here is written for somebody who runs a business, not a mail server:
// "mail account" rather than "IMAP connection", "the folder your mail app files
// things into" rather than "special-use mailbox".
// ---------------------------------------------------------------------------

function blankConnection() {
  return {
    label: '', imapHost: '', imapPort: 993, imapUsername: '', imapPassword: '', imapTls: true, extraFolders: '',
    foldersOnly: false, discardUnrouted: false,
  }
}

export type ConnectionDraft = ReturnType<typeof blankConnection>

/** How collection is getting on, in words an owner can use. Mail is gathered a
 *  bit at a time - every hour on most plans, once a day on the smallest one -
 *  so the honest answer to "is it done yet?" is usually "not yet, here is how
 *  far it has got". */
export function CollectionProgress({ stat }: { stat?: CollectionStat }) {
  if (!stat) return null
  const collected = stat.collected.toLocaleString('en-GB')
  if (stat.backfillComplete) {
    return (
      <div className="field-hint" style={{ marginTop: '0.5rem' }}>
        {collected} message{stat.collected === 1 ? '' : 's'} collected. All caught up.
      </div>
    )
  }
  const estimate = stat.estimated ? ` of about ${stat.estimated.toLocaleString('en-GB')}` : ''
  return (
    <div className="field-hint" style={{ marginTop: '0.5rem' }}>
      {collected}{estimate} message{stat.collected === 1 ? '' : 's'} collected so far. Older mail is
      still being fetched a bit at a time in the background.
    </div>
  )
}

/** Whether the account is working, said in two words at the top of its row
 *  rather than left to be worked out from a date halfway down it. */
export function connectionHealth(connection: Connection): { tone: 'ok' | 'bad' | 'plain'; label: string } {
  if (!connection.hasPassword) return { tone: 'bad', label: 'No password saved' }
  if (connection.lastSyncStatus === 'error') return { tone: 'bad', label: 'Not working' }
  if (!connection.lastSyncAt) return { tone: 'plain', label: 'Not checked yet' }
  return { tone: 'ok', label: 'Working' }
}

export function ConnectionsPanel({ connections, collection, busy, call, setMessage, reload }: {
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

  /** The add/edit form. Rendered where the account being edited sits, or at
   *  the foot of the list when it is a new one. */
  function connectionForm(title: string) {
    return (
      <EditPanel title={title}>
        <FieldGroup first title="What it is">
          <div className="field">
            <label htmlFor={`${fid}-label`}>What to call it</label>
            <input id={`${fid}-label`} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Office mail" />
            <span className="field-hint">Only you see this. &ldquo;Office mail&rdquo; will do.</span>
          </div>
        </FieldGroup>

        <FieldGroup
          title="How to get in"
          hint="Your email provider publishes all four of these - search for their incoming mail settings."
        >
          <FieldRow template="minmax(0, 3fr) minmax(0, 1fr)">
            <div className="field">
              <label htmlFor={`${fid}-host`}>Mail server</label>
              <input id={`${fid}-host`} value={draft.imapHost} onChange={(e) => setDraft({ ...draft, imapHost: e.target.value })} placeholder="imap.mail.me.com" />
            </div>
            <div className="field">
              <label htmlFor={`${fid}-port`}>Port</label>
              <input id={`${fid}-port`} type="number" value={draft.imapPort} onChange={(e) => setDraft({ ...draft, imapPort: Number(e.target.value) })} />
            </div>
          </FieldRow>
          <FieldRow>
            <div className="field">
              <label htmlFor={`${fid}-user`}>Username</label>
              <input id={`${fid}-user`} value={draft.imapUsername} onChange={(e) => setDraft({ ...draft, imapUsername: e.target.value })} placeholder="you@yourcompany.co.uk" />
              <span className="field-hint">Usually the full email address.</span>
            </div>
            <div className="field">
              <label htmlFor={`${fid}-pass`}>Password</label>
              <input id={`${fid}-pass`} type="password" value={draft.imapPassword} onChange={(e) => setDraft({ ...draft, imapPassword: e.target.value })} autoComplete="new-password" />
              <span className="field-hint">
                {editing === 'new'
                  ? 'The app password, not the one you log in with.'
                  : 'Leave blank to keep the one already saved.'}
              </span>
            </div>
          </FieldRow>
        </FieldGroup>

        <FieldGroup
          title="What to read"
          hint="The main inbox, your sent mail and your archive are read as a matter of course, so nothing is missed when you file something on your phone. Junk, Trash and Drafts are never read."
        >
          <div className="field">
            <label htmlFor={`${fid}-extra`}>Other folders to read <span style={{ ...MUTED, fontWeight: 400 }}>(optional)</span></label>
            <input id={`${fid}-extra`} value={draft.extraFolders} onChange={(e) => setDraft({ ...draft, extraFolders: e.target.value })} placeholder="Archive, Suppliers" />
            <span className="field-hint">Separated by commas, spelled the way your mail app spells them.</span>
          </div>
          <CheckField
            label="Read only the folders named here and on the addresses below"
            checked={draft.foldersOnly}
            onChange={(foldersOnly) => setDraft({ ...draft, foldersOnly })}
            hint="Tick this if the account also carries post of your own: it then reads the folders you have named and nothing else."
          />
          <CheckField
            label="Ignore mail that is not addressed to one of your addresses"
            checked={draft.discardUnrouted}
            onChange={(discardUnrouted) => setDraft({ ...draft, discardUnrouted })}
            hint="Normally that mail is kept out of the way under Not filed, in case somebody writes to an address you have not set up yet. Tick this and it is not kept at all. Replies to conversations already here still arrive either way."
          />
        </FieldGroup>

        <FormActions>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Save mail account</button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
        </FormActions>
      </EditPanel>
    )
  }

  return (
    <Panel
      title="The mailboxes this reads"
      blurb={<>
        One account can serve several addresses, and most sites need exactly one. If this is an
        iCloud, Google or Outlook mailbox you will need an app password rather than the password you
        log in with.
      </>}
    >
      {connections.length === 0 && editing === null && (
        <EmptyState>
          <p style={{ margin: '0 0 0.75rem' }}>No mailbox is being read yet, so nothing will arrive in the inbox.</p>
          <button type="button" className="btn btn-primary btn-sm" onClick={startNew}>Add a mail account</button>
        </EmptyState>
      )}

      {connections.map((connection) => {
        // The form opens where the row is. It used to open at the foot of the
        // list, so pressing Edit on the first of six accounts scrolled you past
        // the other five to a form that gave no sign of which one it was about.
        if (editing === connection.id) {
          return <div key={connection.id}>{connectionForm(`Editing ${connection.label}`)}</div>
        }
        const health = connectionHealth(connection)
        const folders = connection.discoveredFolders ?? []
        return (
          <ListRow key={connection.id}>
            <ListRowHeader
              title={connection.label}
              badges={<Chip tone={health.tone}>{health.label}</Chip>}
              subtitle={connection.imapUsername}
              meta={connection.lastSyncAt
                // Whatever the mail server said is deliberately not repeated
                // here: it is written for whoever runs the mail server, and Test
                // connection is the button that gets to the bottom of it.
                ? `Last checked ${new Date(connection.lastSyncAt).toLocaleString('en-GB')}${
                    connection.lastSyncStatus === 'error' ? ' - it did not work. Try Test connection.' : ''
                  }`
                : 'Never checked yet.'}
              actions={<>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => startEdit(connection)}>Edit</button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={testing === connection.id} onClick={() => test(connection.id)}>
                  {testing === connection.id ? 'Testing…' : 'Test connection'}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={checking === connection.id} onClick={() => checkNow(connection.id)}>
                  {checking === connection.id ? 'Checking…' : 'Check now'}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setRemoving(connection)}>Remove</button>
              </>}
            />
            <CollectionProgress stat={stats.get(connection.id)} />
            {folders.length > 0 && (
              // Folded away: a mailbox with thirty folders in it used to print
              // all thirty across the row, and none of them are news.
              <details style={{ marginTop: '0.5rem' }}>
                <summary style={{ ...MUTED, fontSize: 'var(--text-sm)', cursor: 'pointer' }}>
                  {folders.length} folder{folders.length === 1 ? '' : 's'} found
                </summary>
                <div className="field-hint" style={{ marginTop: '0.375rem', overflowWrap: 'anywhere' }}>
                  {folders.map((f) => f.path).join(', ')}
                </div>
              </details>
            )}
          </ListRow>
        )
      })}

      {editing === null && (
        <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: '0.25rem' }} onClick={startNew}>
          Add a mail account
        </button>
      )}

      {editing === 'new' && connectionForm('A new mail account')}

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
    </Panel>
  )
}
