'use client'

import type { SearchRequest, SearchStatus } from '@/modules/unified-inbox/lib/list'

// The boxes a search is made of, and nothing about where they are drawn.
//
// There are two screens that ask the same eight questions: the dialog the
// magnifier opens (InboxSearch), and the head of the results it lands on
// (SearchBar). They are laid out differently - one is a card in the middle of
// the screen, the other a strip across the top of the list and the conversation
// - but a cut that exists on one and not the other is a search somebody makes
// in the dialog and then cannot change, or the reverse. So the boxes live here
// and the two screens only put a wrapper round them.
//
// Deliberately no wrapper of its own: the dialog lays these out as a grid of
// two columns and the bar as one row that wraps, and a component that brought
// its own box would have to be told which - which is the layout knowing about
// its contents rather than the other way round.

/** What the reader picked, on its way back up. Not a setter for one field: the
 *  bar acts on some of these the moment they change and the dialog waits for
 *  Search, and which is which is the caller's business. */
export type SetField = <K extends keyof SearchRequest>(key: K, value: SearchRequest[K]) => void

export type SearchPlaces = {
  /** The addresses this person may read, for the "where to look" menu. */
  inboxes: Array<{ id: string; name: string }>
  /** And the channels another module owns, which are places to look in exactly
   *  the same way. */
  channels: Array<{ key: string; label: string }>
  /** Whether "the mail that landed nowhere" is a place this reader has. */
  showUnrouted: boolean
}

const STATUS_LABELS: Array<{ value: SearchStatus; label: string }> = [
  { value: 'all', label: 'Any status' },
  { value: 'open', label: 'Still open' },
  { value: 'snoozed', label: 'Set aside for later' },
  { value: 'done', label: 'Dealt with' },
]

/** Two lists, one box. The address book answers a different question about the
 *  same people, and having to close the search and go and find the Contacts tab
 *  to ask it is the sort of thing that makes somebody give up and search their
 *  own mail client instead. */
export function SearchModes({ mode, set }: { mode: SearchRequest['mode']; set: SetField }) {
  const contacts = mode === 'contacts'
  return (
    <div className="uin-search-modes" role="group" aria-label="What to search">
      <button
        type="button"
        className="uin-chip"
        aria-pressed={!contacts}
        onClick={() => set('mode', 'conversations')}
      >
        Conversations
      </button>
      <button
        type="button"
        className="uin-chip"
        aria-pressed={contacts}
        onClick={() => set('mode', 'contacts')}
      >
        Contacts
      </button>
    </div>
  )
}

/** The narrower cuts a mail program has always had - who from, who to, subject,
 *  anything attached, between two dates - as boxes rather than as a syntax
 *  nobody remembers. Labels wrap their own control rather than pointing at an
 *  id, because both screens can be on the page at once and two of anything with
 *  the same id is one label that points at the wrong box. */
export function SearchFields({
  request, set, inboxes, channels, showUnrouted,
}: { request: SearchRequest; set: SetField } & SearchPlaces) {
  return (
    <>
      <label className="uin-field">
        <span>Where to look</span>
        <select value={request.scope} onChange={(event) => set('scope', event.target.value)}>
          <option value="all">Everywhere you can see</option>
          {inboxes.map((inbox) => (
            <option key={inbox.id} value={inbox.id}>{inbox.name}</option>
          ))}
          {channels.map((channel) => (
            <option key={channel.key} value={`m:${channel.key}`}>{channel.label}</option>
          ))}
          {showUnrouted && <option value="none">Not filed</option>}
        </select>
      </label>

      <label className="uin-field">
        <span>Where it stands</span>
        <select
          value={request.status}
          onChange={(event) => set('status', event.target.value as SearchStatus)}
        >
          {STATUS_LABELS.map((status) => (
            <option key={status.value} value={status.value}>{status.label}</option>
          ))}
        </select>
      </label>

      <label className="uin-field">
        <span>From</span>
        <input
          type="text"
          value={request.from}
          onChange={(event) => set('from', event.target.value)}
          placeholder="A name or an address"
          autoComplete="off"
        />
      </label>

      <label className="uin-field">
        <span>To</span>
        <input
          type="text"
          value={request.to}
          onChange={(event) => set('to', event.target.value)}
          placeholder="Anybody it was sent or copied to"
          autoComplete="off"
        />
      </label>

      <label className="uin-field uin-field-wide">
        <span>Subject</span>
        <input
          type="text"
          value={request.subject}
          onChange={(event) => set('subject', event.target.value)}
          placeholder="Words in the subject line"
          autoComplete="off"
        />
      </label>

      <label className="uin-field">
        <span>Since</span>
        <input
          type="date"
          value={request.after}
          onChange={(event) => set('after', event.target.value)}
        />
      </label>

      <label className="uin-field">
        <span>Up to and including</span>
        <input
          type="date"
          value={request.before}
          onChange={(event) => set('before', event.target.value)}
        />
      </label>

      <div className="uin-search-ticks">
        <label className="uin-tick">
          <input
            type="checkbox"
            checked={request.withAttachment}
            onChange={(event) => set('withAttachment', event.target.checked)}
          />
          <span>Has something attached</span>
        </label>
        <label className="uin-tick">
          <input
            type="checkbox"
            checked={request.unreadOnly}
            onChange={(event) => set('unreadOnly', event.target.checked)}
          />
          <span>Nobody has read it</span>
        </label>
      </div>
    </>
  )
}

/** What the address book cannot answer, said where the other cuts would be. */
export function ContactsNote() {
  return (
    <p className="uin-search-note">
      The address book takes the words and nothing else - who a message came
      from, and when, are questions about post.
    </p>
  )
}
