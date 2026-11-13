'use client'

import { useId, useState } from 'react'
import type { Caller, Settings } from './types'
import { FieldGroup, FieldRow, FormActions, MUTED, Panel } from './ui'

// ---------------------------------------------------------------------------
// The site-wide rules every campaign goes out under.
//
// Three settings, all of which existed and were read by the campaign code from
// the day campaigns arrived - and none of which had anywhere to be typed in.
// The footer address above all: a campaign with its unsubscribe footer on will
// not start without one, and the message saying so sent people to this tab
// before it existed.
//
// Kept apart from the campaign editor on purpose. These are rules rather than
// preferences: a cooling-off period one campaign could switch off for itself
// would stop being a rule, and the address in the footer is who the business
// is, not something that changes from one mailshot to the next.
// ---------------------------------------------------------------------------

/** The bounds the database itself holds these to (migration 027), so the form
 *  refuses what the save would be refused for. */
const COOLDOWN_MAX = 365
const LOG_MIN = 1
const LOG_MAX = 120

export function CampaignSettingsPanel({ settings, busy, call }: {
  settings: Settings
  busy: boolean
  call: Caller
}) {
  const [draft, setDraft] = useState(settings)
  // Re-seed when a save brings fresh settings back, during render rather than
  // in an effect so the stale value is never painted.
  const [seeded, setSeeded] = useState(settings)
  const fid = useId()
  if (seeded !== settings) {
    setSeeded(settings)
    setDraft(settings)
  }

  const address = draft.campaignFooterAddress ?? ''
  const missingAddress = !address.trim()

  async function save() {
    const cooldown = Math.round(Number(draft.campaignCooldownDays))
    const months = Math.round(Number(draft.campaignLogMonths))
    await call('/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        campaignFooterAddress: address.trim() || null,
        campaignCooldownDays: Number.isFinite(cooldown)
          ? Math.min(COOLDOWN_MAX, Math.max(0, cooldown))
          : settings.campaignCooldownDays,
        campaignLogMonths: Number.isFinite(months)
          ? Math.min(LOG_MAX, Math.max(LOG_MIN, months))
          : settings.campaignLogMonths,
      }),
    }, 'Settings saved.')
  }

  return (
    <Panel
      title="Campaigns"
      blurb={<>
        The rules every campaign goes out under, whoever sets it up. Each campaign decides who it goes
        to and what it says; these decide who it is from and how often anybody hears from you.
      </>}
    >
      <FieldGroup
        first
        title="Who it is from"
        hint="Printed small at the bottom of every campaign email, beside the unsubscribe link. UK rules on marketing email expect a name and a real address, and it is also what makes a message read as a business writing to a customer rather than a list that bought their address."
      >
        <div className="field">
          <label htmlFor={`${fid}-address`}>Your business address</label>
          <textarea
            id={`${fid}-address`}
            rows={4}
            maxLength={500}
            value={address}
            placeholder={'Unit 4, Mill Lane\nAnytown\nAB1 2CD'}
            onChange={(e) => setDraft({ ...draft, campaignFooterAddress: e.target.value })}
          />
          <span className="field-hint">
            One line per line of the address. Your site&rsquo;s name goes in front of it on its own, so
            there is no need to type that as well.
          </span>
        </div>
        {missingAddress && (
          <div className="alert alert-info">
            <p style={{ margin: 0 }}>
              Until there is an address here, a campaign with the unsubscribe footer switched on will not
              start.
            </p>
          </div>
        )}
      </FieldGroup>

      <FieldGroup
        title="How often"
      >
        <FieldRow>
          <div className="field">
            <label htmlFor={`${fid}-cooldown`}>
              Leave people alone for <span style={{ ...MUTED, fontWeight: 400 }}>(days)</span>
            </label>
            <input
              id={`${fid}-cooldown`}
              type="number"
              min={0}
              max={COOLDOWN_MAX}
              value={draft.campaignCooldownDays}
              onChange={(e) => setDraft({ ...draft, campaignCooldownDays: Number(e.target.value) })}
            />
            <span className="field-hint">
              Anybody written to by any campaign in this many days is left off the next one. Nought
              switches it off, which is rarely kind.
            </span>
          </div>
          <div className="field">
            <label htmlFor={`${fid}-log`}>
              Keep the record of who got what for <span style={{ ...MUTED, fontWeight: 400 }}>(months)</span>
            </label>
            <input
              id={`${fid}-log`}
              type="number"
              min={LOG_MIN}
              max={LOG_MAX}
              value={draft.campaignLogMonths}
              onChange={(e) => setDraft({ ...draft, campaignLogMonths: Number(e.target.value) })}
            />
            <span className="field-hint">
              The send-by-send list behind a finished campaign. Replies are ordinary conversations and
              are kept for as long as the rest of your mail.
            </span>
          </div>
        </FieldRow>
      </FieldGroup>

      <FormActions>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Save settings</button>
      </FormActions>
    </Panel>
  )
}
