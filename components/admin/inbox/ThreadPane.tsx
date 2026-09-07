import Link from 'next/link'
import type { ReactNode } from 'react'
import type { AttachmentRow, ThreadDetail, ThreadEventRow, ThreadMessageRow } from '@/modules/unified-inbox/lib/db'
import type { DraftForComposer } from '@/modules/unified-inbox/lib/drafts'
import type { ProductChoice } from '@/modules/unified-inbox/lib/products/types'
import { avatarHref, channelLabel, formatFull, formatWhen, inboxHref, initialsFor, splitQuotedText } from '@/modules/unified-inbox/lib/list'
import { draftHref } from '@/modules/unified-inbox/lib/drafts'
import { describeSendAt } from '@/modules/unified-inbox/lib/scheduled'
import { AtIcon, BackIcon, ClockIcon, CloseIcon, InboundIcon, NoteIcon, OutboundIcon, PaperclipIcon, TickIcon } from './icons'
import { Avatar } from './Avatar'
import { MessageBody } from './MessageBody'
import { MessageText } from './MessageText'
import { RetryButton } from './RetryButton'
import { ThreadActions } from './ThreadActions'
import { DeleteMessageButton } from './MessageActions'
import { BlockParticipant } from './BlockParticipant'
import { ComposerOpenProvider, ComposerSlot } from './ComposerOpen'
import { MessageMenu } from './MessageMenu'
import { NoteBar } from './NoteBar'
import { ThreadContext, hasThreadContext, type ThreadContextView } from './ThreadContext'
import { UnmergeButton, type ThreadMergeView } from './Unmerge'
import { AddressLine } from './AddressLine'
import { ScrollToMessage } from './ScrollToMessage'
import { MentionActions } from './MentionActions'

// One conversation, oldest message first - the order the story happened in.
//
// Which way a message went is said three ways over, because saying it in colour
// alone fails anybody who cannot tell the two colours apart: the words in the
// header, the style of the left edge, and the tint. There used to be an arrow
// beside the words as well; it was a fourth telling of something the words
// already said outright, and it read as a download button. An internal note is
// a fourth thing again and says so in as many words, since a note that reads
// as a reply is how something private ends up sounding like it was sent to the
// customer.

export type ThreadMessageView = ThreadMessageRow & {
  attachments: AttachmentRow[]
  /** Whether this came from us rather than from a stranger - anything we sent,
   *  and anything sent by a colleague or from one of our own domains. Its only
   *  job is the pictures: ours are shown without asking. */
  ownSender: boolean
}

type Props = {
  base: string
  params: Record<string, string>
  thread: ThreadDetail
  inboxName: string | null
  messages: ThreadMessageView[]
  events: ThreadEventRow[]
  /** Who this conversation can be HANDED to. Narrowed on somebody's own inbox,
   *  where the only person who can open it is the one it already belongs to. */
  staff: Array<{ id: string; name: string }>
  /** Who can be ASKED to look at it, which is a different list and a longer
   *  one. Being tagged lets somebody into this one conversation, so asking a
   *  colleague outside the address is the whole point rather than a mistake -
   *  and on a private inbox the narrowed list above would be this reader
   *  alone, which is nobody. */
  taggable: Array<{ id: string; name: string }>
  staffById: Record<string, string>
  canReply: boolean
  cannotReplyReason: string | null
  replyTo: string[]
  replyAllTo: string[]
  /** What the subject line would say if nobody opened it in the reply box,
   *  worked out on the server the same way the send route works it out. */
  replySubject: string
  forwardSubject: string
  /** What this reader left half-written under this conversation, if anything.
   *  Nobody else's, ever - a shared inbox is not a shared notepad. */
  draft: DraftForComposer | null
  /** Whether this person may put anything out of the catalogue on a message. */
  canAddProducts: boolean
  /** What the draft was carrying out of it, already looked up on the server. */
  draftProducts: ProductChoice[]
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
  /** Junk, as THIS reader sees it: whether they have put this conversation in
   *  their own spam folder, who wrote it, whether that sender is already
   *  refused site-wide, and whether this reader may do the refusing.
   *
   *  Not the same thing as `blockState` above and deliberately not folded into
   *  it. That one asks a CHANNEL to refuse the party on one conversation - the
   *  phone dropping a caller before it rings - and only a channel that can
   *  refuse anybody has it at all. This one is about email addresses, is the
   *  site's own list rather than anybody else's, and covers every inbox on the
   *  site rather than one conversation on one channel. */
  spamState: {
    spam: boolean
    /** The colleague whose bin it would go into, when that is not the reader -
     *  a conversation in somebody else's own address. Null on your own post and
     *  on every shared address. */
    ownerName: string | null
    senderAddress: string | null
    senderBlocked: boolean
    canBlock: boolean
  }
  now: Date
  /** Whether to ask for people's own pictures. Off unless the site has switched
   *  it on - see Settings, People. */
  showAvatars: boolean
  /** The site's timezone. Every clock time on this pane is stamped in it: the
   *  server renders these, and its own clock is UTC. */
  timezone: string
  /** Messages that were set to go out to this person and were stood down when
   *  this conversation arrived. Almost always empty; when it is not, it is the
   *  most important thing on the screen. */
  heldDrafts: HeldDraftView[]
  /** Who this is with and what it is about, drawn under the actions. What the
   *  rest of the site knows ABOUT that person - their orders, their quotes -
   *  is a different question and stays in the panel beside the conversation. */
  context: ThreadContextView
  /** THIS READER's own ask on this conversation, when a colleague has tagged
   *  them in a note on it. Never anybody else's: what a colleague was asked and
   *  whether they have got to it yet is between them and whoever asked. Null on
   *  the ordinary conversation nobody has been pulled into. */
  asked: AskedView | null
  /** Conversations merged into this one that could still be separated out
   *  again. Empty on everything that has never been merged, which is nearly
   *  everything - and empty as well for anybody who would not be allowed to
   *  take one apart, since the server only asks when they would. Read by the
   *  log at the foot of the conversation, which is where the merge is recorded
   *  and now where it can be undone. */
  merges: ThreadMergeView[]
  /** The site's other addresses this conversation also belongs to, by name.
   *  Only a merge across two addresses puts anything here - it is what makes
   *  the conversation visible in both of their tabs, so the header says so
   *  rather than leaving somebody to wonder why it is in theirs. */
  otherInboxNames: string[]
  /** The message this conversation should open on, when it should open on one
   *  rather than at the top. Only ever set when the site reads oldest first, in
   *  which case the top of the pane is the oldest message and the one worth
   *  reading is at the far end of it. Worked out on the server, because it turns
   *  on whether the conversation was unread when it was opened - which stops
   *  being true the moment it is. */
  scrollToMessageId: string | null
}

/** One ask, in the little the banner needs. Dates are already words by the time
 *  they get here - the banner is rendered on the server and the controls under
 *  it are not, and a Date handed to a client component arrives as an empty
 *  object. */
export type AskedView = {
  id: string
  status: string
  note: string | null
  /** Who wanted them, by name. Null when that colleague has since left. */
  askedBy: string | null
  /** When it comes back, said the way the rest of this pane says a date. */
  backWhen: string | null
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
// 'own-notification' is deliberately absent: mail the site sent itself carries
// no flag at all (see below), so it needs no wording here either.
const AUTO_LABELS: Record<string, string> = {
  bounce: 'This one bounced - it never reached them',
  'auto-reply': 'An automatic out-of-office reply',
  bulk: 'Sent to a list rather than written to you',
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

/**
 * Who wrote a message, with their own picture where there is one to have.
 *
 * Which id to ask for depends on which way the message went, and only these two
 * are ever right: a colleague wrote everything that went OUT and every note, so
 * that is their staff account; everything that came IN was written by whoever
 * the conversation is with. A message with neither - automatic mail from a
 * shop, an address nobody has been matched to - keeps its initials, which is
 * what the circle has always been.
 */
function MessageHeader({ message, personId, showAvatars, staffById, now, timezone, tools }: {
  message: ThreadMessageView
  personId: string | null
  showAvatars: boolean
  staffById: Record<string, string>
  now: Date
  timezone: string
  /** The arrow and the dots, drawn at the trailing end of the header. Handed in
   *  already built, because ThreadPane is a server component and those two are
   *  the only part of a message that has to be interactive. */
  tools: ReactNode
}) {
  const picture = (kind: 'person' | 'user', id: string | null) =>
    showAvatars ? avatarHref(kind, id) : null

  if (message.direction === 'note') {
    const author = message.authorUserId ? staffById[message.authorUserId] : null
    return (
      <div className="uin-msg-head">
        <Avatar src={picture('user', message.authorUserId)} title={author ?? undefined}>
          {author ? initialsFor(author) : NoteIcon}
        </Avatar>
        <div className="uin-msg-head-lines">
          <div className="uin-msg-head-line">
            <span className="uin-msg-who">{author ?? 'Somebody here'}</span>
            <span className="uin-msg-dir">{NoteIcon} Internal note</span>
          </div>
        </div>
        <MessageWhen at={message.sentAt} now={now} timezone={timezone} />
        {tools}
      </div>
    )
  }
  if (message.direction === 'out') {
    const author = message.authorUserId ? staffById[message.authorUserId] : null
    return (
      <div className="uin-msg-head">
        <Avatar src={picture('user', message.authorUserId)} title={author ?? undefined}>
          {author ? initialsFor(author) : OutboundIcon}
        </Avatar>
        <div className="uin-msg-head-lines">
          <div className="uin-msg-head-line">
            <span className="sr-only">Sent by</span>
            <span className="uin-msg-who">{author ? `${author} replied` : 'Sent from here'}</span>
            {message.fromAddress ? <AddressLine text={`<${message.fromAddress}>`} /> : null}
          </div>
          {/* A live chat or a web form has no email address to have been sent
              to, so there is nothing missing to report and no second line.
              Saying "nobody recorded" there invented an absence, and read as a
              fault. */}
          <ToLine addresses={message.toAddresses} />
        </div>
        <MessageWhen at={message.sentAt} now={now} timezone={timezone} />
        {tools}
      </div>
    )
  }
  const named = (message.fromName || message.fromAddress || '').trim() || null
  return (
    <div className="uin-msg-head">
      <Avatar src={picture('person', personId)} title={named ?? undefined}>
        {named ? initialsFor(named) : InboundIcon}
      </Avatar>
      <div className="uin-msg-head-lines">
        <div className="uin-msg-head-line">
          {/* The words "Received from" used to sit here in front of the
              address. They said out loud what the header says three other ways
              - the sender's name right beside it, the solid left edge, the
              tint - and it was the words, not the address, taking up the width
              a narrow column has to find. Kept for a screen reader, which has
              none of those three to go on. */}
          <span className="sr-only">Received from</span>
          <span className="uin-msg-who">{named ?? 'Unknown sender'}</span>
          {/* Only where the name is a name: with no name to go on, the bold
              part is already the address, and showing it twice was never the
              idea. */}
          {message.fromName && message.fromAddress
            ? <AddressLine text={`<${message.fromAddress}>`} />
            : null}
        </div>
        <ToLine addresses={message.toAddresses} />
      </div>
      <MessageWhen at={message.sentAt} now={now} timezone={timezone} />
      {tools}
    </div>
  )
}

/** Who a message went to, on a line of its own under the sender - the way a
 *  mail program has always laid a message out. Nothing at all where there is
 *  nobody to name, which is every message on a channel that has no addresses
 *  in it. */
function ToLine({ addresses }: { addresses: string[] }) {
  if (addresses.length === 0) return null
  return (
    <div className="uin-msg-head-line uin-msg-head-to">
      <span className="uin-msg-dir-label">To:</span>
      <AddressLine text={addresses.join(', ')} />
    </div>
  )
}

/** What a message is called in the page, so that the pane can be opened on one.
 *  In one place because two things need to agree on it: the message that gets
 *  the attribute, and the island that goes looking for it. */
function messageDomId(messageId: string): string {
  return `uin-msg-${messageId}`
}

function Message({ message, personId, showAvatars, staffById, now, timezone, canDelete, tools }: {
  message: ThreadMessageView
  /** Whoever the conversation is with, for the picture on an inbound message. */
  personId: string | null
  showAvatars: boolean
  staffById: Record<string, string>
  now: Date
  timezone: string
  /** Whether this reader may get rid of a message the channel owns. Decided on
   *  the server, per channel and per person - see InboxPanel. */
  canDelete: boolean
  /** Answering this message, and the rarer things beside it. */
  tools: ReactNode
}) {
  const kind = message.direction === 'note' ? 'note' : message.direction === 'out' ? 'out' : 'in'

  // Only a message a channel owns can be deleted at the far end, and only where
  // that channel says it can. Everything else in a thread lives here and
  // nowhere else.
  const offerDelete = canDelete && message.source === 'provider'

  return (
    <article id={messageDomId(message.id)} className={`uin-msg uin-msg-${kind}`}>
      <MessageHeader
        message={message}
        personId={personId}
        showAvatars={showAvatars}
        staffById={staffById}
        now={now}
        timezone={timezone}
        tools={tools}
      />
      {message.autoKind && message.autoKind !== 'own-notification' && (
        <div className="uin-msg-foot uin-msg-flag">
          <span className="uin-tag uin-tag-snoozed">{AUTO_LABELS[message.autoKind] ?? 'Sent automatically'}</span>
        </div>
      )}
      <div className="uin-msg-body">
        {/* A NOTE IS NEVER PUT IN THE FRAME. The frame exists to hold a
            stranger's markup at arm's length (E16): it is a document of its own,
            with its own origin, its own white page and a height it has to
            measure and report back. A note has none of that to protect anybody
            from - `noteHtml` escapes what a colleague typed and turns the line
            breaks into <br>, so there is no markup in it at all - and putting
            one in there drew a white sheet on the note's amber ground with
            several hundred pixels of nothing under it, waiting for a height that
            two lines of text were never going to fill. */}
        {kind !== 'note' && message.hasHtml ? (
          <MessageBody
            messageId={message.id}
            hasRemoteImages={message.remoteImages > 0}
            ownSender={message.ownSender}
          />
        ) : (
          <MessageText
            text={message.bodyText ?? '(this message had nothing in it)'}
            foldQuoted={kind !== 'note'}
          />
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

/** What one entry says the person did. Named where naming them is the point:
 *  "asked somebody to look" is the one line in this log where the interesting
 *  half is who was asked rather than who asked, and it was the half being
 *  thrown away. */
function eventWords(event: ThreadEventRow, staffById: Record<string, string>): string {
  if (event.kind === 'mentioned') {
    const wanted = typeof event.detail?.userId === 'string' ? staffById[event.detail.userId] : null
    return wanted ? `asked ${wanted} to look` : 'asked somebody to look'
  }
  return EVENT_WORDS[event.kind] ?? 'changed something'
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


/** The merges one log entry recorded that could still be taken apart.
 *
 *  The entry carries the ids it made; `merges` is what the server says is still
 *  undoable and that this reader is allowed to undo. The intersection is what
 *  gets a button - so a merge already separated out, or one on a conversation
 *  this reader may read but not manage, quietly has none. */
function undoableFromEvent(event: ThreadEventRow, merges: ThreadMergeView[]): ThreadMergeView[] {
  if (event.kind !== 'merged' || merges.length === 0) return []
  const made = event.detail?.mergeIds
  if (!Array.isArray(made)) return []
  return merges.filter((merge) => made.includes(merge.id))
}

/**
 * Whether the catalogue is worth offering on this channel.
 *
 * It used to be offered on email and nothing else, on the reasoning that a
 * channel this module does not own carries words rather than markup and a table
 * of chairs would leave as nothing at all. Half right: the table does not
 * travel, but the words do - the same lines the text half of every email carries
 * - and an enquiry off the contact form is ANSWERED BY EMAIL, so the one channel
 * where somebody most obviously wants to quote a chair was the one channel that
 * would not let them.
 *
 * A text is the exception, and for a reason that is nothing to do with markup:
 * it is billed by the character. Three products silently trebling the cost of a
 * text is not a decision to make on somebody's behalf from a button with a
 * price tag on it.
 */
function productsTravel(channel: string): boolean {
  return channel !== 'sms' && channel !== 'phone'
}

export function ThreadPane({
  base, params, thread, inboxName, messages, events, staff, taggable, staffById,
  canReply, cannotReplyReason, replyTo, replyAllTo, replySubject, forwardSubject, draft,
  canAddProducts, draftProducts, newestFirst,
  canDeleteMessages, blockState, spamState, now, timezone, heldDrafts, showAvatars,
  context, asked, merges, otherInboxNames, scrollToMessageId,
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

  // Where to open the conversation, when it is not at the top. Not while the
  // writing box is opening: somebody who came back to a half-written reply came
  // for the box, which is at the far end of the thread from anything worth
  // scrolling to.
  const openOn = openAs ? null : scrollToMessageId

  return (
    // Keyed on the conversation, so opening the next one starts shut again
    // rather than inheriting whatever was open on the last.
    <ComposerOpenProvider key={thread.id} initialMode={openAs}>
    <div className="uin-thread uin-thread-conv">
      <div className="uin-thread-head">
        {/* The subject and the way out of it on one line, which is where every
            mail program has put them. On a phone the way out is the way back to
            a list that is not on the screen at all, so it says so in words and
            takes the line above; on anything wider it is a cross hard against
            the far edge, and shutting a conversation is how the list comes back
            whole - which there was previously no way at all to do. */}
        <div className="uin-thread-top">
          {/* Two lines, then an ellipsis - so the whole of it goes in the
              title, where a subject cut short can still be read. */}
          <h2 className="uin-thread-subject" title={thread.subject || '(no subject)'}>
            {thread.subject || '(no subject)'}
          </h2>
          {/* What can be done TO the conversation, on the subject's own line and
              hard against the way out of it. Answering is not up here: the arrow
              lives on the message being answered, which is the one thing this
              row could never say which of. The subject gives up the width -
              two lines of it, then an ellipsis. */}
          <ThreadActions
            threadId={thread.id}
            status={thread.status}
            assigneeUserId={thread.assigneeUserId}
            snoozeUntil={thread.snoozeUntil ? thread.snoozeUntil.toISOString() : null}
            staff={staff}
            timezone={timezone}
            spam={spamState.spam}
            spamOwnerName={spamState.ownerName}
            senderAddress={spamState.senderAddress}
            senderBlocked={spamState.senderBlocked}
            canBlock={spamState.canBlock}
          />
          <Link className="uin-thread-close" href={inboxHref(base, params, { id: null })}>
            <span className="uin-back-phone" aria-hidden="true">{BackIcon} Back to the list</span>
            <span className="uin-back-wide" aria-hidden="true">{CloseIcon}</span>
            {/* One name for it whichever of the two is showing, so the link is
                not announced twice on a phone. */}
            <span className="sr-only">Close this conversation and go back to the list</span>
          </Link>
        </div>
        <div className="uin-thread-meta">
          <span>{channelLabel(thread.channel)}</span>
          {inboxName && <span>&middot; {inboxName}</span>}
          {otherInboxNames.map((name) => <span key={name}>&middot; {name}</span>)}
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
          {/* With nothing attached and nowhere it came from, the arrow that
              attaches the first one rides on the end of this line rather than
              taking a strip of its own to say "No context yet" - see
              ThreadContext. */}
          {!hasThreadContext(context) && (
            <span className="uin-thread-meta-end">
              <ThreadContext threadId={thread.id} {...context} compact />
            </span>
          )}
        </div>
        {/* Why there is no arrow on any of the messages. Without it, a
            conversation with the obvious thing missing and no explanation is
            the sort of thing people report as broken. */}
        {!canReply && cannotReplyReason && (
          <p className="uin-thread-cannot">{cannotReplyReason}</p>
        )}
        {/* Beside what is done TO the conversation, because that is what this
            is: it changes what happens next, not what is in the thread. */}
        {blockState && (
          <BlockParticipant
            threadId={thread.id}
            blocked={blockState.blocked}
            channelLabel={blockState.channelLabel}
          />
        )}
        {/* Last in the header, under everything that can be pressed: what this
            conversation is about. Only once there is something to say - with
            nothing on it the arrow is up on the line above. */}
        {hasThreadContext(context) && <ThreadContext threadId={thread.id} {...context} />}
      </div>

      <div className="uin-thread-body">
        {/* Nothing to draw - it moves the pane and gets out of the way. Keyed on
            the conversation so that opening another one starts again rather
            than carrying on with the last one's corrections. */}
        {openOn && (
          <ScrollToMessage key={thread.id} threadId={thread.id} targetId={messageDomId(openOn)} />
        )}
        {/* Before anything else, because on the conversations that have one it
            is the reason this reader is here at all: a colleague put their name
            on it. Its buttons settle THEIR ask and nothing else - the
            conversation's own status, up in the header, is shared by everybody
            who can read it, and three people asked about one order must not
            close it from under each other. */}
        {asked && (
          <div className="uin-asked" role="status">
            <span className="uin-asked-icon" aria-hidden="true">{AtIcon}</span>
            <div className="uin-asked-said">
              <strong>
                {asked.askedBy ? `${asked.askedBy} asked you to look at this.` : 'You were asked to look at this.'}
              </strong>
              {asked.note && <span className="uin-asked-note">&ldquo;{asked.note}&rdquo;</span>}
              {asked.status === 'done' && (
                <span className="uin-asked-state">You have marked this one done.</span>
              )}
              {asked.status === 'snoozed' && asked.backWhen && (
                <span className="uin-asked-state">Set to come back to you {asked.backWhen}.</span>
              )}
            </div>
            <MentionActions mentionId={asked.id} status={asked.status} timezone={timezone} />
          </div>
        )}

        {/* Then anything we had queued to this person, because it changes what
            you are about to do: something was standing by, and reading their
            message without knowing that is how you answer a question twice. Nothing has been sent, and the writing
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
            inboxId={thread.inboxId}
            replyTo={replyTo}
            replyAllTo={replyAllTo}
            canReply={canReply}
            canForward={canReply}
            staff={taggable}
            cannotReplyReason={cannotReplyReason}
            replySubject={replySubject}
            forwardSubject={forwardSubject}
            draft={draft}
            canAddProducts={canAddProducts && productsTravel(thread.channel)}
            draftProducts={draftProducts}
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
              <Message
                key={message.id}
                message={message}
                personId={thread.personId}
                showAvatars={showAvatars}
                staffById={staffById}
                now={now}
                timezone={timezone}
                canDelete={canDeleteMessages}
                tools={(
                  <MessageMenu
                    threadId={thread.id}
                    canReply={canReply}
                    canReplyAll={canReply && replyAllTo.length > replyTo.length}
                  />
                )}
              />
            ))}
          </div>
        )}

        {!newestFirst && (
          <ComposerSlot
            threadId={thread.id}
            inboxId={thread.inboxId}
            replyTo={replyTo}
            replyAllTo={replyAllTo}
            canReply={canReply}
            canForward={canReply}
            staff={taggable}
            cannotReplyReason={cannotReplyReason}
            replySubject={replySubject}
            forwardSubject={forwardSubject}
            draft={draft}
            canAddProducts={canAddProducts && productsTravel(thread.channel)}
            draftProducts={draftProducts}
            timezone={timezone}
          />
        )}

        {events.length > 0 && (
          <details>
            <summary className="uin-chip uin-summary">What has been done to this</summary>
            <ul className="uin-log">
              {events.map((event) => (
                <li key={event.id}>
                  <span>
                    {unattendedEvent(event, staffById) ?? (
                      <>
                        {(event.userId && staffById[event.userId]) || 'Somebody'}{' '}
                        {eventWords(event, staffById)}
                      </>
                    )}
                    {' - '}
                    {formatFull(event.createdAt, timezone)}
                  </span>
                  {/* The one line in the log that can be acted on. A merge that
                      has already been taken apart, or one this reader could not
                      undo anyway, is a line with nothing on the end of it - the
                      list of undoable merges is empty in both cases. */}
                  {undoableFromEvent(event, merges).map((merge) => (
                    <UnmergeButton key={merge.id} merge={merge} />
                  ))}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {/* Last inside the conversation and pinned to the bottom of it, so it is
          there whether you are at the top of a thread or four thousand pixels
          down one. Outside the body on purpose: the body is what scrolls. */}
      <NoteBar threadId={thread.id} staff={taggable} />
    </div>
    </ComposerOpenProvider>
  )
}
