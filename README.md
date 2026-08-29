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
- **Who can read what.** An inbox with nobody named on it is open to everybody
  who can see the hub. Name one person and it becomes theirs alone, which is how
  the accounts address stays away from the rest of the team.
- **Collecting the post.** Mail is gathered on the site's own schedule, from the
  inbox and the folders you file things into, so a message read on a phone is
  still here.
- **Reading and replying.** One screen: your addresses down the side, the
  conversations in the middle, and whichever one you have open beside them.
  Reply, reply to everybody, forward, or leave a note only your colleagues see.
- **Getting through it.** Hand a conversation to somebody, set it to come back
  later, mark it done, and search everything you are allowed to see.
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
| `unifiedinbox.reply` | Reply to them |
| `unifiedinbox.manage` | Set up mail accounts, inboxes and who can read them |

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
