'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { AttachmentRow, ThreadDetail, ThreadEventRow, ThreadMessageRow } from '@/modules/unified-inbox/lib/db'
import type { DraftForComposer } from '@/modules/unified-inbox/lib/drafts'
import { channelLabel, formatFull, formatWhen, inboxHref, splitQuotedText } from '@/modules/unified-inbox/lib/list'
import { BackIcon, ClockIcon, InboundIcon, NoteIcon, OutboundIcon, PaperclipIcon, TickIcon } from './icons'
import { MessageBody } from './MessageBody'
import { RetryButton } from './RetryButton'
import { ThreadActions } from './ThreadActions'
import { Composer } from './Composer'

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
  now: Date
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
function DeliveryReceipt({ message, now }: { message: ThreadMessageView; now: Date }) {
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
              ? `Their email program confirmed it: ${formatFull(message.openedAt)}`
              : `First opened ${formatFull(message.openedAt)}`
          }
        >
          {TickIcon} Opened {formatWhen(message.openedAt, now)}
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
        <span className="uin-tag" title={`Delivered ${formatFull(message.deliveredAt)}`}>
          Delivered {formatWhen(message.deliveredAt, now)}
        </span>
      ) : null}
    </>
  )
}

/** When a message happened, written the way the list beside it writes the same
 *  thing - a time today, a weekday this week, a date after that - with the full
 *  date in the tooltip for anybody working out exactly when. The two used to
 *  disagree: the list said "Fri" and the conversation said the whole date. */
function MessageWhen({ at, now }: { at: Date | string | null; now: Date }) {
  return <span className="uin-msg-when" title={formatFull(at)}>{formatWhen(at, now)}</span>
}

function MessageHeader({ message, staffById, now }: {
  message: ThreadMessageView
  staffById: Record<string, string>
  now: Date
}) {
  if (message.direction === 'note') {
    const author = message.authorUserId ? staffById[message.authorUserId] : null
    return (
      <div className="uin-msg-head">
        <span className="uin-msg-who">{author ?? 'Somebody here'}</span>
        <span className="uin-msg-dir">{NoteIcon} Internal note, not sent</span>
        <MessageWhen at={message.sentAt} now={now} />
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
        <MessageWhen at={message.sentAt} now={now} />
      </div>
    )
  }
  return (
    <div className="uin-msg-head">
      <span className="uin-msg-who">{message.fromName || message.fromAddress || 'Unknown sender'}</span>
      <span className="uin-msg-dir">
        {InboundIcon} Received{message.fromName && message.fromAddress ? ` from ${message.fromAddress}` : ''}
      </span>
      <MessageWhen at={message.sentAt} now={now} />
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

function Message({ message, staffById, now, onDelete }: {
  message: ThreadMessageView
  staffById: Record<string, string>
  now: Date
  onDelete?: (messageId: string) => void
}) {
  const [deleting, setDeleting] = useState(false)
  const kind = message.direction === 'note' ? 'note' : message.direction === 'out' ? 'out' : 'in'
  
  // Only provider messages can be deleted (and only if their provider supports it)
  const canDelete = message.source === 'provider' && onDelete
  
  async function handleDelete() {
    if (!confirm('Delete this message? This cannot be undone.')) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/m/unified-inbox/messages/${message.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        alert(data.error || 'Failed to delete message')
        setDeleting(false)
        return
      }
      onDelete?.(message.id)
    } catch (err) {
      alert('Failed to delete message')
      setDeleting(false)
    }
  }
  
  return (
    <article className={`uin-msg uin-msg-${kind}`}>
      <MessageHeader message={message} staffById={staffById} now={now} />
      {canDelete && (
        <div style={{ float: 'right', marginTop: '0.5rem' }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={handleDelete}
            disabled={deleting}
            style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      )}
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
      {(message.attachments.length > 0 || message.deliveryStatus) && (
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
              <DeliveryReceipt message={message} now={now} />
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

export function ThreadPane({
  base, params, thread, inboxName, messages, events, staff, staffById,
  canReply, cannotReplyReason, replyTo, replyAllTo, draft, newestFirst, now,
}: Props) {
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set())
  
  // The list arrives oldest first. Reversing a copy rather than sorting again:
  // the query already decided the order, and this only says which end to read
  // it from.
  const ordered = (newestFirst ? [...messages].reverse() : messages).filter(
    (m) => !deletedIds.has(m.id)
  )
  
  function handleDelete(messageId: string) {
    setDeletedIds((prev) => new Set(prev).add(messageId))
  }
  
  return (
    <div className="uin-thread">
      <div className="uin-thread-head">
        <Link
          className="uin-chip uin-back"
          href={inboxHref(base, params, { id: null })}
          style={{ justifySelf: 'start' }}
        >
          {BackIcon} Back to the list
        </Link>
        <h2 className="uin-thread-subject">{thread.subject || '(no subject)'}</h2>
        <div className="uin-thread-meta">
          <span>{channelLabel(thread.channel)}</span>
          {inboxName && <span>&middot; {inboxName}</span>}
          <span>&middot; {messages.length} message{messages.length === 1 ? '' : 's'}</span>
          {/* Said as a label with a date after it. "last Fri" on its own reads as
              the Friday before this one, and disagreed with the row in the list
              beside it, which says the same date as plainly "Fri". */}
          <span title={formatFull(thread.lastMessageAt)}>
            &middot; last message {formatWhen(thread.lastMessageAt, now)}
          </span>
          {thread.status === 'snoozed' && thread.snoozeUntil && (
            <span className="uin-tag uin-tag-snoozed">Back {formatWhen(thread.snoozeUntil, now)}</span>
          )}
          {thread.status === 'done' && <span className="uin-tag uin-tag-done">Done</span>}
        </div>
        <ThreadActions
          threadId={thread.id}
          status={thread.status}
          unread={thread.unread}
          assigneeUserId={thread.assigneeUserId}
          staff={staff}
        />
      </div>

      <div className="uin-thread-body">
        {thread.providerModule && messages.length === 0 && (
          <div className="alert alert-info">
            This conversation came from somewhere else on the site, and whatever used to serve it is
            not installed at the moment. What we already hold is still searchable.
          </div>
        )}

        {/* The messages come first and the writing box after them, because the
            conversation is what somebody opened this to read. An empty list used
            to render as nothing at all, which put the writing box directly under
            the subject and left no sign that anything was missing.

            Reading newest first, the writing box goes above the messages, since
            the reply belongs beside the thing being replied to. */}
        {newestFirst && (
          <Composer
            threadId={thread.id}
            replyTo={replyTo}
            replyAllTo={replyAllTo}
            canReply={canReply}
            canForward={canReply}
            staff={staff}
            cannotReplyReason={cannotReplyReason}
            draft={draft}
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
              <Message key={message.id} message={message} staffById={staffById} now={now} onDelete={handleDelete} />
            ))}
          </div>
        )}

        {!newestFirst && (
          <Composer
            threadId={thread.id}
            replyTo={replyTo}
            replyAllTo={replyAllTo}
            canReply={canReply}
            canForward={canReply}
            staff={staff}
            cannotReplyReason={cannotReplyReason}
            draft={draft}
          />
        )}

        {events.length > 0 && (
          <details>
            <summary className="uin-chip uin-summary">What has been done to this</summary>
            <ul className="uin-log">
              {events.map((event) => (
                <li key={event.id}>
                  {(event.userId && staffById[event.userId]) || 'Somebody'}{' '}
                  {EVENT_WORDS[event.kind] ?? 'changed something'}
                  {' - '}
                  {formatFull(event.createdAt)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  )
}
