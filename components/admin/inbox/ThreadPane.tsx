import Link from 'next/link'
import type { AttachmentRow, ThreadDetail, ThreadEventRow, ThreadMessageRow } from '@/modules/unified-inbox/lib/db'
import type { DraftForComposer } from '@/modules/unified-inbox/lib/drafts'
import { channelLabel, formatFull, formatWhen, inboxHref, splitQuotedText } from '@/modules/unified-inbox/lib/list'
import { draftHref } from '@/modules/unified-inbox/lib/drafts'
import { describeSendAt } from '@/modules/unified-inbox/lib/scheduled'
import { BackIcon, ClockIcon, InboundIcon, NoteIcon, OutboundIcon, PaperclipIcon, TickIcon } from './icons'
import { MessageBody } from './MessageBody'
import { RetryButton } from './RetryButton'
import { ThreadActions } from './ThreadActions'
import { DeleteMessageButton } from './MessageActions'
import { BlockParticipant } from './BlockParticipant'
import { ComposerOpenProvider, ComposerSlot, ReplyActions } from './ComposerOpen'

// One conversation, oldest message first - the order the story happened in.
//
// Which way a message went is said four ways over, because saying it in colour
// alone fails anybody who cannot tell the two colours apart: the words in the
// header, an arrow beside them, the style of the left edge, and the tint. An
// internal note is a fifth thing again and says so in as many words, since a
// note that reads as a reply is how something private ends up sounding like it
// was sent to the customer.

export type ThreadMessageView = ThreadMessageRow & {
  attachments: AttachmentRow[]
}

type Props = {
  base: string
  params: Record<string, string>
  thread: ThreadDetail
  inboxName: string | null
  messages: ThreadMessageView[]
  events: ThreadEventRow[]
  staff: Array<{ id: string; name: string }>
  staffById: Record<string, string>
  canReply: boolean
  cannotReplyReason: string | null
  replyTo: string[]
  replyAllTo: string[]
  /** What this reader left half-written under this conversation, if anything.
   *  Nobody else's, ever - a shared inbox is not a shared notepad. */
  draft: DraftForComposer | null
  /** Newest message at the top, with the writing box above the messages to
   *  match. A site setting, not a per-reader one. */
  newestFirst: boolean
  /** Whether this reader may get rid of a message this channel owns. The
   *  channel has to offer it AND the reader has to be allowed on that channel,
   *  and both halves are settled on the server. */
  canDeleteMessages: boolean
  /** Whether the other party on this conversation can be refused from here.
   *  Null when the channel cannot refuse anybody, which is most of them. */
  blockState: { blocked: boolean; channelLabel: string } | null
  now: Date
  /** The site's timezone. Every clock time on this pane is stamped in it: the
   *  server renders these, and its own clock is UTC. */
  timezone: string
  /** The earliest a reply may be set to go out on its own, already in the
   *  picker's shape and in that same timezone. */
  minSendAt: string
  /** Messages that were set to go out to this person and were stood down when
   *  this conversation arrived. Almost always empty; when it is not, it is the
   *  most important thing on the screen. */
  heldDrafts: HeldDraftView[]
}

/** One stood-down message, said in the little the warning needs: who it was
 *  for, what it was about, when it was going to go, and where to open it. */
export type HeldDraftView = {
  id: string
  threadId: string | null
  to: string[]
  subject: string | null
  sendAt: string | null
}

function formatBytes(bytes: number | null): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Keyed on what the sync engine actually stores. 'out-of-office' was here and
// is not one of them - the engine writes 'auto-reply' - so that label never
// appeared and every automatic reply fell through to the general one.
const AUTO_LABELS: Record<string, string> = {
  bounce: 'This one bounced - it never reached them',
  'auto-reply': 'An automatic out-of-office reply',
  bulk: 'Sent to a list rather than written to you',
  'own-notification': 'Sent by your own website, not by them',
}

/**
 * What became of a reply once it left, when the site is watching for that.
 *
 * The wording is fussier than it looks, and deliberately. A mail app fetching
 * the invisible picture in a message is not a person reading it, and somebody
 * deciding whether to ring a customer who has "read" their quote deserves to
 * know which of the two happened. Every message on a site with receipts
 * switched off has none of these, and this renders nothing.
 */
function DeliveryReceipt({ message, now, timezone }: { message: ThreadMessageView; now: Date; timezone: string }) {
  const hardBounce = message.bouncedAt
    && ['hard', 'blocked', 'invalid', 'spam', 'error'].includes(message.bounceKind ?? '')
  const softBounce = message.bouncedAt && !hardBounce

  return (
    <>
      {hardBounce && (
        // Whatever the far end said about it is kept off the page on purpose.
        // It is written for whoever runs a mail server, and a site owner reading
        // it learns nothing except that something technical went wrong.
        <span
          className="uin-tag uin-tag-failed"
          title="The address turned it away. It is worth checking it is spelt right, or reaching them another way."
        >
          It did not arrive
        </span>
      )}
      {softBounce && (
        <span
          className="uin-tag"
          title="Something at the other end is holding it up. It may still get through on its own."
        >
          Held up on the way
        </span>
      )}
      {message.openedAt ? (
        <span
          className="uin-tag uin-tag-done"
          title={
            message.openSource === 'receipt'
              ? `Their email program confirmed it: ${formatFull(message.openedAt, timezone)}`
              : `First opened ${formatFull(message.openedAt, timezone)}`
          }
        >
          {TickIcon} Opened {formatWhen(message.openedAt, now, timezone)}
          {message.openCount > 1 ? ` (${message.openCount} times)` : ''}
        </span>
      ) : message.openSource === 'proxy' ? (
        <span
          className="uin-tag"
          title="Their email program downloaded the pictures in the message, which it often does before anybody has looked at it. Not proof that it was read."
        >
          Their email app fetched it
        </span>
      ) : message.deliveredAt && !hardBounce ? (
        <span className="uin-tag" title={`Delivered ${formatFull(message.deliveredAt, timezone)}`}>
          Delivered {formatWhen(message.deliveredAt, now, timezone)}
        </span>
      ) : null}
    </>
  )
}

/** When a message happened, written the way the list beside it writes the same
 *  thing - a time today, a weekday this week, a date after that - with the full
 *  date in the tooltip for anybody working out exactly when. The two used to
 *  disagree: the list said "Fri" and the conversation said the whole date. */
function MessageWhen({ at, now, timezone }: { at: Date | string | null; now: Date; timezone: string }) {
  return <span className="uin-msg-when" title={formatFull(at, timezone)}>{formatWhen(at, now, timezone)}</span>
}

function MessageHeader({ message, staffById, now, timezone }: {
  message: ThreadMessageView
  staffById: Record<string, string>
  now: Date
  timezone: string
}) {
  if (message.direction === 'note') {
    const author = message.authorUserId ? staffById[message.authorUserId] : null
    return (
      <div className="uin-msg-head">
        <span className="uin-msg-who">{author ?? 'Somebody here'}</span>
        <span className="uin-msg-dir">{NoteIcon} Internal note, not sent</span>
        <MessageWhen at={message.sentAt} now={now} timezone={timezone} />
      </div>
    )
  }
  if (message.direction === 'out') {
    const author = message.authorUserId ? staffById[message.authorUserId] : null
    return (
      <div className="uin-msg-head">
        <span className="uin-msg-who">{author ? `${author} replied` : 'Sent from here'}</span>
        <span className="uin-msg-dir">
          {/* A live chat or a web form has no email address to have been sent to,
              so there is nothing missing to report. Saying "nobody recorded"
              there invented an absence, and read as a fault. */}
          {OutboundIcon}
          {message.toAddresses.length > 0 ? ` Sent to ${message.toAddresses.join(', ')}` : ' Sent'}
        </span>
        <MessageWhen at={message.sentAt} now={now} timezone={timezone} />
      </div>
    )
  }
  return (
    <div className="uin-msg-head">
      <span className="uin-msg-who">{message.fromName || message.fromAddress || 'Unknown sender'}</span>
      <span className="uin-msg-dir">
        {InboundIcon} Received{message.fromName && message.fromAddress ? ` from ${message.fromAddress}` : ''}
      </span>
      <MessageWhen at={message.sentAt} now={now} timezone={timezone} />
    </div>
  )
}

function MessageText({ text }: { text: string }) {
  const { body, quoted } = splitQuotedText(text)
  return (
    <>
      <pre className="uin-msg-text">{body}</pre>
      {quoted && (
        <details style={{ marginTop: '0.75rem' }}>
          <summary className="uin-chip uin-summary">Show the earlier messages</summary>
          <pre className="uin-msg-text" style={{ marginTop: '0.5rem', color: 'var(--color-text-secondary)' }}>{quoted}</pre>
        </details>
      )}
    </>
  )
}

function Message({ message, staffById, now, timezone, canDelete }: {
  message: ThreadMessageView
  staffById: Record<string, string>
  now: Date
  timezone: string
  /** Whether this reader may get rid of a message the channel owns. Decided on
   *  the server, per channel and per person - see InboxPanel. */
  canDelete: boolean
}) {
  const kind = message.direction === 'note' ? 'note' : message.direction === 'out' ? 'out' : 'in'

  // Only a message a channel owns can be deleted at the far end, and only where
  // that channel says it can. Everything else in a thread lives here and
  // nowhere else.
  const offerDelete = canDelete && message.source === 'provider'

  return (
    <article className={`uin-msg uin-msg-${kind}`}>
      <MessageHeader message={message} staffById={staffById} now={now} timezone={timezone} />
      {message.autoKind && (
        <div className="uin-msg-foot uin-msg-flag">
          <span className="uin-tag uin-tag-snoozed">{AUTO_LABELS[message.autoKind] ?? 'Sent automatically'}</span>
        </div>
      )}
      <div className="uin-msg-body">
        {message.hasHtml ? (
          <MessageBody messageId={message.id} hasRemoteImages={message.remoteImages > 0} />
        ) : (
          <MessageText text={message.bodyText ?? '(this message had nothing in it)'} />
        )}
      </div>
      {(message.attachments.length > 0 || message.deliveryStatus || offerDelete) && (
        <div className="uin-msg-foot">
          {message.attachments.map((file) => {
            // Provider attachments with external URLs (like Twilio voicemails) 
            // are rendered as audio players or download links
            const isAudio = file.contentType?.startsWith('audio/') || file.filename.match(/\.(mp3|wav|ogg|m4a)$/i)
            const externalUrl = file.externalUrl
            
            if (isAudio && externalUrl) {
              return (
                <div key={file.id} style={{ margin: '0.5rem 0' }}>
                  <audio controls style={{ maxWidth: '100%' }}>
                    <source src={externalUrl} type={file.contentType || 'audio/mpeg'} />
                    Your browser does not support the audio element.
                  </audio>
                  <a
                    className="uin-attachment"
                    href={externalUrl}
                    download={file.filename}
                    style={{ fontSize: '0.875rem', marginTop: '0.25rem', display: 'inline-block' }}
                  >
                    {PaperclipIcon}
                    {file.filename}
                  </a>
                </div>
              )
            }
            
            return (
              <a
                key={file.id}
                className="uin-attachment"
                href={externalUrl || `/api/m/unified-inbox/attachments/${file.id}`}
                download={file.filename}
              >
                {PaperclipIcon}
                {file.filename}
                {file.sizeBytes ? <span style={{ color: 'var(--color-text-muted)' }}>{formatBytes(file.sizeBytes)}</span> : null}
              </a>
            )
          })}
          {message.deliveryStatus === 'sending' && (
            <span className="uin-tag">{ClockIcon} On its way</span>
          )}
          {message.deliveryStatus === 'sent' && (
            <>
              <span className="uin-tag uin-tag-done">{TickIcon} Sent</span>
              <DeliveryReceipt message={message} now={now} timezone={timezone} />
            </>
          )}
          {message.deliveryStatus === 'failed' && (
            <>
              <span className="uin-tag uin-tag-failed">It did not send</span>
              {/* What the mail server said about it is never put on the page. It
                  is written for whoever runs one, it can carry the whole message
                  back with it, and it tells a site owner nothing they can act
                  on. This sentence is the whole of what there is to do. */}
              <span style={{ color: 'var(--color-text-secondary)' }}>
                It would not go. Try again, and check the address is right if it will not.
              </span>
              <RetryButton messageId={message.id} />
            </>
          )}
          {message.appendStatus === 'failed' && (
            <span className="uin-tag" title="The email went; only the copy in your own Sent folder did not">
              Not copied to your Sent folder
            </span>
          )}
          {/* Pushed to the far end of the foot rather than floated over the
              message body, which is where it used to sit: a button hanging over
              somebody's words is in the way of reading them, and it moved
              depending on how long the message was. */}
          {offerDelete && (
            <div className="uin-msg-actions">
              <DeleteMessageButton messageId={message.id} />
            </div>
          )}
        </div>
      )}
    </article>
  )
}

const EVENT_WORDS: Record<string, string> = {
  assigned: 'handed it on',
  snoozed: 'set it to come back later',
  status: 'changed where it stands',
  note: 'left a note',
  mentioned: 'asked somebody to look',
  linked: 'linked a record to it',
  unlinked: 'removed a link',
  merged: 'merged it with another',
}

/** Entries nobody did. The rest of the log reads "<name> <did something>", and
 *  putting "Somebody" in front of an automatic one invents a colleague who was
 *  never there - so these carry their own whole sentence instead.
 *
 *  Returns null for anything with a person behind it, which is most of it. */
function unattendedEvent(event: ThreadEventRow, staffById: Record<string, string>): string | null {
  if (event.userId) return null
  if (event.kind === 'held') {
    const count = typeof event.detail?.count === 'number' ? event.detail.count : 1
    return count > 1
      ? `They wrote first, so ${count} messages waiting to go out to them were held`
      : 'They wrote first, so a message waiting to go out to them was held'
  }
  if (event.kind === 'awaiting') {
    // Named, because the chase was handed to whoever WROTE the message rather
    // than to whoever sent it, and a conversation that reappears on somebody
    // else's list needs to say why it is theirs.
    const author = typeof event.detail?.userId === 'string' ? staffById[event.detail.userId] : null
    return author
      ? `It went out, so it comes back to ${author} if nobody replies`
      : 'It went out, so it comes back if nobody replies'
  }
  if (event.kind !== 'woken') return null
  // Worth saying which it was: coming back early from a snooze is mildly
  // surprising, and something you had marked done reopening is the sort of
  // thing you want an explanation for before you go looking for one.
  return event.detail?.was === 'done'
    ? 'A reply arrived, so it was opened again'
    : 'A reply arrived, so it stopped being snoozed'
}

export function ThreadPane({
  base, params, thread, inboxName, messages, events, staff, staffById,
  canReply, cannotReplyReason, replyTo, replyAllTo, draft, newestFirst,
  canDeleteMessages, blockState, now, timezone, minSendAt, heldDrafts,
}: Props) {
  // The list arrives oldest first. Reversing a copy rather than sorting again:
  // the query already decided the order, and this only says which end to read
  // it from.
  //
  // A deleted message used to be hidden from this list by client-side state,
  // which is why the count under the subject went on disagreeing with it. The
  // delete button refreshes instead, so this is server truth again.
  const ordered = newestFirst ? [...messages].reverse() : messages

  // A draft opens the box on the way in, and nothing else does: a conversation
  // is opened to be read far more often than to be answered.
  const openAs = draft && draft.mode !== 'new' ? draft.mode : null

  return (
    // Keyed on the conversation, so opening the next one starts shut again
    // rather than inheriting whatever was open on the last.
    <ComposerOpenProvider key={thread.id} initialMode={openAs}>
    <div className="uin-thread">
      <div className="uin-thread-head">
        {/* On a phone this is the way back to a list that is not on the screen.
            On anything wider it is how you shut a conversation and have the
            list whole again, which there was previously no way at all to do. */}
        <Link
          className="uin-chip uin-back"
          href={inboxHref(base, params, { id: null })}
          style={{ justifySelf: 'start' }}
        >
          <span className="uin-back-phone" aria-hidden="true">{BackIcon} Back to the list</span>
          <span className="uin-back-wide" aria-hidden="true">&times; Close</span>
          {/* One name for it whichever of the two is showing, so the link is not
              announced twice on a phone. */}
          <span className="sr-only">Close this conversation and go back to the list</span>
        </Link>
        <h2 className="uin-thread-subject">{thread.subject || '(no subject)'}</h2>
        <div className="uin-thread-meta">
          <span>{channelLabel(thread.channel)}</span>
          {inboxName && <span>&middot; {inboxName}</span>}
          <span>&middot; {messages.length} message{messages.length === 1 ? '' : 's'}</span>
          {/* Said as a label with a date after it. "last Fri" on its own reads as
              the Friday before this one, and disagreed with the row in the list
              beside it, which says the same date as plainly "Fri". */}
          <span title={formatFull(thread.lastMessageAt, timezone)}>
            &middot; last message {formatWhen(thread.lastMessageAt, now, timezone)}
          </span>
          {thread.status === 'snoozed' && thread.snoozeUntil && (
            <span className="uin-tag uin-tag-snoozed">Back {formatWhen(thread.snoozeUntil, now, timezone)}</span>
          )}
          {thread.status === 'done' && <span className="uin-tag uin-tag-done">Done</span>}
        </div>
        {/* What you can say, before what you can do to it: answering is what
            somebody came here for, and the box itself is no longer sitting open
            underneath waiting to be noticed. */}
        <ReplyActions canReply={canReply} canForward={canReply} cannotReplyReason={cannotReplyReason} />
        <ThreadActions
          threadId={thread.id}
          status={thread.status}
          unread={thread.unread}
          assigneeUserId={thread.assigneeUserId}
          staff={staff}
          timezone={timezone}
        />
        {/* Beside what is done TO the conversation, because that is what this
            is: it changes what happens next, not what is in the thread. */}
        {blockState && (
          <BlockParticipant
            threadId={thread.id}
            blocked={blockState.blocked}
            channelLabel={blockState.channelLabel}
          />
        )}
      </div>

      <div className="uin-thread-body">
        {/* First thing in the body, above the messages, because it changes what
            you are about to do: something we had queued to this person was
            standing by, and reading their message without knowing that is how
            you answer a question twice. Nothing has been sent, and the writing
            is untouched - the link opens it exactly where it was left. */}
        {heldDrafts.map((heldDraft) => (
          <div key={heldDraft.id} className="alert alert-info" role="status">
            <strong>A message to them was waiting to go out.</strong>{' '}
            {heldDraft.subject?.trim() ? `"${heldDraft.subject.trim()}" was set to go out` : 'It was set to go out'}
            {heldDraft.sendAt ? ` ${describeSendAt(heldDraft.sendAt, now, timezone)}` : ''}
            . They wrote to you first, so it was held and nothing was sent.{' '}
            <Link href={draftHref(base, params, heldDraft)}>Open it</Link> to send it as it is,
            change it, or throw it away.
          </div>
        ))}

        {thread.providerModule && messages.length === 0 && (
          <div className="alert alert-info">
            This conversation came from somewhere else on the site, and whatever used to serve it is
            not installed at the moment. What we already hold is still searchable.
          </div>
        )}

        {/* The writing box, when somebody has asked for one - the buttons that
            ask are in the row of actions above. It still appears beside the
            newest message rather than at the top of the pane, which reading
            newest first means above the list and otherwise below it: a reply
            belongs beside the thing being replied to. */}
        {newestFirst && (
          <ComposerSlot
            threadId={thread.id}
            replyTo={replyTo}
            replyAllTo={replyAllTo}
            canReply={canReply}
            canForward={canReply}
            staff={staff}
            cannotReplyReason={cannotReplyReason}
            draft={draft}
            minSendAt={minSendAt}
            timezone={timezone}
          />
        )}

        {messages.length === 0 ? (
          !thread.providerModule && (
            <div className="uin-empty">
              <strong>There is nothing to read in this one</strong>
              No messages are being kept against this conversation. It may have been cleared
              out, or it may go back further than this inbox does.
            </div>
          )
        ) : (
          <div className="uin-messages">
            {ordered.map((message) => (
              <Message key={message.id} message={message} staffById={staffById} now={now} timezone={timezone} canDelete={canDeleteMessages} />
            ))}
          </div>
        )}

        {!newestFirst && (
          <ComposerSlot
            threadId={thread.id}
            replyTo={replyTo}
            replyAllTo={replyAllTo}
            canReply={canReply}
            canForward={canReply}
            staff={staff}
            cannotReplyReason={cannotReplyReason}
            draft={draft}
            minSendAt={minSendAt}
            timezone={timezone}
          />
        )}

        {events.length > 0 && (
          <details>
            <summary className="uin-chip uin-summary">What has been done to this</summary>
            <ul className="uin-log">
              {events.map((event) => (
                <li key={event.id}>
                  {unattendedEvent(event, staffById) ?? (
                    <>
                      {(event.userId && staffById[event.userId]) || 'Somebody'}{' '}
                      {EVENT_WORDS[event.kind] ?? 'changed something'}
                    </>
                  )}
                  {' - '}
                  {formatFull(event.createdAt, timezone)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
    </ComposerOpenProvider>
  )
}
