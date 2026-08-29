import { prisma } from '@/lib/db/prisma'
import {
  addIdentity,
  counterpartyMessage,
  providerCounterparty,
  providerThreadsNeedingPeople,
  createPerson,
  findOrCreateOrganisation,
  findPersonByIdentity,
  getOrganisation,
  getPerson,
  getSettings,
  listIdentities,
  listInboxes,
  recordLink,
  setThreadPerson,
  markThreadLinked,
  threadHasLink,
  threadsNeedingLinks,
  unresolvedThreads,
  updatePerson,
} from './db'
import {
  displayNameFor,
  domainOf,
  identityKey,
  phoneKey,
  isPersonalDomain,
  organisationNameFromDomain,
  resolveOwnDomains,
  shouldBecomePerson,
  type PersonGate,
} from './people'
import { compilePatterns, extractReferences } from './linking'
import { confirmReference } from './adapters'
import type { ContextQuery } from './adapters'
import type { UnifiedInboxSettings } from './types'

// Turning "an address wrote to us" into "this person wrote to us", and then
// showing what else the site knows about them.
//
// The whole of D15 is in the first paragraph of people.ts and holds here too:
// this exists so two emails, a chat and a phone call from one human collapse
// into one story. There is no pipeline, no stage and no score anywhere below,
// and the day somebody adds one this has stopped being what was asked for.
//
// Two rules that are not obvious from the code:
//
//   Nothing here mints a person for an automatic message. A bounce, an
//   out-of-office and a mailing list are the mail system talking; a contact
//   record for MAILER-DAEMON is clutter at best (E8).
//
//   Nothing here creates a person for one of us (E18). Our inboxes, our staff
//   and anybody at our own domains are colleagues, and a customer record for
//   the person at the next desk is how this layer stops being trusted.

/** How many unresolved conversations one catch-up pass takes on. Small on
 *  purpose: it rides along on the sync tick, which already has a budget and
 *  something more important to spend it on. */
export const CATCH_UP_BATCH = 40

/** How many conversations one pass looks for record references in. Lower than
 *  the people batch because each one can cost a lookup per reference found. */
export const LINK_BATCH = 25

export type ResolutionContext = {
  gate: PersonGate
  settings: UnifiedInboxSettings
}

/**
 * Everything the resolver needs that does not change between messages: which
 * addresses are ours, who the staff are, and what the owner has configured.
 *
 * Built once per sync run rather than per message. It is three small queries,
 * and running them for every email in a mailbox is how a 25 second budget goes.
 */
export async function buildResolutionContext(): Promise<ResolutionContext> {
  const [inboxes, staff, settings] = await Promise.all([
    listInboxes(),
    prisma.user.findMany({ select: { email: true } }),
    getSettings(),
  ])

  const ownAddresses = new Set(
    inboxes.map((i) => identityKey(i.address)).filter((a): a is string => !!a),
  )
  const staffAddresses = new Set(
    staff.map((u) => identityKey(u.email)).filter((a): a is string => !!a),
  )
  const ownDomains = resolveOwnDomains(
    inboxes.map((i) => i.address),
    settings.ownDomains,
    settings.personalDomains,
  )

  return { gate: { ownAddresses, staffAddresses, ownDomains }, settings }
}

/**
 * Work out whose conversation this is, and attach them to it.
 *
 * The counterparty is taken from the newest INBOUND message where there is one,
 * because that is the only place their name appears - our own replies carry an
 * address and nothing else. A conversation we started resolves against whoever
 * we wrote to, since the owner deliberately wrote to a real person.
 *
 * Returns the person id, or null when there is nobody worth recording. Null is
 * a perfectly ordinary answer: a bounce, a newsletter and an email from a
 * colleague all end up here.
 */
export async function resolveThreadPerson(
  threadId: string,
  context: ResolutionContext,
): Promise<string | null> {
  const message = await counterpartyMessage(threadId)
  if (!message) return null

  // An out-of-office, a bounce or a mailing list is the mail system talking.
  // Minting a person for one gives the site a contact called MAILER-DAEMON (E8).
  if (message.autoKind) return null

  const address = message.direction === 'in'
    ? message.fromAddress
    : message.toAddresses.find((a) => shouldBecomePerson(a, context.gate)) ?? null

  if (!shouldBecomePerson(address, context.gate)) return null
  const key = identityKey(address)
  if (!key || !address) return null

  const existing = await findPersonByIdentity([key])
  if (existing) {
    const organisationId = (await getPerson(existing))?.organisationId ?? null
    await setThreadPerson(threadId, existing, organisationId)
    return existing
  }

  const domain = domainOf(key)
  const organisationName = organisationNameFromDomain(domain, context.settings.personalDomains)
  const organisationId = domain && organisationName
    ? await findOrCreateOrganisation(domain, organisationName)
    : null

  const personId = await createPerson({
    displayName: displayNameFor(message.direction === 'in' ? message.fromName : null, address),
    primaryEmail: address,
    organisationId,
  })
  await addIdentity({
    personId,
    kind: 'email',
    value: address,
    matchValue: key,
    source: 'imap',
  })
  await setThreadPerson(threadId, personId, organisationId)
  return personId
}

/**
 * Work out who a conversation from another channel is with.
 *
 * A chat and an enquiry carry an address and go down the same road as an email.
 * A call or a text carries a number and nothing else, which is why a person can
 * be recognised by their number at all: somebody who emailed in March and rang
 * in April is one person with two ways of being reached, which is the entire
 * point of this layer.
 *
 * The gate is the same one email goes through - our own addresses and our own
 * staff never become customers (E18) - and a number is not put through it,
 * because a number has no domain to judge and our own numbers never appear as
 * the other party.
 */
export async function resolveProviderThreadPerson(
  threadId: string,
  context: ResolutionContext,
): Promise<string | null> {
  const party = await providerCounterparty(threadId)
  if (!party) return null

  const emailKey = shouldBecomePerson(party.address, context.gate) ? identityKey(party.address) : null
  const numberKey = phoneKey(party.phone)
  if (!emailKey && !numberKey) return null

  const existing = await findPersonByIdentity([emailKey, numberKey].filter((k): k is string => !!k))
  if (existing) {
    const person = await getPerson(existing)
    await setThreadPerson(threadId, existing, person?.organisationId ?? null)
    // Somebody known by their address who has now rung, or the other way round.
    // The second identity is what makes the two halves one story.
    await attachIdentities(existing, party, emailKey, numberKey)
    return existing
  }

  const domain = emailKey ? domainOf(emailKey) : null
  const organisationName = domain
    ? organisationNameFromDomain(domain, context.settings.personalDomains)
    : null
  const organisationId = domain && organisationName
    ? await findOrCreateOrganisation(domain, organisationName)
    : null

  const personId = await createPerson({
    displayName: displayNameFor(party.name, party.address) ?? party.phone ?? null,
    primaryEmail: emailKey && party.address ? party.address.toLowerCase() : null,
    organisationId,
  })
  await attachIdentities(personId, party, emailKey, numberKey)
  await setThreadPerson(threadId, personId, organisationId)
  return personId
}

async function attachIdentities(
  personId: string,
  party: { address: string | null; phone: string | null },
  emailKey: string | null,
  numberKey: string | null,
): Promise<void> {
  if (emailKey && party.address) {
    await addIdentity({
      personId,
      kind: 'email',
      value: party.address,
      matchValue: emailKey,
      source: 'provider',
    })
  }
  if (numberKey && party.phone) {
    await addIdentity({
      personId,
      kind: 'phone',
      value: party.phone,
      matchValue: numberKey,
      source: 'provider',
    })
  }
}

/**
 * Attach a person to every conversation from another channel that has not got
 * one yet, a batch at a time. Same shape and the same budget rules as the mail
 * one below.
 */
export async function catchUpProviderPeople(limit = CATCH_UP_BATCH): Promise<number> {
  const pending = await providerThreadsNeedingPeople(limit)
  if (pending.length === 0) return 0
  const context = await buildResolutionContext()
  let resolved = 0
  for (const thread of pending) {
    try {
      if (await resolveProviderThreadPerson(thread.id, context)) resolved += 1
    } catch (err) {
      console.error('[unified-inbox] could not work out whose conversation this is:', err)
    }
  }
  return resolved
}

/**
 * Attach a person to every conversation that has not got one yet, a batch at a
 * time.
 *
 * This is what makes the people layer arrive on a site that has already been
 * collecting mail for weeks, and it is the same code path the live one uses -
 * so there is one set of rules about who becomes a person, not two that drift.
 * Bounded and resumable, like everything else that runs on the tick.
 */
export async function catchUpPeople(limit = CATCH_UP_BATCH): Promise<number> {
  const pending = await unresolvedThreads(limit)
  if (pending.length === 0) return 0
  const context = await buildResolutionContext()
  let resolved = 0
  for (const thread of pending) {
    try {
      if (await resolveThreadPerson(thread.id, context)) resolved += 1
    } catch (err) {
      console.error('[unified-inbox] could not work out whose conversation this is:', err)
    }
  }
  return resolved
}

/**
 * The people pass, run after a sync: work out whose conversations the new ones
 * are, then attach the records they mention.
 *
 * Bounded and resumable, like everything else on the tick - each pass takes a
 * batch and the next one picks up where it left off, so a mailbox with years of
 * history catches up over a few hours rather than blowing one slice. Failures
 * are per conversation: one message nobody can make sense of must not stop the
 * rest of the morning's mail being filed.
 */
export async function runPeoplePass(opts: {
  people?: number
  links?: number
  deadline?: number
} = {}): Promise<{ people: number; links: number }> {
  const outOfTime = () => opts.deadline !== undefined && Date.now() >= opts.deadline

  let people = 0
  if (!outOfTime()) {
    try {
      people = await catchUpPeople(opts.people ?? CATCH_UP_BATCH)
    } catch (err) {
      console.error('[unified-inbox] the people pass could not run:', err)
    }
  }

  // The channels somebody else owns get the same treatment, in their own batch:
  // a caller and a correspondent are the same person, and the whole people
  // layer exists to say so.
  if (!outOfTime()) {
    try {
      people += await catchUpProviderPeople(opts.people ?? CATCH_UP_BATCH)
    } catch (err) {
      console.error('[unified-inbox] the people pass could not run for the other channels:', err)
    }
  }

  let links = 0
  if (!outOfTime()) {
    try {
      const settings = await getSettings()
      if (settings.autoLink) {
        const pending = await threadsNeedingLinks(opts.links ?? LINK_BATCH)
        for (const thread of pending) {
          if (outOfTime()) break
          try {
            links += await autoLinkThread(thread.id, settings)
          } catch (err) {
            console.error('[unified-inbox] could not look for records on a conversation:', err)
          }
          // Marked either way. A conversation that mentions nothing must not be
          // re-read on every tick for ever after.
          await markThreadLinked(thread.id)
        }
      }
    } catch (err) {
      console.error('[unified-inbox] the linking pass could not run:', err)
    }
  }

  return { people, links }
}

/**
 * Attach the records a conversation mentions.
 *
 * The pattern proposes and the owning module disposes: nothing is linked until
 * a lookup finds a record with exactly that number, so a generous pattern costs
 * a failed lookup rather than a wrong link. Everything written here is marked
 * `auto`, which is what the screen shows beside it and what makes removing it
 * one click - an automatic link that cannot be seen or undone is worse than no
 * automatic link at all.
 */
export async function autoLinkThread(
  threadId: string,
  settings: UnifiedInboxSettings,
): Promise<number> {
  if (!settings.autoLink) return 0

  const message = await counterpartyMessage(threadId)
  if (!message) return 0

  const patterns = compilePatterns({
    order: settings.orderNumberPattern,
    po: settings.poNumberPattern,
    quote: settings.quoteNumberPattern,
  })
  const candidates = extractReferences({ subject: message.subject, body: message.bodyText }, patterns)
  if (candidates.length === 0) return 0

  let linked = 0
  for (const candidate of candidates) {
    const target = await confirmReference(candidate.kind, candidate.reference)
    if (!target) continue
    if (await threadHasLink(threadId, target.moduleName, target.recordType, target.recordId)) continue
    await recordLink({
      threadId,
      personId: null,
      moduleName: target.moduleName,
      recordType: target.recordType,
      recordId: target.recordId,
      label: target.label,
      // A reference written in the subject that the owning module confirms it
      // holds is about as sure as this gets without somebody saying so.
      confidence: 90,
      linkedBy: 'auto',
    })
    linked += 1
  }
  return linked
}

/**
 * Give a person the organisation their domain implies, if they have not got one
 * and the domain means anything. Used when somebody edits a person by hand and
 * when a merge leaves the winner without one.
 */
export async function backfillOrganisation(personId: string): Promise<void> {
  const person = await getPerson(personId)
  if (!person || person.organisationId) return
  const settings = await getSettings()
  const domain = domainOf(person.primaryEmail)
  if (!domain || isPersonalDomain(domain, settings.personalDomains)) return
  const name = organisationNameFromDomain(domain, settings.personalDomains)
  if (!name) return
  const organisationId = await findOrCreateOrganisation(domain, name)
  await updatePerson(personId, { organisationId })
}

/**
 * Everything the context rail's adapters match on, for one person.
 *
 * Built here rather than in the panel so that the person page and the context panel
 * beside a conversation ask the adapters exactly the same question. The
 * addresses are the matching keys rather than what the sender wrote, because a
 * plus tag is how somebody sorts their own mail and not part of who they are.
 */
export async function buildContextQuery(personId: string): Promise<ContextQuery | null> {
  const person = await getPerson(personId)
  if (!person) return null
  const [identities, settings] = await Promise.all([listIdentities(personId), getSettings()])

  const emails = [...new Set(
    identities
      .filter((i) => i.kind === 'email')
      .map((i) => i.matchValue ?? identityKey(i.value))
      .filter((v): v is string => !!v),
  )]
  const phones = [...new Set(
    identities.filter((i) => i.kind === 'phone').map((i) => i.matchValue ?? i.value),
  )]
  const domains = [...new Set(
    emails
      .map((e) => domainOf(e))
      .filter((d): d is string => !!d && !isPersonalDomain(d, settings.personalDomains)),
  )]

  const organisation = person.organisationId ? await getOrganisation(person.organisationId) : null

  return { emails, phones, domains, organisationName: organisation?.name ?? null }
}

/** The addresses core's outbound ledger should be searched for. Same list the
 *  adapters get, so a person's timeline and their records agree about who they
 *  are. */
export async function addressesForPerson(personId: string): Promise<string[]> {
  const identities = await listIdentities(personId)
  return [...new Set(
    identities
      .filter((i) => i.kind === 'email')
      .flatMap((i) => [i.value, i.matchValue].filter((v): v is string => !!v)),
  )]
}
