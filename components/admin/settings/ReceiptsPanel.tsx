'use client'

import { useState } from 'react'
import type { Caller, Settings } from './types'
import { CheckField, FormActions, Panel } from './ui'

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
export function ReceiptsPanel({ settings, busy, call }: {
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
    <Panel
      title="What happened to a reply after you sent it"
      blurb={<>
        On its own, &ldquo;Sent&rdquo; only means the email service took the message off your hands.
        Switch these on and a reply can also tell you it arrived, that somebody opened it, or that it
        bounced straight back. Worth having when you are deciding whether to chase somebody.
      </>}
    >
      <CheckField
        label="Tell me when a reply is delivered, opened or bounces"
        checked={draft.trackOpens}
        onChange={(trackOpens) => setDraft({ ...draft, trackOpens })}
        hint={<>
          Only works for addresses sending through the site&rsquo;s usual email service. An open is
          worked out from a tiny invisible picture in the message, so it is a good clue rather than
          proof: some mail apps fetch that picture before anybody has read a word, and when that
          happens you are told so rather than told a fib. Anything sent through your own mail server
          carries on saying nothing but &ldquo;Sent&rdquo;.
        </>}
      />

      <CheckField
        label="Ask the person’s own email program for a read receipt"
        checked={draft.requestReadReceipts}
        onChange={(requestReadReceipts) => setDraft({ ...draft, requestReadReceipts })}
        hint={<>
          The old-fashioned kind. Most email programs ignore it and the rest ask the reader first, so
          expect an answer perhaps one time in ten, mostly from people in offices. When one does come
          back it lands on the message it belongs to rather than cluttering up the conversation.
        </>}
      />

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

      <FormActions>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Save settings</button>
      </FormActions>
    </Panel>
  )
}
