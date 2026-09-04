'use client'

import { useId, useMemo, useState } from 'react'
import { FolderPicker } from '../FolderPicker'
import { ConfirmDialog } from '../inbox/ConfirmDialog'
import { fetchFolders } from './api'
import { SignatureEditor } from './SignatureEditor'
import { blankInbox, type InboxDraft } from './inbox-draft'
import type { AccessRow, Caller, Connection, DefaultInboxRow, Inbox, Note, StaffMember } from './types'
import {
  CheckField, Chip, EditPanel, EmptyState, FieldGroup, FieldRow, FormActions,
  ListRow, ListRowHeader, MUTED, Panel,
} from './ui'

// ---------------------------------------------------------------------------
// Inboxes: the addresses people write to.
//
// The longest form on the screen by a distance - an address, where it is
// collected from, how its replies go out, what they are signed with and who is
// allowed to read any of it. It asks all of that in five named groups rather
// than in one column of fourteen boxes, which is what it used to be.
// ---------------------------------------------------------------------------

export function InboxesPanel({ inboxes, connections, access, defaults, users, busy, call, setMessage, reload }: {
  inboxes: Inbox[]
  connections: Connection[]
  access: AccessRow[]
  defaults: DefaultInboxRow[]
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
  // Whose own address the inbox being edited is. Held as ids rather than as
  // rows because that is what goes back up, and because somebody can be given
  // an address without being on its guest list - an inbox nobody is named on is
  // open to everybody anyway.
  const [ownedBy, setOwnedBy] = useState<string[]>([])
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

  const connectionsById = useMemo(
    () => new Map(connections.map((c) => [c.id, c])),
    [connections],
  )

  const defaultsByInbox = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const row of defaults) {
      const list = map.get(row.inboxId)
      if (list) list.push(row.userId)
      else map.set(row.inboxId, [row.userId])
    }
    return map
  }, [defaults])

  /** The address somebody already calls their own, when it is not this one -
   *  so the screen can say what ticking the box is about to take away. */
  function ownInboxElsewhere(userId: string, thisInboxId: string | null): Inbox | null {
    const row = defaults.find((d) => d.userId === userId)
    if (!row || row.inboxId === thisInboxId) return null
    return inboxes.find((i) => i.id === row.inboxId) ?? null
  }

  function startNew() {
    setDraft(blankInbox())
    setStaff([])
    setOwnedBy([])
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
      folderOwnsMail: inbox.folderOwnsMail,
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
    setOwnedBy(defaultsByInbox.get(inbox.id) ?? [])
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
      folderOwnsMail: draft.folderOwnsMail,
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
    type Saved = { inbox?: Inbox; adopted?: number; senderWarning?: string | null }
    const saved = editing === 'new'
      ? await call('/inboxes', { method: 'POST', body: JSON.stringify(body) }) as Saved | null
      : await call(`/inboxes/${editing}`, { method: 'PATCH', body: JSON.stringify(body) }) as Saved | null
    if (!saved?.inbox) return
    // Who may read it goes up separately. The form stays open if that half does
    // not land, because closing on it left the staff list silently unapplied
    // with a cheerful message on the screen.
    const access = await call(`/inboxes/${saved.inbox.id}/access`, {
      method: 'PUT',
      body: JSON.stringify({
        entries: staff.map((s) => ({ userId: s.userId, canReply: s.canReply })),
        // Sent with the guest list rather than after it: they are one Save, and
        // half of it landing would leave somebody named as owning an address
        // they had just been taken off.
        defaultUserIds: ownedBy,
      }),
    }, 'Inbox saved.')
    if (!access) return
    // Saved either way. This only says whether replies will actually leave the
    // building yet, which is a different question and one worth answering while
    // the person who can fix it is still here (E15).
    setSenderWarning(saved.senderWarning ?? null)
    // Turning the folder rule on moves what was already sitting there. Said out
    // loud, because the whole reason somebody turns it on is one email they
    // cannot find, and silence leaves them wondering whether it worked.
    const adopted = saved.adopted ?? 0
    if (adopted > 0) {
      setMessage({
        tone: 'ok',
        text: `Inbox saved. ${adopted === 1 ? '1 conversation that was' : `${adopted} conversations that were`} already in that folder ${adopted === 1 ? 'has' : 'have'} been moved into it.`,
      })
    }
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

  function toggleOwn(userId: string) {
    setOwnedBy((current) => current.includes(userId)
      ? current.filter((id) => id !== userId)
      : [...current, userId])
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

  /** The add/edit form. Rendered where the address being edited sits, or at
   *  the foot of the list when it is a new one. */
  function inboxForm(title: string) {
    return (
      <EditPanel title={title}>
        <FieldGroup first title="The address">
          <FieldRow>
            <div className="field">
              <label htmlFor={`${fid}-name`}>What to call it</label>
              <input id={`${fid}-name`} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Customer enquiries" />
              <span className="field-hint">What your staff see in the inbox list.</span>
            </div>
            <div className="field">
              <label htmlFor={`${fid}-address`}>Address</label>
              <input id={`${fid}-address`} type="email" value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} placeholder="hi@yourcompany.co.uk" />
              <span className="field-hint">What your customers write to.</span>
            </div>
          </FieldRow>
        </FieldGroup>

        <FieldGroup
          title="Where it is collected from"
          hint="Which mailbox this address arrives in, and which folder of it to read."
        >
          <div className="field">
            <label htmlFor={`${fid}-conn`}>Mail account</label>
            <select id={`${fid}-conn`} value={draft.connectionId} onChange={(e) => setDraft({ ...draft, connectionId: e.target.value })}>
              <option value="">Not collected from a mailbox</option>
              {connections.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <span className="field-hint">
              Leave this as it is for an address you only ever send from - a contact form writing
              into it, say.
            </span>
          </div>
          <FieldRow template="repeat(auto-fit, minmax(min(100%, 20rem), 1fr))">
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
          </FieldRow>
          <CheckField
            label="Everything in that folder belongs to this address"
            checked={draft.folderOwnsMail}
            onChange={(folderOwnsMail) => setDraft({ ...draft, folderOwnsMail })}
            hint="For a folder you fill yourself. Anything sitting in it is collected, even when it was sent to some older address of yours. Mail that names one of your other addresses still goes to that one."
          />
          <CheckField
            label="Anything that does not match another address lands here"
            checked={draft.isCatchAll}
            onChange={(isCatchAll) => setDraft({ ...draft, isCatchAll })}
            hint="One address can be the catch-all. Without one, post for an address you have not set up is filed under Not filed, where only an administrator sees it."
          />
        </FieldGroup>

        <FieldGroup
          title="How replies go out"
          hint="Whichever service sends them, this address has to be verified with it, or the first reply will bounce straight back."
        >
          <FieldRow>
            <div className="field">
              <label htmlFor={`${fid}-fromname`}>Name on replies</label>
              <input id={`${fid}-fromname`} value={draft.fromName} onChange={(e) => setDraft({ ...draft, fromName: e.target.value })} placeholder="Your company" />
              <span className="field-hint">What your customer sees the reply is from.</span>
            </div>
            <div className="field">
              <label htmlFor={`${fid}-transport`}>Sent through</label>
              <select
                id={`${fid}-transport`}
                value={draft.sendTransport}
                onChange={(e) => setDraft({ ...draft, sendTransport: e.target.value as 'brevo' | 'smtp' })}
              >
                <option value="brevo">The site&rsquo;s usual email service</option>
                <option value="smtp">Its own mail server</option>
              </select>
              <span className="field-hint">The usual service suits nearly everybody.</span>
            </div>
          </FieldRow>
          {draft.sendTransport === 'smtp' && (
            <>
              <FieldRow template="minmax(0, 3fr) minmax(0, 1fr)">
                <div className="field">
                  <label htmlFor={`${fid}-smtphost`}>Outgoing server</label>
                  <input id={`${fid}-smtphost`} value={draft.smtpHost} onChange={(e) => setDraft({ ...draft, smtpHost: e.target.value })} placeholder="smtp.yourcompany.co.uk" />
                </div>
                <div className="field">
                  {/* Same kind of box as the incoming port, which used to be a
                      number field while this one was not. */}
                  <label htmlFor={`${fid}-smtpport`}>Port</label>
                  <input id={`${fid}-smtpport`} type="number" value={draft.smtpPort} onChange={(e) => setDraft({ ...draft, smtpPort: e.target.value })} placeholder="587" />
                </div>
              </FieldRow>
              <FieldRow>
                <div className="field">
                  <label htmlFor={`${fid}-smtpuser`}>Username</label>
                  <input id={`${fid}-smtpuser`} value={draft.smtpUsername} onChange={(e) => setDraft({ ...draft, smtpUsername: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor={`${fid}-smtppass`}>Password</label>
                  <input id={`${fid}-smtppass`} type="password" value={draft.smtpPassword} onChange={(e) => setDraft({ ...draft, smtpPassword: e.target.value })} autoComplete="new-password" />
                  <span className="field-hint">Leave blank to keep the one already saved.</span>
                </div>
              </FieldRow>
            </>
          )}
          <CheckField
            label="Put a copy of every reply in the mailbox’s Sent folder"
            checked={draft.appendToSent}
            onChange={(appendToSent) => setDraft({ ...draft, appendToSent })}
            hint="Leave this off and replies live here only. Switch it on and your phone’s mail app shows them too."
          />
        </FieldGroup>

        <FieldGroup
          title="Signature"
          hint="Goes below a dividing line at the foot of every reply sent from this address, whoever sends it. Leave it empty and replies go out without one."
        >
          <SignatureEditor draft={draft} setDraft={setDraft} />
        </FieldGroup>

        <FieldGroup
          title="Who can read it"
          hint={<>
            Tick nobody and it is open to everyone who can see the inbox at all. Tick anybody and it
            becomes theirs alone - which is how the accounts address stays away from the rest of the
            team. Mark it as somebody&rsquo;s own and it sits first along the top for them, it is
            what they land on, and its signature goes on their replies wherever they send from.
            Everyone has one address of their own at most, so ticking this moves theirs here.
          </>}
        >
          {/* Named by the group's own legend above, so no second label here. */}
          <div className="field">
            {users.length === 0 ? (
              <p className="field-hint" style={{ margin: 0 }}>
                Nobody else has an account on this site yet, so there is nobody to keep it from.
              </p>
            ) : (
              <div style={{
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                overflow: 'hidden',
              }}>
                {users.map((u, index) => {
                  const row = staff.find((s) => s.userId === u.id)
                  // An inbox nobody is named on is open to everybody, so making
                  // it somebody's own is only offered where they can actually
                  // read it - named on it, or the list empty.
                  const canRead = !!row || staff.length === 0
                  const owns = ownedBy.includes(u.id)
                  const elsewhere = owns ? null : ownInboxElsewhere(u.id, editing === 'new' ? null : editing)
                  return (
                    <div
                      key={u.id}
                      style={{
                        display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap',
                        justifyContent: 'space-between',
                        padding: '0.5rem 0.75rem',
                        borderTop: index === 0 ? 'none' : '1px solid var(--color-border)',
                        background: row ? 'var(--color-primary-subtle)' : 'transparent',
                      }}
                    >
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 400, cursor: 'pointer' }}>
                        <input type="checkbox" checked={!!row} onChange={() => toggleStaff(u.id)} />
                        <span>
                          {u.name}{' '}
                          <span style={{ ...MUTED, fontSize: '0.8125rem' }}>{u.email}</span>
                        </span>
                      </label>
                      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
                        {row && (
                          <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontWeight: 400, fontSize: '0.8125rem', cursor: 'pointer' }}>
                            <input type="checkbox" checked={row.canReply} onChange={() => toggleReply(u.id)} />
                            Can reply
                          </label>
                        )}
                        {canRead && (
                          <label
                            style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontWeight: 400, fontSize: '0.8125rem', cursor: 'pointer' }}
                            title={elsewhere
                              ? `${u.name} currently opens on ${elsewhere.name}. Ticking this moves them here.`
                              : 'They open the inbox on this address, and their replies are signed with its signature.'}
                          >
                            <input type="checkbox" checked={owns} onChange={() => toggleOwn(u.id)} />
                            Their own inbox
                          </label>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </FieldGroup>

        <FormActions>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Save inbox</button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
        </FormActions>
      </EditPanel>
    )
  }

  return (
    <Panel
      title="The addresses people write to"
      blurb={<>
        Each one can have its own staff, its own signature and its own name on the replies, even when
        they all arrive in the same mail account. Post is filed by the address it was delivered to,
        then by the To line, then by Cc, then by whichever address you have made the catch-all.
      </>}
    >
      {senderWarning && (
        <div className="alert alert-info" style={{ marginBottom: '1rem' }}>
          {senderWarning}
        </div>
      )}

      {inboxes.length === 0 && editing === null && (
        <EmptyState>
          <p style={{ margin: '0 0 0.75rem' }}>
            No addresses yet. Add the one your customers actually write to and post will start being
            filed against it.
          </p>
          <button type="button" className="btn btn-primary btn-sm" onClick={startNew}>Add an inbox</button>
        </EmptyState>
      )}

      {inboxes.map((inbox) => {
        // The form opens where the row is. It used to open at the foot of the
        // list, so pressing Edit on the first of eight addresses scrolled you
        // past the other seven to a form that gave no sign of which one it was
        // about.
        if (editing === inbox.id) {
          return <div key={inbox.id}>{inboxForm(`Editing ${inbox.address}`)}</div>
        }
        const rows = accessByInbox.get(inbox.id) ?? []
        const owners = defaultsByInbox.get(inbox.id) ?? []
        const connection = inbox.connectionId ? connectionsById.get(inbox.connectionId) : null
        return (
          <ListRow key={inbox.id}>
            <ListRowHeader
              title={inbox.name}
              badges={<>
                {inbox.isCatchAll && <Chip tone="info">Catch-all</Chip>}
                {inbox.folderOwnsMail && <Chip tone="info">Whole folder</Chip>}
                {rows.length > 0 && <Chip tone="plain">{rows.length === 1 ? '1 person' : `${rows.length} people`}</Chip>}
                {owners.length > 0 && (
                  <Chip tone="info">
                    {owners.length === 1 ? 'Somebody\u2019s own' : `${owners.length} people\u2019s own`}
                  </Chip>
                )}
                {!inbox.connectionId && <Chip tone="plain">Send only</Chip>}
              </>}
              subtitle={inbox.address}
              meta={<>
                {connection
                  ? `Collected from ${connection.label} · ${inbox.imapFolder}`
                  : 'Not collected from a mailbox - replies go out from it, nothing arrives.'}
                {' · '}
                {rows.length === 0
                  ? 'Anybody who can see the inbox can read this one.'
                  : 'Only the people listed on it can read it.'}
              </>}
              actions={<>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => startEdit(inbox)}>Edit</button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setRemoving(inbox)}>Remove</button>
              </>}
            />
          </ListRow>
        )
      })}

      {editing === null && (
        <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: '0.25rem' }} onClick={startNew}>
          Add an inbox
        </button>
      )}

      {editing === 'new' && inboxForm('A new inbox')}

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
        // Left open while the removal is in flight; see the mail account panel.
        onConfirm={() => {
          const inbox = removing
          if (inbox) void remove(inbox.id).finally(() => setRemoving(null))
        }}
      />
    </Panel>
  )
}
