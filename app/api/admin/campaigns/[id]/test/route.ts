import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getSiteEmailContext } from '@/lib/email/render'
import { isValidAddress, normaliseAddress } from '@/modules/unified-inbox/lib/addresses'
import { canReplyToInbox } from '@/modules/unified-inbox/lib/access'
import { getInbox, getSettings } from '@/modules/unified-inbox/lib/db'
import { generateMessageId } from '@/modules/unified-inbox/lib/compose'
import { deliver, transportForInbox } from '@/modules/unified-inbox/lib/transport'
import { buildCampaignMessage } from '@/modules/unified-inbox/lib/campaigns/message'
import {
  getCampaign,
  listSteps,
  markCampaignTested,
  previewRecipients,
} from '@/modules/unified-inbox/lib/campaigns/store'
import { CampaignTestBody } from '@/modules/unified-inbox/lib/validation'

// Sending yourself one, which is what unlocks the start button.
//
// It goes through exactly the same builder the real thing does - same
// signature, same footer, same threading headers - because the entire point is
// to catch the things a preview cannot show: a signature that renders as a wall
// of markup, a merge tag with no fallback landing on somebody with no first
// name, a footer with the wrong company address on it.
//
// It is personalised from a REAL person off the list where there is one, and
// from the tester otherwise. A test that says "Dear Jane" when every actual
// recipient will get "Dear " has tested nothing.
export const maxDuration = 60

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.campaigns')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const campaign = await getCampaign(id)
  if (!campaign) return errorResponse('That campaign is no longer here.', 404)

  const parsed = CampaignTestBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That test could not be sent.')

  const to = normaliseAddress(parsed.data.to)
  if (!isValidAddress(to)) return errorResponse('That does not look like an email address.')

  if (!campaign.inboxId) return errorResponse('Choose the address this goes out from first.')
  if (!await canReplyToInbox(user, campaign.inboxId)) {
    return errorResponse('You cannot send from that address.', 403)
  }
  const inbox = await getInbox(campaign.inboxId)
  if (!inbox) return errorResponse('The address it sends from is no longer here.')

  const steps = await listSteps(id)
  const step = steps.find((s) => s.stepIndex === parsed.data.stepIndex)
  if (!step) return errorResponse('There is no such step on this campaign.')
  if (!step.body.trim()) return errorResponse('There is nothing written in it yet.')

  const settings = await getSettings()
  const site = await getSiteEmailContext()

  // A real person off the list, so the test shows what a real one will get.
  const sample = (await previewRecipients(id, 1))[0] ?? null

  const stamp = new Date()
  const messageId = generateMessageId(inbox.address)
  const built = await buildCampaignMessage({
    campaign,
    step,
    recipient: {
      id: 'test',
      campaignId: campaign.id,
      personId: null,
      address: to,
      firstName: sample?.firstName ?? user.displayName?.split(' ')[0] ?? null,
      lastName: sample?.lastName ?? null,
      displayName: sample?.displayName ?? user.displayName ?? null,
      organisationName: sample?.organisationName ?? null,
      state: 'queued',
      stepIndex: step.stepIndex,
      dueAt: null,
      claimedAt: null,
      // A chase threads onto the first message. There is not one here, so it
      // goes out as its own message with the subject spelled out - which is
      // what the tester needs to read anyway.
      firstMessageId: null,
      lastMessageId: null,
      firstSubject: steps.find((s) => s.stepIndex === 0)?.subject ?? null,
      lastSentAt: null,
      repliedAt: null,
      unsubscribedAt: null,
      bouncedAt: null,
      reason: null,
    },
    inbox,
    transport: await transportForInbox(inbox),
    siteName: site.siteName,
    postalAddress: settings.campaignFooterAddress,
    sendId: 'test',
    messageId,
    // Never on a test: an open recorded against a campaign that has not started
    // is a number that means nothing and cannot be removed.
    trackOpens: false,
  }).catch((err: unknown) => {
    return { error: err instanceof Error ? err.message : String(err) } as const
  })

  if ('error' in built) return errorResponse(built.error)

  // Said out loud in the subject so a test sitting in an inbox next to the real
  // thing three days later cannot be mistaken for it.
  built.sendable.subject = `[TEST] ${built.sendable.subject}`

  const outcome = await deliver(built.sendable)
  if (!outcome.ok) return errorResponse(outcome.error)

  await markCampaignTested(id, stamp)

  return NextResponse.json({ ok: true, to, personalisedFrom: sample?.address ?? null })
}
