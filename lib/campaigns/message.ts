import { getSiteUrlOrNull } from '@/lib/config/env'
import { assembleBody, messageIdHeader, outgoingHeaders, replySubject } from '../compose'
import { plainTextToHtml } from '../scheduled'
import { renderInboxSignature } from '../signature'
import { sendingIdentity, type SendableMessage } from '../transport'
import type { Inbox } from '../types'
import { personalise } from './personalise'
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

  const person = {
    firstName: recipient.firstName,
    lastName: recipient.lastName,
    displayName: recipient.displayName,
    organisationName: recipient.organisationName,
    address: recipient.address,
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

  const bodyText = personalise(step.body, person)

  const signature = campaign.includeSignature
    ? await renderInboxSignature(inbox)
    : null

  const messageId = ctx.messageId

  const footer = campaign.includeUnsubscribe
    ? buildFooter(recipient.address, campaign.id, ctx.siteName, ctx.postalAddress)
    : null

  const body = assembleBody({
    bodyHtml: plainTextToHtml(bodyText),
    signature,
    // The footer rides in the quoted slot rather than being glued on after,
    // so it lands below the signature in both the markup and the plain text
    // without this file having to know how either of them is put together.
    quoted: footer ? { html: footer.html, text: footer.text } : null,
  })

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
    ...(footer ? unsubscribeHeaders(footer.url) : {}),
  }

  return {
    messageId,
    subject,
    sendable: {
      to: [recipient.address],
      cc: [],
      from: sendingIdentity(inbox),
      transport: ctx.transport,
      // Replies come back to the address it went out as, which is what makes a
      // campaign reply turn into an ordinary conversation on the next
      // collection rather than vanishing.
      replyTo: inbox.address,
      subject,
      html: body.html,
      text: body.text,
      headers,
      // Never any. A mailshot with an attachment on it is a mailshot that goes
      // to the junk folder, and five thousand copies of a PDF through somebody's
      // own mailbox is a bad afternoon for everybody.
      attachments: [],
    },
  }
}

function buildFooter(
  address: string,
  campaignId: string,
  siteName: string,
  postalAddress: string | null,
): { html: string; text: string; url: string } {
  const siteUrl = getSiteUrlOrNull()
  if (!siteUrl) {
    throw new Error('This site has no web address set, so an unsubscribe link cannot be made.')
  }
  const url = unsubscribeUrl(siteUrl, address, campaignId)
  const footer = unsubscribeFooter(url, { siteName, postalAddress })
  return { ...footer, url }
}

/** The Message-ID as a header value, for anything that has to quote it. */
export { messageIdHeader }
