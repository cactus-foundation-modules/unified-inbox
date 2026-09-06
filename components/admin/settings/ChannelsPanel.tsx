'use client'

import { useState } from 'react'
import type { Caller, ChannelRow, Settings } from './types'
import { CheckField, EmptyState, FormActions, Panel } from './ui'

/**
 * Which of the site's other channels appear in here.
 *
 * A channel is somewhere conversations arrive that is not a mail account: the
 * contact form, the live chat, the phone. Each of them turns up as its own
 * entry down the left, and until now there was nothing to be done about that.
 *
 * There is now, because a form can say where its enquiries belong. Point the
 * "Get in touch" form at sales@ and its enquiries ARE sales@ post: they sit in
 * that inbox, count towards it and are read by whoever reads it. A Contact form
 * entry listing the same enquiries a second time is then a second place to look
 * for the same thing, which is the one thing this module exists to stop.
 *
 * So it is a decision rather than a rule. Switching one off hides it and
 * nothing more: the conversations are still collected, the permissions are
 * unchanged, and switching it back on brings back everything that arrived while
 * it was off. The catch is worth saying out loud rather than burying, and it is
 * said on the screen: an enquiry from a form that was pointed at no inbox has
 * nowhere else to be seen.
 */
export function ChannelsPanel({ settings, channels, busy, call }: {
  settings: Settings
  channels: ChannelRow[]
  busy: boolean
  call: Caller
}) {
  const [hidden, setHidden] = useState<string[]>(settings.hiddenChannelModules)
  const [seeded, setSeeded] = useState(settings)
  if (seeded !== settings) {
    setSeeded(settings)
    setHidden(settings.hiddenChannelModules)
  }

  function toggle(moduleName: string, shown: boolean) {
    setHidden((current) => shown
      ? current.filter((name) => name !== moduleName)
      : current.includes(moduleName) ? current : [...current, moduleName])
  }

  async function save() {
    await call('/settings', {
      method: 'PATCH',
      body: JSON.stringify({ hiddenChannelModules: hidden }),
    }, 'Settings saved.')
  }

  return (
    <Panel
      title="Channels"
      blurb={<>
        The places conversations arrive from that are not a mail account - your contact form, a chat
        widget, the phone. Each one gets its own entry down the left. Switch one off and it stops
        appearing, without anything being thrown away.
      </>}
    >
      {channels.length === 0 ? (
        <EmptyState>
          Nothing but mail arrives here yet. Add a contact form, a chat widget or a phone number and
          it will show up in this list.
        </EmptyState>
      ) : (
        <>
          {channels.map((channel) => (
            <CheckField
              key={channel.moduleName}
              label={`Show ${channel.label}`}
              checked={!hidden.includes(channel.moduleName)}
              onChange={(shown) => toggle(channel.moduleName, shown)}
              disabled={busy}
            />
          ))}

          <div className="alert alert-info">
            <p style={{ margin: 0, fontSize: '0.875rem' }}>
              Worth knowing before you switch one off: an enquiry from a form that names one of your
              inboxes is filed there and stays perfectly visible either way. One from a form that
              names no inbox has nowhere else to go, so it will not be shown here at all until the
              channel is switched back on.
            </p>
          </div>
        </>
      )}

      <FormActions>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Save settings</button>
      </FormActions>
    </Panel>
  )
}
