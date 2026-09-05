'use client'

import type { AudienceSummaryView, CampaignDetail } from '../api'
import type { CampaignCategory, CampaignInbox } from '../CampaignsPanel'
import type { CampaignDraft } from '../draft'

// Who it goes to.
//
// There is no button on this section. The count under it is what the list would
// be if the page were saved now, and saving is what writes it down - the old
// screen had a separate "use this list" press, which everybody missed, and a
// campaign then sat there insisting nobody was on a list that plainly said one
// person was on it.

export function WhoSection({
  draft, detail, inboxes, categories, editable, preview, staleCount, onChange,
}: {
  draft: CampaignDraft
  detail: CampaignDetail
  inboxes: CampaignInbox[]
  categories: CampaignCategory[]
  editable: boolean
  /** The count as it stands on the server. Null while it is being fetched,
   *  which is the first moment the section is on screen. */
  preview: AudienceSummaryView | null
  /** Whether the labels on screen have been changed since that count was
   *  worked out - in which case the number is about the old choice and saying
   *  it out loud would be worse than saying nothing. */
  staleCount: boolean
  onChange: (patch: Partial<CampaignDraft>) => void
}) {
  const { tally } = detail
  const built = tally.total > 0
  const onTheList = tally.total - tally.skipped
  const reasons = built ? detail.exclusions : preview?.excluded ?? []

  const toggle = (id: string) => {
    onChange({
      categoryIds: draft.categoryIds.includes(id)
        ? draft.categoryIds.filter((c) => c !== id)
        : [...draft.categoryIds, id],
    })
  }

  return (
    <section className="uin-camp-section">
      <h3>Who it goes to</h3>

      <div className="uin-camp-field">
        <label htmlFor="uin-camp-inbox">The address it comes from</label>
        <select
          id="uin-camp-inbox"
          className="form-control"
          value={draft.inboxId}
          disabled={!editable}
          onChange={(event) => onChange({ inboxId: event.target.value })}
        >
          <option value="">Choose an address</option>
          {inboxes.map((inbox) => (
            <option key={inbox.id} value={inbox.id}>{inbox.name} ({inbox.address})</option>
          ))}
        </select>
        <span className="uin-camp-hint">
          Replies come back here and land in your inbox as ordinary conversations.
        </span>
      </div>

      <div className="uin-camp-field">
        <label>Which contacts</label>
        {categories.length === 0
          ? (
            <span className="uin-camp-hint">
              You have no labels on your contacts yet, so this goes to everybody in the address book.
              Add labels on the Contacts tab to send to just some of them.
            </span>
          )
          : (
            <>
              <div className="uin-camp-cats">
                {categories.map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    className="uin-camp-cat"
                    data-on={draft.categoryIds.includes(category.id) ? '1' : undefined}
                    disabled={!editable}
                    onClick={() => toggle(category.id)}
                  >
                    {category.name}
                  </button>
                ))}
              </div>
              <span className="uin-camp-hint">
                {draft.categoryIds.length === 0
                  ? 'Nothing picked, so this goes to everybody in your address book.'
                  : 'Anybody with one of these labels.'}
              </span>
            </>
          )}
      </div>

      <label className="uin-camp-check">
        <input
          type="checkbox"
          checked={draft.excludeColleagues}
          disabled={!editable}
          onChange={(event) => onChange({ excludeColleagues: event.target.checked })}
        />
        <span>
          Leave out colleagues - anybody at one of your own email domains
          <br />
          <span className="uin-camp-hint">
            On unless you have a reason. It is what stops a customer mailshot going round the office.
          </span>
        </span>
      </label>

      <div className="uin-camp-count">
        {staleCount
          ? <span className="uin-camp-hint">Save to count who that comes to.</span>
          : built
            ? (
              <>
                <b>{onTheList.toLocaleString('en-GB')}</b>
                <span>on the list{tally.skipped > 0 ? `, ${tally.skipped.toLocaleString('en-GB')} left out` : ''}</span>
              </>
            )
            : preview
              ? (
                <>
                  <b>{preview.included.toLocaleString('en-GB')}</b>
                  <span>
                    would get this
                    {preview.duplicates > 0 ? `, ${preview.duplicates} duplicate addresses merged` : ''}
                    {' '}&ndash; saving is what writes the list down
                  </span>
                </>
              )
              : <span className="uin-camp-hint">Counting&hellip;</span>}
      </div>

      {!staleCount && reasons.length > 0 && (
        <details className="uin-camp-why">
          <summary>Why some are left out</summary>
          <ul className="uin-camp-checks">
            {reasons.map((row) => (
              <li key={row.reason}>
                <span aria-hidden="true">&ndash;</span>
                <span><b>{row.count.toLocaleString('en-GB')}</b> {row.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
