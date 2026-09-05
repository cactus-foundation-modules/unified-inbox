<p align="center">
  <img src="module-art.webp" alt="Unified Inbox" width="640" />
</p>

# Unified Inbox

Every conversation with every customer and supplier in one place: email, live
chat, contact form enquiries, calls and texts, with the site's own records
sitting beside them. One screen instead of five, and a shared history instead of
whatever happens to be on somebody's phone.

It is not a CRM. There are no pipelines, no deals and no lead scoring. People
exist here for one reason only: so two emails, a live chat and a phone call from
the same human collapse into one story.

## What is in this version

- **Mail accounts.** Point it at the mailbox you already use, with a Test
  connection button that opens it, lists your folders and says in plain English
  what went wrong when it cannot.
- **Inboxes.** The addresses people write to. One mail account can serve several
  of them, each with its own name on the replies, its own signature and its own
  staff.
- **Signatures.** One per inbox, written whichever way suits: typed as rich
  text, pasted as the markup your organisation already uses, or built out of the
  same blocks your site's emails are built from. Fill-in tags for the address,
  its name and the name replies go out under, and a preview before you save.
- **Who can read what.** An inbox with nobody named on it is open to everybody
  who can see the hub. Name one person and it becomes theirs alone, which is how
  the accounts address stays away from the rest of the team.
- **Collecting the post.** Mail is gathered on the site's own schedule, from the
  inbox and the folders you file things into, so a message read on a phone is
  still here.
- **Reading and replying.** One screen: your addresses along the top as tabs,
  where each conversation stands underneath them - open, snoozed, done or the
  lot - the conversations below, and whichever one you have open beside them.
  Reply, reply to everybody, forward, or leave a note only your colleagues see.
  A brand new message opens in a box over the top, so the list stays where it
  was.
- **Sent.** One row per message that has left, newest first, across every
  address you can read, with who it went to, which address it left as, and what
  became of it where the site is watching. Opening one opens the conversation it
  belongs to.
- **Drafts.** Save a half-written reply, or a message you have not finished
  starting, and it waits under the **Drafts** tab until you come back to it. Your own only: a shared address does not mean a shared
  notepad. A reply goes back under its conversation with the words still in the
  box; a new message opens where you left it. Sending one clears it away.
- **Send it later, and chase it up.** A message written at half past eleven at
  night can be set to go out at nine in the morning, and can carry a follow-up
  with it - offered in the same words, and with the same day-and-time box, as
  putting a conversation to sleep: once it has gone, the conversation goes quiet
  until whenever you said and comes back if nobody has answered. A reply cancels the chase on its own,
  so you only see it when there was nothing to see. And if the person it is
  addressed to writes to you before it leaves, the message is held rather than
  sent - their conversation says so, with a link to what was waiting.
- **Getting through it.** Hand a conversation to somebody, set it to come back
  later, mark it done, and search everything you are allowed to see. Both of
  those are bets on silence - "nothing until Thursday" and "nothing more at
  all" - so anybody breaking the silence settles the bet. A reply from the
  customer, or a colleague answering them from their own phone, puts the
  conversation straight back under **Open**, whether it was asleep until
  Thursday or marked done a fortnight ago. Done matters most: a snoozed
  conversation comes back on its own eventually, and a finished one never does,
  so a reply to something you had put away used to sit unread at the top of a
  tab nobody opens. An out-of-office or a bounce is the mail system talking
  rather than a person, and leaves it where it was - which is what stops a
  mailing list dragging a finished conversation back every week. Your own reply,
  sent from here, does the same.
- **Pictures stay off** until you ask for them, and when you do they are fetched
  by the site rather than by your browser, so a sender learns nothing about you.
- **Settings** for how far back to go when starting out, how long to keep
  things, and what to do about attachments.
- **Sending another module's post from one of your inboxes.** Purchase Orders'
  settings and the shop's Notifications settings each carry a box asking which
  inbox that module's automatic email goes out as, so a supplier answering a
  purchase order or a customer answering an order confirmation lands with the
  people who deal with it. Contributed through core's
  `core.outbound-email-identity` point and a hosted settings panel in each of
  those tabs - neither module gains a table, a column or a line of UI of its own,
  and both go straight back to the site's usual address if this module is
  removed.

- **Contacts.** An address book, under its own tab beside the post. Everybody
  who writes in appears in it on their own; you can also add somebody yourself,
  which is the only way the haulier who never emails is ever going to be in
  there. Each card holds a first and last name, a job title, the organisation
  they work for, as many addresses and numbers as they actually use, a website,
  a postal address and a note. Organisations get a card of their own with the
  same details, and a mail domain, so the next person who writes in from that
  company joins them automatically.
- **Categories.** The labels you file contacts under - Supplier, Trade
  customer, Haulier, whatever suits. Tick them on a contact's card, or type a
  new one there and then; the row of them above the list narrows it to one in a
  press. A contact can be in several at once, because a contact often is
  several things at once. Renaming and removing them is under **Settings ->
  Unified Inbox -> People**, and removing one keeps everybody who was in it -
  they simply stop showing the label. It is not a pipeline: nothing moves
  between them on its own and nothing else on the site reads them.
- **Bringing an address book in.** Point it at a CSV out of Outlook, Google
  Contacts, a spreadsheet or whatever the contacts are in now, and it shows you
  each column with its best guess at what it is - change any of them, leave out
  the ones you do not want, look at the first few rows as they would be saved,
  and bring them in. A category column is understood - several to a cell, split
  on commas or semicolons - and there is a box for putting everybody in the file
  in one category besides, for when what they have in common is the file rather
  than anything written in it. Somebody already here is left exactly as they are
  unless you say otherwise, an address that belongs to somebody else stays with
  them, one company named a thousand times over is one organisation rather than
  a thousand, and an import only ever adds a label - it never takes one off. The
  file is read on your own computer and never uploaded.

Live chat, contact form enquiries, calls and texts join the same screen in the
versions after this one, along with the panel of your own records beside each
conversation.

## Setting it up

1. Install the module. It needs `ENCRYPTION_KEY` set on the site, because that
   is what keeps the mailbox password safe.
2. Go to **Settings > Unified Inbox** and add your mail account. For iCloud,
   Google or Outlook you need an app password rather than the one you log in
   with.
3. Press **Test connection**. It will tell you what your folders are called.
4. Add an inbox for each address people write to, and tick one of them as the
   catch-all so nothing goes missing.

Mail is collected on a schedule rather than the moment it arrives: about once an
hour on a paid hosting plan, and once a day on the free one.

## Permissions

| Key | What it allows |
|---|---|
| `unifiedinbox.view` | Read the conversations in the inboxes shared with you |
| `unifiedinbox.reply` | Reply to them, add or correct a contact, and make a category |
| `unifiedinbox.manage` | Set up mail accounts, inboxes and who can read them, import an address book, remove an organisation, rename or remove a category |

## Telling something else when the post arrives

Each inbox can notify a web address whenever a message lands - handy for setting
something else going on its own. Set them up under **Settings -> Unified Inbox**.

Either the details of the message that arrived, or a fixed message of your own
every time, for an address that expects its own wording. What the message
actually said is only included if you tick the box for it: a web address you
notify is a copy of your post going somewhere else.

If the other end expects a signing password, put it in and every note is stamped
with it, so it can tell the message really came from your site. Extra headers go
in the same place, for an address that wants a key.

Notes go out on the same schedule as the mail check rather than the instant a
message lands, and an address that does not answer is tried again a few times
over the next twelve hours before it is left alone.

## Tables

All prefixed `uin_`. Nothing outside this module is altered, and nothing here
points at another module's tables with a foreign key, so any module can be
removed without taking the inbox down with it.
