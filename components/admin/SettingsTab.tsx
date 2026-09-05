'use client'

import { useCallback, useEffect, useState } from 'react'
import { TabStrip } from '@/components/admin/TabStrip'
import { WebhooksSection } from './WebhooksSection'
import { InboxStyles } from './inbox/styles'
import { API, OFFLINE } from './settings/api'
import { CollectingPanel } from './settings/CollectingPanel'
import { ConnectionsPanel } from './settings/ConnectionsPanel'
import { InboxesPanel } from './settings/InboxesPanel'
import { OverviewPanel } from './settings/OverviewPanel'
import { PeoplePanel } from './settings/PeoplePanel'
import { ReceiptsPanel } from './settings/ReceiptsPanel'
import { SUB_TABS, type Note, type Payload, type SubTab } from './settings/types'
import { MUTED, NoteAlert } from './settings/ui'

// ---------------------------------------------------------------------------
// Settings for the Unified Inbox.
//
// This used to be one page of six stacked cards and about forty controls, which
// meant that changing a folder name involved scrolling past retention policy,
// read receipts and a regular expression. It is now seven tabs of one job each,
// and this file is the shell around them: it loads the data once, keeps the
// alerts that matter on screen whichever tab is open, and remembers which tab
// that was in the URL.
//
// Copy throughout is written for somebody who runs a business, not a mail
// server: "mail account" rather than "IMAP connection", "the folder your mail
// app files things into" rather than "special-use mailbox". Every colour is a
// token, so the whole thing follows the admin into dark mode without a second
// palette.
// ---------------------------------------------------------------------------

const DEFAULT_TAB: SubTab = 'overview'

export function UnifiedInboxSettingsTab() {
  const [data, setData] = useState<Payload | null>(null)
  const [message, setMessage] = useState<Note | null>(null)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<SubTab>(DEFAULT_TAB)
  // Which tabs have been opened at least once. A tab is built the first time it
  // is asked for and then kept, hidden, so a half-typed inbox is still there
  // after a trip to People and back. Nothing is built before it is wanted: the
  // signature builder is a large thing to load for somebody who came to change
  // a folder name.
  const [visited, setVisited] = useState<SubTab[]>([DEFAULT_TAB])

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

  // Which tab is open rides in the URL as ?sub=, so a refresh, a bookmark or a
  // pasted link comes back to it rather than dropping the admin on Overview.
  // Read once on mount rather than during a render: the core settings page
  // renders this on the server too, and reading the location mid-render would
  // have the two disagree.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('sub')
    if (!wanted || !SUB_TABS.some((t) => t.key === wanted)) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot read of the URL's tab on mount
    setTab(wanted as SubTab)
    // The tab the URL asked for counts as visited, so it is built rather than
    // left as an empty div.
    setVisited((current) => current.includes(wanted as SubTab) ? current : [...current, wanted as SubTab])
  }, [])

  const goTo = useCallback((next: SubTab) => {
    setTab(next)
    setVisited((current) => current.includes(next) ? current : [...current, next])
    // replaceState rather than a router navigation: this is bookkeeping about
    // where you already are, so the back button should leave the settings page
    // rather than walk back through every tab that got poked at. The default
    // tab carries no param, to keep the URL tidy.
    const url = new URL(window.location.href)
    if (next === DEFAULT_TAB) url.searchParams.delete('sub')
    else url.searchParams.set('sub', next)
    if (url.href !== window.location.href) window.history.replaceState(null, '', url)
  }, [])

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

  function panel(key: SubTab) {
    if (!data) return null
    switch (key) {
      case 'overview':
        return <OverviewPanel data={data} goTo={goTo} />
      case 'accounts':
        return (
          <ConnectionsPanel
            connections={data.connections}
            collection={data.collection}
            busy={busy}
            call={call}
            setMessage={setMessage}
            reload={load}
          />
        )
      case 'inboxes':
        return (
          <InboxesPanel
            inboxes={data.inboxes}
            connections={data.connections}
            access={data.access}
            defaults={data.defaults}
            users={data.users}
            busy={busy}
            call={call}
            setMessage={setMessage}
            reload={load}
          />
        )
      case 'collecting':
        return (
          <CollectingPanel
            settings={data.settings}
            inboxes={data.inboxes}
            retention={data.retention ?? null}
            busy={busy}
            call={call}
          />
        )
      case 'receipts':
        return <ReceiptsPanel settings={data.settings} busy={busy} call={call} />
      case 'people':
        return (
          <PeoplePanel
            settings={data.settings}
            inboxes={data.inboxes}
            counts={data.people}
            categories={data.categories}
            busy={busy}
            call={call}
          />
        )
      case 'webhooks':
        return <WebhooksSection inboxes={data.inboxes} />
    }
  }


  return (
    <div>
      {/* The module's own stylesheet, for the are-you-sure dialogs below. */}
      <InboxStyles />
      <p style={{ ...MUTED, marginBottom: '1.25rem', maxWidth: '70ch' }}>
        One place for every conversation with a customer or a supplier. Point it at the mail account
        you already use, tell it which addresses people write to, and decide who is allowed to read
        which of them.
      </p>

      {/* Above the tabs on purpose: none of these are about the tab you happen
          to be on, and hiding a broken mailbox behind a tab is how it stays
          broken. */}
      {!data.encryptionReady && (
        <div className="alert alert-danger">
          This site has no encryption key set, so there is nowhere safe to keep a mailbox password.
          Set one up before adding a mail account.
        </div>
      )}

      {(data.warnings ?? []).map((warning) => (
        <div key={warning.connectionId} className="alert alert-danger">
          {warning.message}
        </div>
      ))}

      {/* Post with nowhere to go is worth saying on every tab, not only on the
          one that fixes it. */}
      {data.unrouted > 0 && (
        <div className="alert alert-info">
          {data.unrouted === 1
            ? 'One message arrived at an address that is not set up here, so it has nowhere to go.'
            : `${data.unrouted} messages arrived at addresses that are not set up here, so they have nowhere to go.`}
          {' '}Add the address as an inbox, or mark one of your inboxes as the catch-all, and they will be filed the next time mail is checked.
        </div>
      )}

      <TabStrip
        items={SUB_TABS.map((t) => ({
          key: t.key,
          label: t.label,
          active: t.key === tab,
          onClick: () => goTo(t.key),
        }))}
      />

      <NoteAlert note={message} />

      {SUB_TABS.filter((t) => visited.includes(t.key)).map((t) => (
        // Hidden rather than unmounted, so a form half filled in is still there
        // when you come back to it. `hidden` takes it out of the reading order
        // as well as off the screen; the inline display is belt and braces
        // against a class that sets one.
        <div key={t.key} hidden={t.key !== tab} style={t.key === tab ? undefined : { display: 'none' }}>
          {panel(t.key)}
        </div>
      ))}
    </div>
  )
}
