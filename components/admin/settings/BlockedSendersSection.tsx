'use client'

import type { BlockedSenderRow, Caller, StaffMember } from './types'
import { EmptyState, FieldGroup, ListRow, ListRowHeader, MUTED } from './ui'

// ---------------------------------------------------------------------------
// Everybody the site turns away, and the only place a decision can be undone.
//
// ADDING ONE IS NOT HERE, on purpose. A sender is blocked from a conversation,
// where whoever is pressing the button has the evidence in front of them and
// can read the address off the message rather than typing it from memory. A box
// on a settings page that blocks whatever is typed into it is a box that
// eventually holds a customer's address with one letter wrong in it.
//
// LIFTING ONE IS ONLY here, and that is the other half of the same argument.
// The block covers every inbox the site has, so it is a fact about how the site
// is set up rather than about any one conversation - and the conversation it
// was made from may well have been tidied away months ago. A block nobody could
// find again would be a customer nobody could work out why they had lost.
// ---------------------------------------------------------------------------

export function BlockedSendersSection({ blocked, users, busy, call }: {
  blocked: BlockedSenderRow[]
  users: StaffMember[]
  busy: boolean
  call: Caller
}) {
  const nameOf = (id: string | null): string | null =>
    (id ? users.find((u) => u.id === id)?.name ?? null : null)

  const unblock = async (row: BlockedSenderRow) => {
    await call(
      '/api/m/unified-inbox/blocked-senders',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: row.address, blocked: false }),
      },
      `${row.address} can get through again. Anything they sent while they were blocked is still on the mail server rather than here.`,
    )
  }

  return (
    <FieldGroup
      title="Blocked senders"
      hint={<>
        Nothing from these addresses is collected into any inbox on this site - shared or
        personal. You block somebody from a conversation, using the junk button at the top of it;
        this is where you let them back in. Blocking never deleted anything: their old
        conversations are still here, and anything they sent while they were blocked is still
        sitting on the mail server, exactly where it landed.
      </>}
    >
      {blocked.length === 0 ? (
        <EmptyState>
          Nobody is blocked. Open a conversation and press the junk button at the top of it to
          throw it away, and you will be asked whether to turn the sender away in future too.
        </EmptyState>
      ) : (
        blocked.map((row) => {
          const by = nameOf(row.blockedByUserId)
          return (
            <ListRow key={row.id}>
              <ListRowHeader
                title={row.address}
                subtitle={
                  <span style={MUTED}>
                    {/* The date in the site's own reading of it. Whoever did it
                        where their account is still here - "who blocked this and
                        when" is the question asked six months later by somebody
                        who was not in the room. */}
                    Blocked {new Date(row.createdAt).toLocaleDateString('en-GB', {
                      day: 'numeric', month: 'long', year: 'numeric',
                    })}
                    {by ? ` by ${by}` : ''}
                  </span>
                }
                actions={
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy}
                    onClick={() => { void unblock(row) }}
                  >
                    Let them through
                  </button>
                }
              />
            </ListRow>
          )
        })
      )}
    </FieldGroup>
  )
}
