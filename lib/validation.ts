import { z } from 'zod'

// Shared between the create and the edit route, so an inbox cannot be saved
// through one of them with a field the other would have refused.

export const InboxBody = z.object({
  name: z.string().min(1).max(120),
  address: z.string().min(3).max(255),
  // Whose post it is. Absent means the team's, which is what every address on
  // every site was before the two kinds existed and what a caller that has
  // never heard of them still means.
  kind: z.enum(['individual', 'shared']).optional(),
  // Only read on an individual inbox, and required there - the route checks
  // that separately, because "which person" is a question about the site's
  // staff rather than about the shape of the request.
  ownerUserId: z.string().min(1).max(200).nullable().optional(),
  connectionId: z.string().nullable().optional(),
  imapFolder: z.string().min(1).max(255).optional(),
  sentFolder: z.string().max(255).nullable().optional(),
  isCatchAll: z.boolean().optional(),
  folderOwnsMail: z.boolean().optional(),
  sendTransport: z.enum(['brevo', 'smtp']).optional(),
  brevoApiKey: z.string().nullable().optional(),
  smtpHost: z.string().max(255).nullable().optional(),
  smtpPort: z.number().int().min(1).max(65535).nullable().optional(),
  smtpUsername: z.string().max(255).nullable().optional(),
  smtpPassword: z.string().nullable().optional(),
  fromName: z.string().max(120).nullable().optional(),
  // All three signature kinds are sent on every save, not only the active one:
  // switching kind in the editor must not throw the other two away.
  signatureKind: z.enum(['markdown', 'html', 'puck']).optional(),
  signature: z.string().max(5000).nullable().optional(),
  signatureHtml: z.string().max(50000).nullable().optional(),
  signaturePuck: z.unknown().nullable().optional(),
  appendToSent: z.boolean().optional(),
  colour: z.string().max(32).nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
})

export const InboxPatchBody = InboxBody.partial()

/** The order of the addresses: every inbox id, once, in the order they should appear.
 *  Capped well above any plausible number of addresses so a runaway list is a
 *  refusal rather than a very long UPDATE. */
export const InboxOrderBody = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
})

/** The order one person keeps the top of their own rail in: every entry under
 *  "Yours", once, in the order they want to read them. Inbox ids and the
 *  handful of plain words the rail calls its own folders, so bounded the way
 *  an id is. Capped well above any plausible rail. */
export const RailOrderBody = z.object({
  keys: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
})

/** The order the channels are in, as the rail posts it. Channel keys, so
 *  bounded the way a channel key is - and only the ones the person dragging can
 *  see, which is why the route merges rather than replaces. */
export const ChannelOrderBody = z.object({
  keys: z.array(z.string().trim().min(1).max(100)).min(1).max(50),
})

/** A product on a message: a reference to something the site sells, and never a
 *  name or a price. Everything a customer reads is fetched from the owning
 *  module when the message is sent, so nothing posted here can put words in the
 *  shop's mouth or send last month's price out as this month's. Shared by the
 *  send and the draft routes so a draft cannot hold a product the send route
 *  would then refuse. */
const ProductRefBody = z.object({
  moduleName: z.string().min(1).max(100),
  kind: z.enum(['product', 'variation']),
  id: z.string().min(1).max(200),
})

/** What the composer posts to send a message. Deliberately strict: an
 *  attachment is described by where it already lives in storage, never by
 *  bytes in the request, so nothing can be talked into emailing an arbitrary
 *  file by asking nicely. */
export const SendBody = z.object({
  threadId: z.string().min(1).optional(),
  inboxId: z.string().min(1).optional(),
  mode: z.enum(['reply', 'reply-all', 'forward', 'new']),
  to: z.array(z.string().min(1)).max(50).optional(),
  cc: z.array(z.string().min(1)).max(50).optional(),
  /** Copies the other recipients never see. A list of its own rather than more
   *  entries in `cc`, because that separation is the entire feature. */
  bcc: z.array(z.string().min(1)).max(50).optional(),
  subject: z.string().max(500).optional(),
  bodyHtml: z.string().max(500_000),
  attachments: z
    .array(
      z.object({
        key: z.string().min(1),
        url: z.string().min(1),
        filename: z.string().min(1).max(255),
        contentType: z.string().max(200).nullable().default(null),
      }),
    )
    // A count rather than a weight, and the weight is the real rule: the send
    // route adds the files up against what a mail server will carry (see
    // checkAttachmentBudget) and refuses in English. This is only here so an
    // unbounded array cannot ask the site to fetch ten thousand objects out of
    // storage on one request, which is why it sits so far above anything a
    // person writing an email will reach.
    .max(100)
    .optional(),
  /** The catalogue items printed under the writing, in the order they were
   *  picked. Capped at the same twenty a draft may hold. */
  products: z.array(ProductRefBody).max(20).optional(),
  includeOriginalAttachments: z.boolean().optional(),
  inReplyToMessageId: z.string().min(1).optional(),
  // Generated by whoever pressed Send. Two requests carrying the same one are
  // the same press, and the second sends nothing (E14).
  idempotencyKey: z.string().min(8).max(100),
  /** The draft this was written in, if it was written in one. Thrown away once
   *  the message has actually gone - a draft that outlives its own send is the
   *  reply somebody sends a second time next week. */
  draftId: z.string().min(1).optional(),
  link: z
    .object({
      moduleName: z.string().min(1).max(100),
      recordType: z.string().min(1).max(100),
      recordId: z.string().min(1).max(200),
      label: z.string().min(1).max(300),
    })
    .optional(),
})

/** The files travelling with a message, described by where they already live
 *  in storage. Shared by the send and the draft routes so a draft cannot hold
 *  an attachment the send route would then refuse. */
const AttachmentRef = z.object({
  key: z.string().min(1),
  url: z.string().min(1),
  filename: z.string().min(1).max(255),
  contentType: z.string().max(200).nullable().default(null),
  sizeBytes: z.number().int().min(0).nullable().default(null),
})

/** What either composer posts to put a message down half-written. `id` is
 *  present from the second save onwards, so pressing Save four times leaves one
 *  draft rather than four. */
export const DraftBody = z.object({
  id: z.string().min(1).optional(),
  threadId: z.string().min(1).nullable().optional(),
  /** The message on that conversation being answered. Checked against the
   *  conversation when the draft is sent, not when it is saved: what it names
   *  can be deleted in between, and a draft is not the moment to refuse. */
  inReplyToMessageId: z.string().min(1).nullable().optional(),
  inboxId: z.string().min(1).nullable().optional(),
  mode: z.enum(['new', 'reply', 'reply-all', 'forward']).default('new'),
  to: z.array(z.string().min(1)).max(50).optional(),
  cc: z.array(z.string().min(1)).max(50).optional(),
  bcc: z.array(z.string().min(1)).max(50).optional(),
  subject: z.string().max(500).nullable().optional(),
  /** As typed: the markup the writing box holds, or the plain lines every draft
   *  written before it could hold a typeface holds. Either way, what goes back
   *  into the box has to be what came out of it. */
  body: z.string().max(500_000),
  /** Which of those two. Left out is 'text', which is what every caller written
   *  before the box could hold markup meant. */
  bodyFormat: z.enum(['text', 'html']).optional(),
  /** The same hundred the send route allows, so a draft can never hold more
   *  than the message it becomes. */
  attachments: z.array(AttachmentRef).max(100).optional(),
  products: z.array(ProductRefBody).max(20).optional(),
  /** When it should go out on its own, as the wall clock somebody typed:
   *  "2026-09-04T09:00", with no zone on it. It is turned into an instant on
   *  the server against the SITE's zone - see lib/scheduled.ts - because nine
   *  o'clock means nine o'clock to the person reading the screen, not to
   *  whichever machine happens to be answering. Null takes the time back off
   *  and leaves an ordinary draft. */
  sendAt: z.string().max(40).nullable().optional(),
  /** How long after it goes out to bring the conversation back if nobody has
   *  answered, in minutes. Only read when a time is being set: a follow-up on a
   *  message that is not going anywhere is a conversation that comes back for no
   *  reason. Bounds are checked on the server (lib/scheduled.ts), which is also
   *  where the column's own limits are stated. */
  followUpMinutes: z.number().int().nullable().optional(),
  /** When the conversation should stay asleep until once this message has
   *  actually gone, as an ISO stamp. An absolute moment rather than a length of
   *  time, unlike the chase above: a sleep is a date in somebody's week, and
   *  Friday is Friday whichever hour of Monday the message went out. Read only
   *  when a time is being set, and cleared with the time when one comes off. */
  snoozeUntil: z.string().datetime().nullable().optional(),
})

/** Sending a colleague's draft out for them, from the Drafts folder under their
 *  name. The address it is filed on comes over rather than being worked out from
 *  the draft, so BOTH halves of the question - whose draft, and which address -
 *  are answered against what the screen was actually looking at, the same way
 *  the read-only view fetched it (E17). */
export const SendDraftForBody = z.object({
  inboxId: z.string().min(1),
})

/** What the reading screen posts when somebody works through a conversation.
 *  Every field is optional and any combination is legal, because "mark it done
 *  and hand it to Marcus" is one press of one button. */
export const ThreadPatchBody = z.object({
  unread: z.boolean().optional(),
  status: z.enum(['open', 'snoozed', 'done']).optional(),
  /** An ISO stamp. Only read when the status is 'snoozed'. */
  snoozeUntil: z.string().datetime().nullable().optional(),
  /** A user id, or null to hand it back to nobody in particular. */
  assigneeUserId: z.string().min(1).nullable().optional(),
})

/** Junk, as one person sees it. One boolean, because there are exactly two
 *  answers and neither of them has a date, a reason or a note attached. */
export const ThreadSpamBody = z.object({
  spam: z.boolean(),
})

/** Shutting the site's front door on somebody, or opening it again.
 *
 *  The address is checked for shape here and normalised in lib/blocked-senders.ts
 *  - two jobs, and mixing them is how a block gets stored in a form that the
 *  collecting pass then never matches. 320 characters is the longest an email
 *  address may be (64 local + @ + 255 domain), so anything above it is not one.
 */
export const BlockedSenderBody = z.object({
  address: z.string().trim().min(3).max(320),
  /** False takes them off the list again. Sent as a value rather than implied
   *  by the verb, so the same route answers both and the two can never drift. */
  blocked: z.boolean(),
})

/** Where one colleague's own ask stands. Deliberately the same three words the
 *  conversation itself uses, because they mean the same thing at a smaller
 *  scale - the difference is whose they are. */
export const MentionPatchBody = z.object({
  status: z.enum(['open', 'snoozed', 'done']),
  /** An ISO stamp. Only read when the status is 'snoozed'. */
  snoozeUntil: z.string().datetime().nullable().optional(),
})

/** An internal note. `mentions` carries user ids chosen from the list rather
 *  than names scraped out of the text: a colleague called Sam Smith and another
 *  called Sam Smyth are not something a regular expression should be deciding
 *  between. */
export const NoteBody = z.object({
  text: z.string().min(1).max(20_000),
  mentions: z.array(z.string().min(1)).max(20).optional(),
  /** The catalogue items quoted in the note, in the order they were picked.
   *
   *  A note goes to nobody, which is exactly why the catalogue belongs in one:
   *  the shortest way to ask a colleague about a chair is to put the chair in
   *  front of them. Same references and the same cap as a message - the note is
   *  built from what the shop says when it is saved, so nothing in a request can
   *  put a name or a price on the site's own screen. */
  products: z.array(ProductRefBody).max(20).optional(),
})

// ---------------------------------------------------------------------------
// The three things the new-message menu starts that are not an email.
// ---------------------------------------------------------------------------

/** Starting a discussion: colleagues only, and it goes nowhere near a customer.
 *  Several addresses may be named and each gets its own discussion - see
 *  migrations/030_discussions.sql for why one thread with two guest lists is not
 *  on offer.
 *
 *  `toUserIds` is who it is PUT TO. Colleagues rather than addresses, because
 *  that is what the To line on the form asks for, and because somebody who has
 *  not been given an address of their own is still somebody a discussion can be
 *  put to. Which addresses end up holding it is the server's to work out from
 *  the names - a client that could name the address would be a client that
 *  could file a note in anybody's private post. */
export const DiscussionBody = z.object({
  inboxIds: z.array(z.string().min(1)).min(1, 'Say which address this is for.').max(20),
  subject: z.string().trim().min(1, 'Give the discussion a subject.').max(500),
  body: z.string().min(1, 'There is nothing to say yet.').max(20_000),
  toUserIds: z.array(z.string().min(1)).max(20).optional(),
  mentions: z.array(z.string().min(1)).max(20).optional(),
})

/** Sending a text. Bounded at four segments' worth: past that it is an email
 *  wearing the wrong hat, and each segment is charged for. */
export const SmsBody = z.object({
  to: z.string().trim().min(3).max(40),
  body: z.string().trim().min(1, 'There is nothing to send yet.').max(640),
})

/** Ringing somebody. Two-leg: the site calls whoever pressed the button first,
 *  then the customer, so `callMeAt` is required rather than assumed. */
export const CallBody = z.object({
  to: z.string().trim().min(3).max(40),
  from: z.string().trim().min(3).max(40),
  callMeAt: z.string().trim().min(3).max(40),
})

// ---------------------------------------------------------------------------
// Contacts.
//
// One schema for the new card and the edit, so a field cannot be saved through
// one of them that the other would have refused. Every field is optional
// because a card with nothing on it but a phone number is a perfectly good
// contact - what the routes refuse is a card with nothing on it at all.
// ---------------------------------------------------------------------------

/** A single line of somebody's details. Generous, but not unbounded: a value
 *  longer than this is a paste that went wrong rather than an address. */
const line = z.string().trim().max(300)

export const ContactBody = z.object({
  firstName: line.optional(),
  lastName: line.optional(),
  jobTitle: line.optional(),
  organisation: line.optional(),
  /** The labels, comma separated, as the one box on the card writes them.
   *  Left out means "leave whatever is on them alone"; sent empty means "none
   *  of them", which is a thing somebody can mean. */
  categories: z.string().trim().max(600).optional(),
  email: line.optional(),
  phone: line.optional(),
  website: line.optional(),
  addressLine1: line.optional(),
  addressLine2: line.optional(),
  addressCity: line.optional(),
  addressCounty: line.optional(),
  addressPostcode: line.optional(),
  addressCountry: line.optional(),
  notes: z.string().trim().max(4000).optional(),
})

/** A way of reaching somebody, added to a card by hand. 'chat' is not offered:
 *  a chat identity is issued by the service that owns the chat and typing one
 *  in would attach a conversation to the wrong person. */
export const IdentityBody = z.object({
  kind: z.enum(['email', 'phone']),
  value: z.string().trim().min(1).max(300),
})

export const OrganisationBody = z.object({
  name: z.string().trim().min(1).max(200),
  domain: line.nullable().optional(),
  email: line.nullable().optional(),
  phone: line.nullable().optional(),
  website: line.nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  addressLine1: line.nullable().optional(),
  addressLine2: line.nullable().optional(),
  addressCity: line.nullable().optional(),
  addressCounty: line.nullable().optional(),
  addressPostcode: line.nullable().optional(),
  addressCountry: line.nullable().optional(),
})

export const OrganisationPatchBody = OrganisationBody.partial()

/** A label on a contact. Short on purpose: a category is a word or three, and
 *  a sentence in this box is a note that has ended up in the wrong field. */
export const CategoryBody = z.object({
  name: z.string().trim().min(1).max(80),
})

/** The order the categories are listed in: every id, once, in the order they
 *  should appear. Capped well above any plausible number so a runaway list is
 *  a refusal rather than a very long run of UPDATEs. */
export const CategoryOrderBody = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
})

/** What the import screen posts: the rows it read out of the file and what it
 *  decided each column was. The file itself never leaves the browser - it is
 *  parsed there so the mapping step has something to show, and sending the rows
 *  rather than the file means the server applies exactly what was previewed. */
export const ContactImportBody = z.object({
  /** One entry per column, in the file's own order. '' is "leave this column
   *  out", which is the honest answer for most of what Outlook exports. */
  columns: z.array(z.string().max(60)).max(500),
  /** ONE BATCH of the file, not the whole thing - the screen sends it in
   *  chunks, so none of these ceilings is what limits an import any more.
   *  They are here to refuse something absurd, not to be met. A cell may be
   *  long: a notes column pasted out of a CRM regularly runs to a page. */
  rows: z.array(z.array(z.string().max(20000)).max(500)).max(1000),
  /** How many data rows went before this batch, so a problem can be reported
   *  against the line the spreadsheet shows rather than the line in the chunk. */
  rowOffset: z.number().int().min(0).max(1000000).default(0),
  updateExisting: z.boolean().default(false),
  /** One category for everybody in the file, on top of whatever a category
   *  column says. "These four hundred are all hauliers" is a thing somebody
   *  knows about the file rather than something written in it. */
  categoryName: z.string().trim().max(80).nullable().optional(),
})

// ---------------------------------------------------------------------------
// Campaigns.
//
// One schema for the create and the edit, so a campaign cannot be saved through
// one of them with a value the other would have refused - and every bound here
// matches a CHECK constraint in migration 027, so a value that gets past this
// is still refused by the database rather than stored wrong.
// ---------------------------------------------------------------------------

/**
 * The clock: when it may send, and how fast.
 *
 * EVERY BOX ON THE WHEN SECTION MAY BE LEFT EMPTY, and null is how an empty box
 * arrives. Null is not "leave it as it was" - undefined is that. Null is the
 * person saying "no restriction", and the route turns each one into the widest
 * value the column will take: midnight to midnight, no cap, the standing pace.
 */
export const CampaignWindowBody = z.object({
  /** "08:00", site time. Turned into minutes past midnight on the server.
   *  Null means no restriction on the time of day. */
  startTime: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(),
  endTime: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(),
  weekdaysOnly: z.boolean().optional(),
  /** Dates to sit out, "YYYY-MM-DD". Christmas, the August bank holiday, the
   *  week the office is shut. */
  skipDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(60).optional(),
  /** Null falls back to the standing pace: there is no such thing as no gap. */
  intervalSeconds: z.number().int().min(20).max(3600).nullable().optional(),
  jitterSeconds: z.number().int().min(0).max(600).nullable().optional(),
  dailyCap: z.number().int().min(1).max(100_000).nullable().optional(),
  rampEnabled: z.boolean().optional(),
  rampStart: z.number().int().min(1).max(100_000).nullable().optional(),
})

/** One step: the message, or one of the chases after it. */
export const CampaignStepBody = z.object({
  stepIndex: z.number().int().min(0).max(3),
  /** Days after the step before it. Null only on step 0. */
  waitDays: z.number().int().min(1).max(90).nullable().optional(),
  /** Null on a chase means "Re: whatever the message said". */
  subject: z.string().max(500).nullable().optional(),
  /** As typed, not as HTML: what goes back into the box has to be what came out
   *  of it, and the markup is made at the moment of sending. */
  body: z.string().max(100_000),
})

export const CampaignBody = z.object({
  name: z.string().trim().min(1).max(200),
  inboxId: z.string().min(1).nullable().optional(),
  includeSignature: z.boolean().optional(),
  includeUnsubscribe: z.boolean().optional(),
  copyToSent: z.boolean().optional(),
  excludeColleagues: z.boolean().optional(),
  /** The labels it goes to. Empty means the whole address book, which is what
   *  "everyone" on the Who step asks for. */
  categoryIds: z.array(z.string().min(1)).max(50).optional(),
  /** The wall clock it may start at - "2026-09-08T08:00", with no zone on it,
   *  read against the SITE's zone on the server. */
  startAt: z.string().max(40).nullable().optional(),
  window: CampaignWindowBody.optional(),
  steps: z.array(CampaignStepBody).min(1).max(4).optional(),
})

export const CampaignPatchBody = CampaignBody.partial()

/** Start, pause, resume, stop. Separate from the edit so that changing what a
 *  campaign says and changing whether it is sending are two different requests
 *  with two different answers. */
export const CampaignStateBody = z.object({
  action: z.enum(['start', 'pause', 'resume', 'stop']),
  /** Set when somebody has read the warnings and meant it anyway. Only ever
   *  gets past warnings - a problem is a problem. */
  acceptWarnings: z.boolean().optional(),
})

/** Building the list, or adding the people who have appeared since. */
export const CampaignAudienceBody = z.object({
  mode: z.enum(['rebuild', 'topUp']),
})

/** Sending the whole thing again, to everybody, including the people who have
 *  already had it. `confirm` is not ceremony: it is the difference between a
 *  request somebody meant and a request some other tab made on their behalf. */
export const CampaignRestartBody = z.object({
  confirm: z.literal(true),
})

/** One waiting person, written to now because somebody pressed the button on
 *  the progress table rather than waiting for the clock. */
export const CampaignSendNowBody = z.object({
  recipientId: z.string().min(1).max(64),
})

/** Sending yourself one, which is what unlocks the start button. */
export const CampaignTestBody = z.object({
  to: z.string().trim().min(3).max(255),
  stepIndex: z.number().int().min(0).max(3).default(0),
})

/** An address nobody may write to again, added by hand. */
export const SuppressionBody = z.object({
  address: z.string().trim().min(3).max(255),
  note: z.string().trim().max(500).nullable().optional(),
})

/** What the merge screen posts: the other conversations to fold into the one in
 *  the address. Capped at the same number the merge itself refuses above, so an
 *  over-long list is turned away before a database is opened. */
export const ThreadMergeBody = z.object({
  loserIds: z.array(z.string().min(1).max(200)).min(1).max(20),
})
