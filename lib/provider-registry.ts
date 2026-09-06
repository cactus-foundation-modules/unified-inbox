import { prisma } from '@/lib/db/prisma'
import { hasPermission } from '@/lib/permissions/check'
import { INSTALLED_MODULE_WHERE } from '@/lib/modules/live-status'
import { moduleExtensionPointComponents } from '@/lib/modules/extension-points'
import { CONVERSATION_PROVIDER_POINT } from '@/lib/conversations/providers'
import type { ConversationProvider, ResolvedConversationProvider } from '@/lib/conversations/types'
import type { SessionUser } from '@/lib/auth/session'

// Which channels this site has, besides email.
//
// Core resolves conversation providers for a PERSON, because core's own All tab
// is a screen somebody is looking at. This hub needs the same list from two
// different angles, and neither is core's:
//
//   The tick collects on nobody's behalf. It runs from a cron request with no
//   session at all, and it must read every channel the site has - otherwise
//   whose permissions decide what gets collected? Nobody's, is the only sane
//   answer, and the reading screen is where access is decided.
//
//   The screen needs the module NAMES a person may see, not the providers
//   themselves - the conversations are already in our own tables by then, and
//   the question is which of them belong to this reader.
//
// So the manifest is read here rather than borrowed. It is the same read core
// does, deliberately kept to the same rules: installed modules only, the
// generated registry decides what actually exists, and anything that is not a
// provider is skipped rather than thrown over.
//
// ---------------------------------------------------------------------------
// A CHANNEL IS A PROVIDER, NOT A MODULE.
//
// One module may publish more than one. The telephony module publishes two -
// calls and texts under one, WhatsApp under another - because they are not one
// channel to the person answering them: WhatsApp has its own rules about when
// you may write and its own approved wording, and mixing it into the answerphone
// would be wrong on the screen and wrong in the tables.
//
// So a channel is identified by the manifest ENTRY id, which core already
// requires to be unique across every module (the generated registry is keyed on
// it). The database column is still called "provider_module", because renaming
// a column on a live site to make a comment unnecessary is a poor trade - and
// because for a module publishing ONE provider the two are the same string by
// convention, which is why every conversation collected before this existed is
// still addressed by exactly the value it was stored under.
// ---------------------------------------------------------------------------

type ExtensionPointEntry = { point: string; id: string; permission?: string }

/** One published channel: which module it came from, the key everything else
 *  addresses it by, and the permission it answers to. */
type ProviderEntry = { moduleName: string; key: string; permission: string | null }

function isProvider(value: unknown): value is ConversationProvider {
  if (!value || typeof value !== 'object') return false
  const p = value as Partial<ConversationProvider>
  return typeof p.list === 'function' && typeof p.thread === 'function' && typeof p.channel === 'string'
}

async function providerEntries(): Promise<ProviderEntry[]> {
  const modules = await prisma.module.findMany({
    where: { ...INSTALLED_MODULE_WHERE },
    select: { name: true, manifest: true },
    orderBy: { name: 'asc' },
  })

  const entries: ProviderEntry[] = []
  for (const mod of modules) {
    const manifest = mod.manifest as { extensionPoints?: ExtensionPointEntry[] } | null
    for (const entry of manifest?.extensionPoints ?? []) {
      if (entry.point !== CONVERSATION_PROVIDER_POINT) continue
      entries.push({ moduleName: mod.name, key: entry.id, permission: entry.permission ?? null })
    }
  }
  return entries
}

/**
 * Every provider on the site, whoever is asking.
 *
 * Used by the collection tick, which has no session. A module whose manifest
 * names an entry the generated registry has not caught up with yet is skipped
 * silently - that is a module installed one build before its code shipped, and
 * it will be here next time.
 */
export async function allConversationProviders(): Promise<ResolvedConversationProvider[]> {
  const components = moduleExtensionPointComponents[CONVERSATION_PROVIDER_POINT] ?? {}
  if (Object.keys(components).length === 0) return []

  const resolved: ResolvedConversationProvider[] = []
  for (const entry of await providerEntries()) {
    const provider = components[entry.key]
    if (!isProvider(provider)) continue
    resolved.push({ moduleName: entry.moduleName, id: entry.key, provider })
  }
  return resolved
}

/** One provider by the channel key its conversations are stored under, for
 *  replying to something it owns. Null when the module has gone, which is an
 *  ordinary state of affairs rather than an error - its conversations stay
 *  readable (E20). */
export async function providerForKey(
  channelKey: string,
): Promise<ResolvedConversationProvider | null> {
  const all = await allConversationProviders()
  return all.find((p) => p.id === channelKey) ?? null
}

/**
 * The channel keys this reader may see conversations from.
 *
 * A channel's own permission is what governs it: somebody who may not read the
 * contact form's enquiries on the contact form's own screen must not read them
 * here either, because the hub suppressing that screen is not the same as
 * granting access to it. A provider entry with no permission is open to anybody
 * who may open this inbox at all.
 */
export async function visibleChannelKeys(user: SessionUser): Promise<string[]> {
  const entries = await providerEntries()
  if (entries.length === 0) return []

  const allowed = new Set<string>()
  for (const entry of entries) {
    if (allowed.has(entry.key)) continue
    if (!entry.permission || (await hasPermission(user, entry.permission))) {
      allowed.add(entry.key)
    }
  }
  return [...allowed]
}

export type ProviderChannel = {
  /** The manifest entry id: what this channel's conversations are stored under
   *  and what every link, tab and filter addresses it by. */
  key: string
  /** Which module publishes it. Not the identity - one module may publish
   *  several - and used only for saying where a channel came from. */
  moduleName: string
  /** What the channel is called in front of somebody, from the provider itself. */
  label: string
  /** Whether it can be answered from here at all. A channel that only reports
   *  what happened - a call log, say - is read here and answered elsewhere. */
  canReply: boolean
  /** Whether a single message can be got rid of at the far end as well as here.
   *  A voicemail can; a call that happened cannot be made not to have happened. */
  canDelete: boolean
  /** Whether the other party can be refused from here on. Telephony's sense of
   *  the word: what already happened stays, this is about what happens next. */
  canBlock: boolean
}

/**
 * The channels this reader may see, with the names to call them by.
 *
 * The tabs, the access check and the composer all want the same three facts,
 * and resolving them once means the manifest is read once. Same permission rule
 * as `visibleChannelKeys`, and the label comes from the provider rather
 * than from a list kept here, so a channel is called whatever its own module
 * calls it.
 */
export async function visibleProviderChannels(user: SessionUser): Promise<ProviderChannel[]> {
  const entries = await providerEntries()
  if (entries.length === 0) return []
  const components = moduleExtensionPointComponents[CONVERSATION_PROVIDER_POINT] ?? {}

  const channels: ProviderChannel[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.key)) continue
    const provider = components[entry.key]
    if (!isProvider(provider)) continue
    if (entry.permission && !(await hasPermission(user, entry.permission))) continue
    seen.add(entry.key)
    channels.push({
      key: entry.key,
      moduleName: entry.moduleName,
      label: typeof provider.label === 'string' && provider.label.trim() ? provider.label : entry.key,
      // Flag AND method, all three of them, which is the same test canReply has
      // always used. A capability flag with nothing behind it is a button that
      // fails when pressed, and a method with the flag off is a channel that
      // never asked to offer it.
      canReply: provider.capabilities?.reply === true && typeof provider.send === 'function',
      canDelete: provider.capabilities?.delete === true && typeof provider.deleteMessage === 'function',
      canBlock: provider.capabilities?.block === true && typeof provider.blockParticipant === 'function',
    })
  }
  return channels
}

/**
 * Every channel on the site and what it is called, whoever is asking.
 *
 * The settings screen asks this rather than `visibleProviderChannels`: whether
 * a channel appears in the rail is one decision for the whole site, so the list
 * to make it from has to be the whole site's. It is gated on
 * `unifiedinbox.manage` where it is used, and knowing that a site has a contact
 * form is a long way from reading what anybody wrote in one.
 */
export async function allProviderChannels(): Promise<Array<{ key: string; label: string }>> {
  const entries = await providerEntries()
  if (entries.length === 0) return []
  const components = moduleExtensionPointComponents[CONVERSATION_PROVIDER_POINT] ?? {}

  const channels: Array<{ key: string; label: string }> = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.key)) continue
    const provider = components[entry.key]
    if (!isProvider(provider)) continue
    seen.add(entry.key)
    channels.push({
      key: entry.key,
      label: typeof provider.label === 'string' && provider.label.trim() ? provider.label : entry.key,
    })
  }
  return channels
}

/**
 * The permission one channel's conversations answer to, if it declares one.
 *
 * `known: false` means no installed module publishes that channel any more -
 * its conversations stay readable in the list (E20) but nobody acts on them,
 * because there is nothing left to ask about who may.
 */
export async function providerPermissionFor(
  channelKey: string,
): Promise<{ known: boolean; permission: string | null }> {
  const entries = await providerEntries()
  const entry = entries.find((e) => e.key === channelKey)
  if (!entry) return { known: false, permission: null }
  return { known: true, permission: entry.permission ?? null }
}
