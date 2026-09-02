'use client'

import type { ReactNode } from 'react'
import { connectionHealth } from './ConnectionsPanel'
import type { Payload, SubTab } from './types'
import { Chip, EmptyState, MUTED, Panel } from './ui'

// ---------------------------------------------------------------------------
// Overview: the answer to "is this thing working?", which is the question
// somebody opens these settings with nine times out of ten. It used to be
// answerable only by reading six panels of forms and working it out.
// ---------------------------------------------------------------------------

function Stat({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div style={{
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-md)',
      padding: '0.875rem 1rem',
      background: 'var(--color-bg)',
    }}>
      <div style={{ fontSize: 'var(--text-xl)', fontWeight: 'var(--font-semibold)', lineHeight: 1.2 }}>{value}</div>
      <div className="field-hint" style={{ marginTop: '0.25rem' }}>{label}</div>
    </div>
  )
}

/** Something that wants doing, and the button that goes to where it is done. */
function Todo({ text, action, onGo, tone = 'plain' }: {
  text: ReactNode
  action: string
  onGo: () => void
  tone?: 'plain' | 'bad'
}) {
  return (
    <li style={{
      display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between',
      padding: '0.75rem 0',
      borderTop: '1px solid var(--color-border)',
    }}>
      <span style={{ flex: '1 1 20rem', color: tone === 'bad' ? 'var(--color-destructive-hover)' : 'var(--color-text)' }}>
        {text}
      </span>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onGo}>{action}</button>
    </li>
  )
}

export function OverviewPanel({ data, goTo }: { data: Payload; goTo: (tab: SubTab) => void }) {
  const collected = data.collection.reduce((total, stat) => total + stat.collected, 0)
  const working = data.connections.filter((c) => connectionHealth(c).tone === 'ok').length
  const catchAll = data.inboxes.find((i) => i.isCatchAll) ?? null
  const stillFetching = data.collection.some((stat) => !stat.backfillComplete)

  // Nothing at all yet. A screen of empty forms is no way to be told what to do
  // first, so it says so in three steps and takes you to each of them.
  if (data.connections.length === 0 && data.inboxes.length === 0) {
    return (
      <Panel
        title="Nothing set up yet"
        blurb="Three things and it starts collecting. Ten minutes, most of which is finding the app password."
      >
        <ol style={{ margin: 0, paddingLeft: '1.25rem', display: 'grid', gap: '1rem' }}>
          <li>
            <strong>Connect the mailbox you already use.</strong>
            <p className="field-hint" style={{ margin: '0.25rem 0 0.5rem', maxWidth: '58ch' }}>
              You will need its app password - most providers make you generate one, and searching for
              your provider&rsquo;s name and &ldquo;app password&rdquo; gets you there.
            </p>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => goTo('accounts')}>Add a mail account</button>
          </li>
          <li>
            <strong>Tell it which addresses people write to.</strong>
            <p className="field-hint" style={{ margin: '0.25rem 0 0.5rem', maxWidth: '58ch' }}>
              One mailbox can feed several: enquiries in one place, invoices in another, each with its
              own signature and its own staff.
            </p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => goTo('inboxes')}>Add an inbox</button>
          </li>
          <li>
            <strong>Decide how far back to go.</strong>
            <p className="field-hint" style={{ margin: '0.25rem 0 0.5rem', maxWidth: '58ch' }}>
              A year of old post is the usual answer. It arrives a bit at a time in the background.
            </p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => goTo('collecting')}>Collecting settings</button>
          </li>
        </ol>
      </Panel>
    )
  }

  const todos: ReactNode[] = []

  for (const connection of data.connections) {
    const health = connectionHealth(connection)
    if (health.tone === 'ok') continue
    todos.push(
      <Todo
        key={`conn-${connection.id}`}
        tone={health.tone === 'bad' ? 'bad' : 'plain'}
        text={health.tone === 'bad'
          ? <><strong>{connection.label}</strong> is not collecting anything - {health.label.toLowerCase()}.</>
          : <><strong>{connection.label}</strong> has never been checked, so nothing has arrived from it yet.</>}
        action="Mail accounts"
        onGo={() => goTo('accounts')}
      />
    )
  }

  if (data.connections.length === 0) {
    todos.push(
      <Todo
        key="no-connections"
        text="No mailbox is being read, so nothing new will arrive."
        action="Add a mail account"
        onGo={() => goTo('accounts')}
      />
    )
  }

  if (data.inboxes.length === 0) {
    todos.push(
      <Todo
        key="no-inboxes"
        text="No addresses are set up, so there is nowhere to file the post."
        action="Add an inbox"
        onGo={() => goTo('inboxes')}
      />
    )
  }

  if (data.unrouted > 0 && !catchAll) {
    todos.push(
      <Todo
        key="unrouted"
        text={<>
          {data.unrouted === 1 ? 'One message is' : `${data.unrouted} messages are`} sitting under Not
          filed, because they arrived at an address that is not set up here. Add the address, or make
          one of your inboxes the catch-all.
        </>}
        action="Inboxes"
        onGo={() => goTo('inboxes')}
      />
    )
  }

  return (
    <Panel
      title="How it is getting on"
      blurb="Everything below is set on the tabs beside this one. This is only where it is answered for."
    >
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 10rem), 1fr))',
        gap: '0.75rem',
        marginBottom: '1.5rem',
      }}>
        <Stat
          value={data.connections.length === 0 ? '—' : `${working}/${data.connections.length}`}
          label={data.connections.length === 1 ? 'Mail account working' : 'Mail accounts working'}
        />
        <Stat value={data.inboxes.length} label={data.inboxes.length === 1 ? 'Address collected' : 'Addresses collected'} />
        <Stat value={collected.toLocaleString('en-GB')} label="Messages gathered" />
        <Stat value={data.people.people.toLocaleString('en-GB')} label="People on record" />
      </div>

      {stillFetching && (
        <p className="field-hint" style={{ margin: '-0.75rem 0 1.5rem' }}>
          Older mail is still being fetched a bit at a time in the background, so the count will keep
          climbing for a while yet.
        </p>
      )}

      <h4 style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 0.25rem' }}>
        Wants your attention
      </h4>
      {todos.length === 0 ? (
        <EmptyState>
          <Chip tone="ok">All well</Chip>
          <p style={{ margin: '0.5rem 0 0' }}>
            Everything is collecting, everything has somewhere to go. Nothing here needs you.
          </p>
        </EmptyState>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{todos}</ul>
      )}

      <h4 style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '1.5rem 0 0.25rem' }}>
        As it stands
      </h4>
      <ul style={{ ...MUTED, fontSize: 'var(--text-sm)', margin: 0, paddingLeft: '1.1rem', display: 'grid', gap: '0.25rem' }}>
        <li>
          Post that matches no address you have listed{' '}
          {catchAll
            ? <>goes to <strong>{catchAll.name}</strong>.</>
            : <>is kept under Not filed, where only an administrator sees it.</>}
        </li>
        <li>
          Conversations are{' '}
          {data.settings.retentionMonths
            ? <>deleted once they are more than <strong>{data.settings.retentionMonths}</strong> months old.</>
            : <>kept for ever.</>}
        </li>
        <li>
          What became of a reply after it was sent is{' '}
          {data.settings.trackOpens || data.settings.requestReadReceipts ? 'recorded.' : 'not recorded.'}
        </li>
      </ul>
    </Panel>
  )
}
