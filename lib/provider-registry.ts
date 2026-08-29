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

type ExtensionPointEntry = { point: string; id: string; permission?: string }

type ProviderEntry = { moduleName: string; id: string; permission: string | null }

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
      entries.push({ moduleName: mod.name, id: entry.id, permission: entry.permission ?? null })
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
    const provider = components[entry.id]
    if (!isProvider(provider)) continue
    resolved.push({ moduleName: entry.moduleName, id: entry.id, provider })
  }
  return resolved
}

/** One provider by the module that published it, for replying to something it
 *  owns. Null when the module has gone, which is an ordinary state of affairs
 *  rather than an error - its conversations stay readable (E20). */
export async function providerForModule(
  moduleName: string,
): Promise<ResolvedConversationProvider | null> {
  const all = await allConversationProviders()
  return all.find((p) => p.moduleName === moduleName) ?? null
}

/**
 * The provider modules this reader may see conversations from.
 *
 * A channel's own permission is what governs it: somebody who may not read the
 * contact form's enquiries on the contact form's own screen must not read them
 * here either, because the hub suppressing that screen is not the same as
 * granting access to it. A provider entry with no permission is open to anybody
 * who may open this inbox at all.
 */
export async function visibleProviderModules(user: SessionUser): Promise<string[]> {
  const entries = await providerEntries()
  if (entries.length === 0) return []

  const allowed = new Set<string>()
  for (const entry of entries) {
    if (allowed.has(entry.moduleName)) continue
    if (!entry.permission || (await hasPermission(user, entry.permission))) {
      allowed.add(entry.moduleName)
    }
  }
  return [...allowed]
}

export type ProviderChannel = {
  moduleName: string
  /** What the channel is called in front of somebody, from the provider itself. */
  label: string
  /** Whether it can be answered from here at all. A channel that only reports
   *  what happened - a call log, say - is read here and answered elsewhere. */
  canReply: boolean
}

/**
 * The channels this reader may see, with the names to call them by.
 *
 * The rail, the access check and the composer all want the same three facts,
 * and resolving them once means the manifest is read once. Same permission rule
 * as `visibleProviderModules`, and the label comes from the provider rather
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
    if (seen.has(entry.moduleName)) continue
    const provider = components[entry.id]
    if (!isProvider(provider)) continue
    if (entry.permission && !(await hasPermission(user, entry.permission))) continue
    seen.add(entry.moduleName)
    channels.push({
      moduleName: entry.moduleName,
      label: typeof provider.label === 'string' && provider.label.trim() ? provider.label : entry.moduleName,
      canReply: provider.capabilities?.reply === true && typeof provider.send === 'function',
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
  moduleName: string,
): Promise<{ known: boolean; permission: string | null }> {
  const entries = await providerEntries()
  const entry = entries.find((e) => e.moduleName === moduleName)
  if (!entry) return { known: false, permission: null }
  return { known: true, permission: entry.permission ?? null }
}
