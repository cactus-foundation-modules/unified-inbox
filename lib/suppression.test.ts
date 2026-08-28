import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  conversationConsumerModuleNames,
  conversationProviderModuleNames,
} from '@/lib/conversations/providers'

// What core will actually do with the manifests as they now stand.
//
// Core's own tests prove the suppression RULE against stand-in modules. This
// proves the WIRING: that the real manifests on disk say what the rule needs
// them to say, so that installing this hub hides the contact form's and live
// chat's own inbox tabs and core's All tab, and removing it brings all three
// back.
//
// It matters because every part of that is a string in a JSON file. A renamed
// point, a missing flag or a forgotten permission does not fail a build - it
// quietly leaves a colleague with two places to read the same enquiry, or with
// none at all.

const MODULES = join(process.cwd(), 'modules')

function manifest(name: string): { name: string; manifest: unknown } {
  return {
    name,
    manifest: JSON.parse(readFileSync(join(MODULES, name, 'cactus.module.json'), 'utf8')),
  }
}

type Entry = { point: string; id: string; permission?: string; serverOnly?: boolean }
function entries(mod: { manifest: unknown }): Entry[] {
  return ((mod.manifest as { extensionPoints?: Entry[] }).extensionPoints ?? [])
}

const CONTACT_FORM = manifest('contact-form')
const LIVE_CHAT = manifest('live-chat')
const TWILIO = manifest('twilio')
const HUB = manifest('unified-inbox')
const ALL = [CONTACT_FORM, LIVE_CHAT, TWILIO, HUB]

describe('the channels publish what core is looking for', () => {
  it.each([
    ['contact-form', CONTACT_FORM],
    ['live-chat', LIVE_CHAT],
    ['twilio', TWILIO],
  ])('%s publishes a conversation provider', (_name, mod) => {
    const provider = entries(mod).find((e) => e.point === 'core.conversation-provider')
    expect(provider).toBeDefined()
    // Without this the provider lands in the client-reachable map and drags a
    // mail library, a telephony SDK or a chat client into a public page's graph.
    expect(provider!.serverOnly).toBe(true)
    // The channel's own permission is what governs who may read it, here and on
    // its own screen alike.
    expect(provider!.permission).toBeTruthy()
  })

  it('is found by the resolver core suppresses with', () => {
    expect([...conversationProviderModuleNames(ALL)].sort()).toEqual([
      'contact-form',
      'live-chat',
      'twilio',
    ])
  })
})

describe('what happens when the hub is installed', () => {
  it('is declared as a consumer, which is what stands core down', () => {
    expect([...conversationConsumerModuleNames(ALL)]).toEqual(['unified-inbox'])
  })

  it('takes the contact form’s and live chat’s own inbox tabs with it', () => {
    const providers = conversationProviderModuleNames(ALL)
    const withTabs = ALL.filter((m) => entries(m).some((e) => e.point === 'core.inbox-tabs'))
    const suppressed = withTabs.filter((m) => providers.has(m.name)).map((m) => m.name)
    expect(suppressed.sort()).toEqual(['contact-form', 'live-chat'])
  })

  it('leaves the phone alone, because it never had an inbox tab to take', () => {
    expect(entries(TWILIO).some((e) => e.point === 'core.inbox-tabs')).toBe(false)
  })

  it('keeps a tab of its own, or suppression would leave nowhere to read them', () => {
    expect(entries(HUB).some((e) => e.point === 'core.inbox-tabs')).toBe(true)
    expect(conversationProviderModuleNames([HUB]).size).toBe(0)
  })
})

describe('what happens when the hub is not installed', () => {
  it('nothing is suppressed and core presents the merged view itself', () => {
    const withoutHub = [CONTACT_FORM, LIVE_CHAT, TWILIO]
    expect(conversationConsumerModuleNames(withoutHub).size).toBe(0)
    // Two or more providers is what earns core's own All tab - which is what
    // makes each of these providers worth having on a site that never installs
    // this module.
    expect(conversationProviderModuleNames(withoutHub).size).toBeGreaterThanOrEqual(2)
  })
})

describe('every channel is answerable on a core that carries the seam', () => {
  it.each([
    ['contact-form', CONTACT_FORM],
    ['live-chat', LIVE_CHAT],
    ['twilio', TWILIO],
  ])('%s asks for a core new enough to have it', (_name, mod) => {
    const required = (mod.manifest as { requiresCoreVersion: string }).requiresCoreVersion
    const [major, minor, patch] = required.split('.').map(Number)
    expect(major).toBe(0)
    expect(minor).toBe(5)
    // 0.5.1383 is the release the conversation seam shipped in.
    expect(patch).toBeGreaterThanOrEqual(1383)
  })
})
