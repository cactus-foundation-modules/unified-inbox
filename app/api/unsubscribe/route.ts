import { NextRequest } from 'next/server'
import { getSiteEmailContext } from '@/lib/email/render'
import { normaliseAddress } from '@/modules/unified-inbox/lib/addresses'
import { tokenMatches } from '@/modules/unified-inbox/lib/campaigns/unsubscribe'
import {
  addSuppression,
  isSuppressed,
  unsubscribeEverywhere,
} from '@/modules/unified-inbox/lib/campaigns/store'

// Making it stop, from the link at the bottom of the message.
//
// No login, no account, no "we are sorry to see you go, please tell us why".
// The address and its signature are in the link; the signature is checked, the
// address goes on the suppression list, and every campaign queue on the site is
// cleared of them in the same breath. Somebody who unsubscribes on Monday and
// gets a different mailshot on Tuesday presses the spam button instead, which
// does far more damage than the unsubscribe did.
//
// GET shows what is about to happen and asks. POST does it - which is also
// exactly what a mail program's own unsubscribe button sends when it honours
// `List-Unsubscribe-Post`, so the same handler serves both and a reader who
// never sees this page is unsubscribed just the same.
//
// It answers in HTML rather than JSON because a person is reading it, and it
// never says which campaign unless it was told: the link has to keep working
// long after that campaign has been deleted.
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const parsed = readRequest(request)
  if (!parsed.ok) return page(parsed.title, parsed.body, 400)

  const site = await getSiteEmailContext()
  if (await isSuppressed(parsed.address)) {
    return page(
      'You are already unsubscribed',
      `<p><strong>${escape(parsed.address)}</strong> is already off the list. Nothing further will be sent to it.</p>`
      + footer(site.siteName),
    )
  }

  return page(
    'Unsubscribe',
    `<p>This takes <strong>${escape(parsed.address)}</strong> off our email list. `
    + 'You will still get anything you have specifically asked us for, such as an order confirmation or a reply to something you sent us.</p>'
    + `<form method="post">
         <button type="submit">Yes, unsubscribe me</button>
       </form>`
    + footer(site.siteName),
  )
}

export async function POST(request: NextRequest) {
  const parsed = readRequest(request)
  if (!parsed.ok) return page(parsed.title, parsed.body, 400)

  const site = await getSiteEmailContext()

  await addSuppression({
    address: parsed.address,
    reason: 'unsubscribed',
    campaignId: parsed.campaignId,
    note: 'They used the unsubscribe link.',
  })
  // Everywhere, not only the campaign whose link they pressed: an opt-out is
  // from this business rather than from one mailshot.
  await unsubscribeEverywhere(parsed.address, new Date())

  return page(
    'Done',
    `<p><strong>${escape(parsed.address)}</strong> has been taken off the list. `
    + 'It takes effect straight away, and nothing further will be sent to it.</p>'
    + footer(site.siteName),
  )
}

type ParsedRequest =
  | { ok: true; address: string; campaignId: string | null }
  | { ok: false; title: string; body: string }

function readRequest(request: NextRequest): ParsedRequest {
  const params = request.nextUrl.searchParams
  const address = normaliseAddress(params.get('e') ?? '')
  const token = params.get('t') ?? ''

  if (!address || !token) {
    return {
      ok: false,
      title: 'That link is not complete',
      body: '<p>Some of the link seems to have been lost on the way - mail programs sometimes break long links across two lines. '
        + 'Try copying the whole thing into your browser, or reply to the email and ask us to take you off.</p>',
    }
  }
  if (!tokenMatches(address, token)) {
    return {
      ok: false,
      title: 'That link does not look right',
      body: '<p>We could not check that link, so nothing has been changed. '
        + 'Reply to the email you received and ask us to take you off the list - that always works.</p>',
    }
  }
  return { ok: true, address, campaignId: params.get('c') }
}

function footer(siteName: string): string {
  return `<p class="from">${escape(siteName)}</p>`
}

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * The page itself.
 *
 * Deliberately one file with its own styles inside it: this has to render for
 * somebody who is not logged in, on a phone, possibly years after the campaign
 * that sent it, and it must not depend on a theme, a font or an asset that may
 * have been changed since. It is also the one page on the site where a broken
 * layout costs a spam complaint.
 */
function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 3rem 1.25rem;
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #f6f6f6; color: #1a1a1a;
    display: flex; justify-content: center;
  }
  main { max-width: 32rem; width: 100%; background: #fff; border-radius: 12px; padding: 2rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  h1 { font-size: 1.35rem; margin: 0 0 1rem; }
  p { margin: 0 0 1rem; }
  button {
    font: inherit; padding: .65rem 1.1rem; border-radius: 8px;
    border: 1px solid #1a1a1a; background: #1a1a1a; color: #fff; cursor: pointer;
  }
  button:hover { background: #333; }
  .from { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #e5e5e5; color: #666; font-size: .875rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #101010; color: #ededed; }
    main { background: #1c1c1c; box-shadow: none; }
    button { background: #ededed; color: #101010; border-color: #ededed; }
    button:hover { background: #fff; }
    .from { border-top-color: #333; color: #999; }
  }
</style>
</head>
<body><main><h1>${escape(title)}</h1>${body}</main></body>
</html>`

  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}
