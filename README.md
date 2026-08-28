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

This is the groundwork release. It sets up the parts everything else stands on:

- **Mail accounts.** Point it at the mailbox you already use, with a Test
  connection button that opens it, lists your folders and says in plain English
  what went wrong when it cannot.
- **Inboxes.** The addresses people write to. One mail account can serve several
  of them, each with its own name on the replies, its own signature and its own
  staff.
- **Who can read what.** An inbox with nobody named on it is open to everybody
  who can see the hub. Name one person and it becomes theirs alone, which is how
  the accounts address stays away from the rest of the team.
- **Settings** for how far back to go when starting out, how long to keep
  things, and what to do about attachments.

Collecting, reading and replying to mail arrive in the versions after this one.

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

## Tables

All prefixed `uin_`. Nothing outside this module is altered, and nothing here
points at another module's tables with a foreign key, so any module can be
removed without taking the inbox down with it.
