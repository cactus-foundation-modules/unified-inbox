import { markdownToHtml, markdownToPlainText, sanitizeEmailHtml, emailHtmlToPlainText } from '@/lib/sanitize'
import { interpolate } from '@/lib/email/blocks'
import { renderEmailSignatureHtml, type EmailSignatureData } from '@/lib/email/signature'
import { getEmailPalette, type EmailPalette } from '@/lib/email/wrapper'
import { getSiteEmailContext, type SiteEmailContext } from '@/lib/email/render'
import type { SignatureKind } from './types'

// Turns whichever kind of signature an inbox carries into the pair every email
// needs: the HTML that goes out, and the plain text a text-only client falls
// back to.
//
// One signature per inbox, which is the whole point of an inbox - accounts@
// signs off as the accounts department whoever happens to be typing. What that
// signature is written in is a matter of taste, so all three of the contact
// form's kinds are here, rendered by the same core code, and a site that has
// written one signature already knows how to write this one.
//
// Kept in one place because three callers need identical output - the send, the
// settings preview, and anything that later wants to show what will go out. A
// preview that renders by a different route is a preview that lies.

export type RenderedSignature = { html: string; text: string }

/** Everything rendering a signature needs, and nothing else. An `Inbox`
 *  satisfies it as it stands; the settings preview builds one out of a draft
 *  that has not been saved yet. */
export type SignatureSource = {
  signatureKind: SignatureKind
  signature: string | null
  signatureHtml: string | null
  signaturePuck: unknown
  name: string
  address: string
  fromName: string | null
}

/** The merge values an HTML or block-built signature can carry. Uppercase
 *  because that is the convention a pasted corporate signature arrives with;
 *  core's own site tags ({{siteName}}, {{year}}) still work alongside them.
 *
 *  All three are the inbox's, not the sender's: one signature per inbox means
 *  a reply signs off as the address it left from, whoever pressed Send. A tag
 *  with nothing behind it renders as nothing rather than as literal braces,
 *  which is what `interpolate` does with any tag it cannot fill. */
export function signatureMergeVars(inbox: SignatureSource): Record<string, string> {
  return {
    INBOX_NAME: inbox.name?.trim() ?? '',
    // What the From line will actually say: the name on replies, or the
    // inbox's own name when nobody has set one.
    FROM_NAME: inbox.fromName?.trim() || inbox.name?.trim() || '',
    EMAIL: inbox.address,
  }
}

function isEmptyPuck(data: unknown): boolean {
  const content = (data as EmailSignatureData | null)?.content
  return !Array.isArray(content) || content.length === 0
}

/** True when this inbox would actually put something at the foot of a reply. */
export function hasSignature(inbox: SignatureSource | null): boolean {
  if (!inbox) return false
  switch (inbox.signatureKind) {
    case 'html': return Boolean(inbox.signatureHtml?.trim())
    case 'puck': return !isEmptyPuck(inbox.signaturePuck)
    default: return Boolean(inbox.signature?.trim())
  }
}

/**
 * Whose signature goes at the foot of this reply.
 *
 * A shared inbox's signature signs off as the department - accounts@ signs as
 * accounts whoever is typing - and that is still what a shared address wants.
 * But somebody given an address of their own has written a signature there in
 * their own name, and it is theirs wherever they are answering from: a reply
 * they send out of purchasing@ is still from them.
 *
 * A personal address the other way round settles it just as firmly. A reply
 * leaving marcus@ is from Marcus and says so, whoever pressed Send - a manager
 * sending a draft on his behalf is not signing it in their own name. So when
 * the address being sent from is somebody's own, its signature wins outright
 * and the sender's never gets a look in.
 *
 * That leaves the shared case, where the sender's own address wins when it has
 * a signature to give, and the address the reply is leaving from fills the gap
 * when it has not - which is exactly what happened before anybody had an
 * address of their own, so nobody loses a signature by being given one.
 */
export function chooseSignatureSource<T extends SignatureSource>(
  ownInbox: T | null,
  sendingInbox: T,
  sendingInboxIsSomebodysOwn = false,
): T {
  if (sendingInboxIsSomebodysOwn) return sendingInbox
  return ownInbox && hasSignature(ownInbox) ? ownInbox : sendingInbox
}

/** The site values the block-built kind needs. The send path can pass these in
 *  rather than have one reply read the site config twice. */
export type SignatureRenderContext = { palette: EmailPalette; site: SiteEmailContext }

/** Renders an inbox's signature, or null when there is nothing to render.
 *
 * Touches the database (site palette, site name) only for the block-built kind,
 * and only when the caller has not already got them - the rich text and HTML
 * kinds are pure string work, and making every reply pay for two extra reads to
 * append four lines of text would be a poor trade. */
export async function renderInboxSignature(
  inbox: SignatureSource | null,
  ctx?: SignatureRenderContext,
): Promise<RenderedSignature | null> {
  if (!hasSignature(inbox) || !inbox) return null
  const vars = signatureMergeVars(inbox)

  if (inbox.signatureKind === 'html') {
    // Sanitised on save, so the stored markup is already safe; the merge values
    // are escaped here because they are typed into a form and this is the point
    // where they enter markup.
    const html = interpolate(inbox.signatureHtml ?? '', vars, true)
    return { html, text: emailHtmlToPlainText(html) }
  }

  if (inbox.signatureKind === 'puck') {
    const resolved: SignatureRenderContext = ctx ?? await (async () => {
      const [palette, site] = await Promise.all([getEmailPalette(), getSiteEmailContext()])
      return { palette, site }
    })()
    const { palette, site } = resolved
    const html = renderEmailSignatureHtml({
      data: inbox.signaturePuck as EmailSignatureData,
      vars: { siteName: site.siteName, siteUrl: site.siteUrl, logoUrl: site.logoUrl, year: site.year, ...vars },
      colours: palette.colours,
      fonts: palette.fonts,
    })
    if (!html) return null
    return { html, text: emailHtmlToPlainText(html) }
  }

  const markdown = inbox.signature ?? ''
  return {
    html: markdownToHtml(markdown, { breaks: true }),
    text: markdownToPlainText(markdown, { breaks: true }),
  }
}

/** Sanitises pasted signature markup on the way in. Exported so the create
 * route, the edit route and the preview all clean it the same way - what is
 * stored is then what was checked, and every later reader gets the same
 * markup without having to remember to clean it again. */
export function cleanSignatureHtml(html: string | null | undefined): string | null {
  const raw = (html ?? '').trim()
  if (!raw) return null
  const clean = sanitizeEmailHtml(raw).trim()
  return clean || null
}
