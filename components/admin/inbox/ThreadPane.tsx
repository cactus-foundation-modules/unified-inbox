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
function DeliveryReceipt({ message }: { message: ThreadMessageView }) {
  const hardBounce = message.bouncedAt
    && ['hard', 'blocked', 'invalid', 'spam', 'error'].includes(message.bounceKind ?? '')
  const softBounce = message.bouncedAt && !hardBounce

  return (
    <>
      {hardBounce && (
        <span className="uin-tag uin-tag-failed" title={message.bounceDetail ?? undefined}>
          It did not arrive
        </span>
      )}
      {softBounce && (
        <span className="uin-tag" title={message.bounceDetail ?? undefined}>
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
          {TickIcon} Opened {formatWhen(message.openedAt)}
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
          Delivered {formatWhen(message.deliveredAt)}
        </span>
      ) : null}
    </>
  )
}

function MessageHeader({ message, staffById }: { message: ThreadMessageView; staffById: Record<string, string> }) {
  if (message.direction === 'note') {
    const author = message.authorUserId ? staffById[message.authorUserId] : null
    return (
      <div className="uin-msg-head">
        <span className="uin-msg-who">{author ?? 'Somebody here'}</span>
        <span className="uin-msg-dir">{NoteIcon} Internal note, not sent</span>
        <span className="uin-msg-when" title={formatFull(message.sentAt)}>{formatFull(message.sentAt)}</span>
      </div>
    )
  }
  if (message.direction === 'out') {
    const author = message.authorUserId ? staffById[message.authorUserId] : null
    return (
      <div className="uin-msg-head">
        <span className="uin-msg-who">{author ? `${author} replied` : 'Sent from here'}</span>
        <span className="uin-msg-dir">
          {OutboundIcon} Sent to {message.toAddresses.join(', ') || 'nobody recorded'}
        </span>
        <span className="uin-msg-when" title={formatFull(message.sentAt)}>{formatFull(message.sentAt)}</span>
      </div>
    )
  }
  return (
    <div className="uin-msg-head">
      <span className="uin-msg-who">{message.fromName || message.fromAddress || 'Unknown sender'}</span>
      <span className="uin-msg-dir">
        {InboundIcon} Received{message.fromName && message.fromAddress ? ` from ${message.fromAddress}` : ''}
      </span>
      <span className="uin-msg-when" title={formatFull(message.sentAt)}>{formatFull(message.sentAt)}</span>
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
          <summary className="uin-chip" style={{ cursor: 'pointer' }}>Show the earlier messages</summary>
          <pre className="uin-msg-text" style={{ marginTop: '0.5rem', color: 'var(--color-text-secondary)' }}>{quoted}</pre>
        </details>
      )}
    </>
  )
}

function Message({ message, staffById }: { message: ThreadMessageView; staffById: Record<string, string> }) {
  const kind = message.direction === 'note' ? 'note' : message.direction === 'out' ? 'out' : 'in'
  return (
    <article className={`uin-msg uin-msg-${kind}`}>
      <MessageHeader message={message} staffById={staffById} />
      {message.autoKind && (
        <div className="uin-msg-foot" style={{ borderTop: 0, borderBottom: '1px solid var(--color-border)' }}>
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
          {message.attachments.map((file) => (
            <a
              key={file.id}
              className="uin-attachment"
              href={`/api/m/unified-inbox/attachments/${file.id}`}
            >
              {PaperclipIcon}
              {file.filename}
              {file.sizeBytes ? <span style={{ color: 'var(--color-text-muted)' }}>{formatBytes(file.sizeBytes)}</span> : null}
            </a>
          ))}
          {message.deliveryStatus === 'sending' && (
            <span className="uin-tag">{ClockIcon} On its way</span>
          )}
          {message.deliveryStatus === 'sent' && (
            <>
              <span className="uin-tag uin-tag-done">{TickIcon} Sent</span>
              <DeliveryReceipt message={message} />
            </>
          )}
          {message.deliveryStatus === 'failed' && (
            <>
              <span className="uin-tag uin-tag-failed">It did not send</span>
              {message.deliveryError && (
                <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                  {message.deliveryError}
                </span>
              )}
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
  canReply, cannotReplyReason, replyTo, replyAllTo, draft, now,
}: Props) {
  return (
    <div className="uin-thread">
      <div className="uin-thread-head">
        <a
          className="uin-chip"
          href={inboxHref(base, params, { id: null })}
          style={{ justifySelf: 'start' }}
        >
          {BackIcon} Back to the list
        </a>
        <h2 className="uin-thread-subject">{thread.subject || '(no subject)'}</h2>
        <div className="uin-thread-actions" style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>
          <span>{channelLabel(thread.channel)}</span>
          {inboxName && <span>&middot; {inboxName}</span>}
          <span>&middot; {messages.length} message{messages.length === 1 ? '' : 's'}</span>
          <span>&middot; last {formatWhen(thread.lastMessageAt, now)}</span>
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

      {thread.providerModule && messages.length === 0 && (
        <div className="alert alert-info">
          This conversation came from somewhere else on the site, and whatever used to serve it is
          not installed at the moment. What we already hold is still searchable.
        </div>
      )}

      <div className="uin-messages">
        {messages.map((message) => (
          <Message key={message.id} message={message} staffById={staffById} />
        ))}
      </div>

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

      {events.length > 0 && (
        <details>
          <summary className="uin-chip" style={{ cursor: 'pointer' }}>What has been done to this</summary>
          <ul style={{ listStyle: 'none', margin: '0.5rem 0 0', padding: 0, display: 'grid', gap: '0.25rem' }}>
            {events.map((event) => (
              <li key={event.id} style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
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
  )
}
