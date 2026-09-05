import { getSiteUrlOrNull } from '@/lib/config/env'
import { isEncryptionKeyUsable } from '@/lib/crypto/secrets'
import { unknownTags, tagsWithoutFallback } from './personalise'
import { checkDomainRecords, domainForPreflight, type PreflightFinding } from './preflight'
import { isAllDay } from './window'
import type { Campaign, CampaignStep, CampaignTally } from './types'
import type { Inbox } from '../types'

// ---------------------------------------------------------------------------
// What stands between a draft and two thousand emails.
//
// Everything here is checked at the moment somebody presses start, not while
// they type: a warning that appears the instant a box is empty trains people to
// ignore warnings, and this is the one screen on the site where the warnings
// have to be read.
//
// A PROBLEM stops it. A WARNING is shown and can be pressed past, because the
// person running the business is entitled to decide that their domain's mail
// records are somebody else's problem for today.
// ---------------------------------------------------------------------------

export type Readiness = {
  problems: string[]
  warnings: string[]
}

export async function assessReadiness(input: {
  campaign: Campaign
  steps: CampaignStep[]
  inbox: Inbox | null
  tally: CampaignTally
  /** Whether the site has somewhere to put its own name and address on the
   *  footer. Null when nobody has filled it in. */
  postalAddress: string | null
  /** Skipped when the caller only wants the cheap half - a DNS lookup on every
   *  keystroke would be silly. */
  checkDns?: boolean
}): Promise<Readiness> {
  const { campaign, steps, inbox, tally } = input
  const problems: string[] = []
  const warnings: string[] = []

  // ---- who it comes from ----
  if (!inbox) {
    problems.push('Choose the address this goes out from.')
  }

  // ---- what it says ----
  const first = steps.find((s) => s.stepIndex === 0)
  if (!first) {
    problems.push('Write the message.')
  } else {
    if (!first.subject?.trim()) problems.push('Give the message a subject.')
    if (!first.body.trim()) problems.push('The message has nothing in it.')
  }

  for (const step of steps) {
    const what = step.stepIndex === 0 ? 'the message' : `follow-up ${step.stepIndex}`
    if (step.stepIndex > 0) {
      if (!step.body.trim()) problems.push(`There is nothing written in ${what}.`)
      if (!step.waitDays) problems.push(`Say how many days to wait before ${what} goes out.`)
    }
    const bad = [...unknownTags(step.subject ?? ''), ...unknownTags(step.body)]
    if (bad.length > 0) {
      problems.push(
        `${capitalise(what)} uses ${bad.map((t) => `{{${t}}}`).join(', ')}, which is not something this can fill in. `
        + 'Check the list of what you can use beside the box.',
      )
    }
    const bare = [...tagsWithoutFallback(step.subject ?? ''), ...tagsWithoutFallback(step.body)]
    if (bare.length > 0) {
      warnings.push(
        `${capitalise(what)} uses ${bare.map((t) => `{{${t}}}`).join(', ')} with nothing to fall back on. `
        + 'Anybody on your list without that filled in gets a gap. Write it as {{first_name|there}} to be safe.',
      )
    }
  }

  // ---- who it goes to ----
  if (tally.total === 0) {
    problems.push('Nobody is on the list yet. Pick who it goes to under "Who it goes to", then save.')
  } else if (tally.queued === 0) {
    problems.push('Everybody on the list has already been written to, has replied, or was left out.')
  }

  // ---- being able to stop it ----
  if (campaign.includeUnsubscribe) {
    if (!input.postalAddress?.trim()) {
      problems.push(
        'The footer needs your business name and address before this can go out. '
        + 'Add it under Settings, Unified Inbox, Campaigns.',
      )
    }
    if (!getSiteUrlOrNull()) {
      problems.push('This site has no web address set, so the unsubscribe link cannot be made.')
    }
    if (!isEncryptionKeyUsable()) {
      problems.push('This site is missing its encryption key, so unsubscribe links cannot be signed.')
    }
  } else {
    warnings.push(
      'The unsubscribe footer is switched off. Marketing email in the UK is expected to carry a way to opt out, '
      + 'and without one people press the spam button instead - which does far more damage than an unsubscribe. '
      + 'Anybody who has already opted out is still left out either way.',
    )
  }

  // ---- having seen it ----
  if (!campaign.testedAt) {
    problems.push('Send yourself a test first. It takes ten seconds and catches the thing a preview does not.')
  }

  // ---- the shape of the run ----
  //
  // Nothing here stops it. A campaign with no hours set is a perfectly ordinary
  // thing to want - a reminder that should go the moment it is due - and the
  // person running the business is entitled to decide that a Sunday morning is
  // fine. They are not entitled to decide it by accident, which is what an
  // empty box with no warning against it would be.
  const allDay = isAllDay(campaign.window)
  const allWeek = !campaign.window.weekdaysOnly
  if (allDay && allWeek) {
    warnings.push(
      'No sending hours or days are set, so this can go out at three in the morning on a Sunday. '
      + 'Fine for a reminder. A mailshot that lands then reads like a machine, which is the one thing this is trying not to do.',
    )
  } else if (allDay) {
    warnings.push(
      'No sending hours are set, so this can go out at three in the morning. '
      + 'Fine for a reminder; less so for anything somebody is meant to read and reply to.',
    )
  } else if (allWeek) {
    warnings.push('Weekends are left in, so some of this will land on a Saturday or Sunday.')
  }

  if (campaign.window.intervalSeconds < 30) {
    warnings.push(
      `One every ${campaign.window.intervalSeconds} seconds is quick for a mailbox that normally sends a handful a day. `
      + 'Ninety seconds is the safer setting and finishes only a little later.',
    )
  }

  // ---- whether it will arrive ----
  if (input.checkDns && inbox) {
    const domain = domainForPreflight(inbox.address)
    if (domain) {
      const findings = await checkDomainRecords(domain)
      for (const finding of findings) push(finding, problems, warnings)
    }
  }

  return { problems, warnings }
}

function push(finding: PreflightFinding, problems: string[], warnings: string[]): void {
  if (finding.level === 'problem') problems.push(finding.message)
  else warnings.push(finding.message)
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
