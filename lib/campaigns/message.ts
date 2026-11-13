import { getSiteUrlOrNull } from '@/lib/config/env'
import { getSiteEmailContext, htmlToPlainText } from '@/lib/email/render'
import { getEmailPalette, resolveEmailWrapper, wrapEmailHtml } from '@/lib/email/wrapper'
import { assembleBody, messageIdHeader, outgoingHeaders, replySubject } from '../compose'
import { plainTextToHtml } from '../scheduled'
import { renderInboxSignature } from '../signature'
import { replyToWorthSending, sendingIdentity, type SendableMessage } from '../transport'
import type { Inbox } from '../types'
import { personalise, usesUnsubscribeTag } from './personalise'
import { isEmptyDesign, renderCampaignDesign } from './design'
import { unsubscribeFooter, unsubscribeHeaders, unsubscribeUrl } from './unsubscribe'
import type { Campaign, CampaignRecipient, CampaignStep } from './types'

// ---------------------------------------------------------------------------
// Turning one step and one person into one email.
//
// Everything peculiar to a campaign happens here, and everything that is not
// peculiar to a campaign is borrowed from the composer: the same body
// assembler, the same signature renderer, the same header builder. A mailshot
// that is put together by different code from a reply is a mailshot that looks
// different in an inbox, and looking like an ordinary email is the entire
// strategy.
//
// THE CHASE IS A REPLY TO OUR OWN MESSAGE. In-Reply-To and References point at
// the first thing we sent them, so it lands in that conversation in their mail
// program rather than arriving as a stranger asking whether they saw the last
// one. The subject follows the same rule the composer uses - "Re: " on the
// front, once.
//
// THE TRACKING TAG IS THE SEND'S OWN ID, prefixed so that a delivery event can
// be told apart from one about an ordinary reply without looking anything up.
// ---------------------------------------------------------------------------

/** What a campaign send's tracking tag looks like, so the webhook can tell one
 *  from an ordinary message's id at a glance. */
export const CAMPAIGN_TAG_PREFIX = 'uinc-'

export function campaignTag(sendId: string): string {
  return `${CAMPAIGN_TAG_PREFIX}${sendId}`
}

/** The send id back out of a tag, or null if it is not one of ours. */
export function sendIdFromTag(tag: string | null | undefined): string | null {
  if (!tag || !tag.startsWith(CAMPAIGN_TAG_PREFIX)) return null
  const id = tag.slice(CAMPAIGN_TAG_PREFIX.length)
  return id.length > 0 ? id : null
}

export type BuiltCampaignMessage = {
  sendable: SendableMessage
  /** Our own Message-ID, without the angle brackets - what a chase later says
   *  it is in reply to, and what an appended copy is recognised by. */
  messageId: string
  subject: string
}

export type CampaignMessageContext = {
  campaign: Campaign
  step: CampaignStep
  recipient: CampaignRecipient
  inbox: Inbox
  /** Null when the campaign is not sending under an account of its own. */
  transport: SendableMessage['transport']
  /** The site's name and postal address, for the footer. */
  siteName: string
  postalAddress: string | null
  /** The send row's id, which becomes the tracking tag. Known only once the row
   *  is written, which is deliberate: the row is written before anything is
   *  sent. */
  sendId: string
  /** The Message-ID this will go out under. Decided by the caller BEFORE the
   *  send row is written, so the row and the header carry the same value and a
   *  reply quoting it can be found later. */
  messageId: string
  /** Whether the site has asked to be told what became of its mail. */
  trackOpens: boolean
}

/**
 * The finished message.
 *
 * Throws only if the unsubscribe link cannot be made and the campaign says it
 * must have one - which means ENCRYPTION_KEY or SITE_URL is missing, and
 * sending marketing mail with no way to opt out is not something to do quietly
 * because a setting was empty.
 */
export async function buildCampaignMessage(ctx: CampaignMessageContext): Promise<BuiltCampaignMessage> {
  const { campaign, step, recipient, inbox } = ctx

  // The unsubscribe link is made whenever anything will carry it: the footer,
  // or the message itself through {{unsubscribe_url}} - a designed email with
  // its own "unsubscribe" button in the small print, typically. Either way the
  // mail program's own unsubscribe button gets the same link in the headers.
  const linkInMessage = usesUnsubscribeTag(step.body) || usesUnsubscribeTag(step.subject ?? '')
  const unsubscribe = campaign.includeUnsubscribe || linkInMessage
    ? buildUnsubscribe(recipient.address, campaign.id)
    : null

  const person = {
    title: recipient.title,
    firstName: recipient.firstName,
    lastName: recipient.lastName,
    displayName: recipient.displayName,
    organisationName: recipient.organisationName,
    address: recipient.address,
    unsubscribeUrl: unsubscribe?.url ?? null,
  }

  // A chase with no subject of its own answers the first message. One with a
  // subject of its own says what it was given, personalised like everything
  // else.
  const rawSubject = step.subject?.trim()
    ? step.subject
    : (recipient.firstSubject ?? '')
  const subject = step.stepIndex === 0 || step.subject?.trim()
    ? personalise(rawSubject, person)
    : replySubject(personalise(rawSubject, person))

  // The site's palette and its own merge values, wanted by a designed message
  // and by the site's email design alike - and by nothing else, so only asked
  // for when one of them is in play.
  const designed = !isEmptyDesign(step.bodyDesign)
  const look = designed || campaign.useWrapper
    ? await Promise.all([getEmailPalette(), getSiteEmailContext()])
    : null
  const siteVars: Record<string, string> = look
    ? { siteName: look[1].siteName, siteUrl: look[1].siteUrl, logoUrl: look[1].logoUrl, year: look[1].year }
    : {}

  const bodyHtml = designed && look && step.bodyDesign
    ? renderCampaignDesign({
        design: step.bodyDesign,
        person,
        vars: siteVars,
        colours: look[0].colours,
        fonts: look[0].fonts,
      })
    : plainTextToHtml(personalise(step.body, person))

  const signature = campaign.includeSignature
    ? await renderInboxSignature(inbox)
    : null

  const messageId = ctx.messageId

  const footer = campaign.includeUnsubscribe && unsubscribe
    ? { ...unsubscribeFooter(unsubscribe.url, { siteName: ctx.siteName, postalAddress: ctx.postalAddress }) }
    : null

  const assembled = assembleBody({
    bodyHtml,
    signature,
    // The footer rides in the quoted slot rather than being glued on after,
    // so it lands below the signature in both the markup and the plain text
    // without this file having to know how either of them is put together.
    quoted: footer ? { html: footer.html, text: footer.text } : null,
  })

  // A designed message's plain-text half is read off what was rendered, so it
  // carries the same words - names filled in - rather than the raw design.
  const body = {
    html: campaign.useWrapper && look
      ? wrapEmailHtml({
          bodyHtml: assembled.html,
          subject,
          vars: siteVars,
          palette: look[0],
          layout: await resolveEmailWrapper(campaign.wrapperLayoutId),
        })
      : assembled.html,
    text: designed ? htmlToPlainText(assembled.html) : assembled.text,
  }

  const headers: Record<string, string> = {
    ...outgoingHeaders({
      messageId,
      // A chase is a reply to our own first message, which is what puts it in
      // the same conversation in their mail program.
      inReplyTo: step.stepIndex > 0 ? recipient.firstMessageId : null,
      references: step.stepIndex > 0 && recipient.firstMessageId ? [recipient.firstMessageId] : [],
      ...(ctx.trackOpens && inbox.sendTransport === 'brevo'
        ? { trackingTag: campaignTag(ctx.sendId) }
        : {}),
    }),
    ...(unsubscribe ? unsubscribeHeaders(unsubscribe.url) : {}),
  }

  return {
    messageId,
    subject,
    sendable: {
      to: [recipient.address],
      cc: [],
      // A campaign goes to one person at a time, by name, on purpose. There is
      // nobody to copy in and nobody to copy in quietly.
      bcc: [],
      from: sendingIdentity(inbox),
      transport: ctx.transport,
      // Replies come back to the address it went out as, which is what makes a
      // campaign reply turn into an ordinary conversation on the next
      // collection rather than vanishing. That is the From line's job, though,
      // not a header of its own: a Reply-To repeating the sender says nothing
      // and costs a mark on the spam scorers.
      replyTo: replyToWorthSending({ from: sendingIdentity(inbox), replyTo: inbox.address }),
      subject,
      html: body.html,
      text: body.text,
      headers,
      // Never any. A mailshot with an attachment on it is a mailshot that goes
      // to the junk folder, and five thousand copies of a PDF through somebody's
      // own mailbox is a bad afternoon for everybody.
      attachments: [],
      // The site's own open and click counting, when the site has asked to be
      // told what became of its mail. Core only ever applies it to mail going
      // out over a mailbox's own server - over Brevo, Brevo counts and the
      // tracking tag above brings its answer home - so between the two every
      // campaign send can say whether it arrived and whether it was read. The
      // tag doubles as the reference, so an open finds its send row without a
      // message row in between (see own-tracking.ts).
      tracking: ctx.trackOpens ? { ref: campaignTag(ctx.sendId) } : false,
    },
  }
}

function buildUnsubscribe(address: string, campaignId: string): { url: string } {
  const siteUrl = getSiteUrlOrNull()
  if (!siteUrl) {
    throw new Error('This site has no web address set, so an unsubscribe link cannot be made.')
  }
  return { url: unsubscribeUrl(siteUrl, address, campaignId) }
}

/** The Message-ID as a header value, for anything that has to quote it. */
export { messageIdHeader }
