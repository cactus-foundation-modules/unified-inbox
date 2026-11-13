import { z } from 'zod'
import { renderEmailSignatureHtml, type EmailSignatureData } from '@/lib/email/signature'
import { replaceTags } from './personalise'
import type { RecipientNames } from './types'

// ---------------------------------------------------------------------------
// A campaign message built in the designer rather than typed in the box.
//
// The designer is core's own email blocks - the same ones the site's email
// designs and the block-built signatures use (lib/puck/email-config.tsx) -
// without the "message goes here" block, because this IS the message. So it is
// stored as that editor's document and rendered by core's own renderer, which
// is what keeps the canvas and the inbox in agreement: nothing here draws a
// single block itself.
//
// PERSONALISING IT is the only part that is this module's. Core's blocks fill
// their own {{tags}} (siteName, year) and escape the result to suit the field -
// a heading's text is escaped, a text block's HTML is not, a link is checked and
// then escaped. A customer's name has to go through exactly that, so each of
// the campaign's own tags is swapped for a placeholder before the render and
// handed to the renderer as one of ITS values. The renderer then treats a name
// the way it treats the site's name, field by field. The one change made here:
// a value going into a field the renderer does not escape (raw HTML) is escaped
// first, because a name typed at the checkout is not HTML anybody wrote.
//
// No database, no server-only imports: the editor imports `designWords` to keep
// the plain-text reading in step as somebody builds.
// ---------------------------------------------------------------------------

export type CampaignDesign = EmailSignatureData

/** The editor's document, as far as anything here relies on it. Everything else
 *  in it passes through untouched - it is the editor's to define - but the
 *  overall size is held down, because this goes in a column and out in every
 *  single email. */
const DesignItem = z.object({
  type: z.string().min(1).max(64),
  props: z.record(z.string(), z.unknown()).optional(),
}).passthrough()

export const CampaignDesignBody = z.object({
  root: z.object({ props: z.record(z.string(), z.unknown()).optional() }).passthrough().optional(),
  content: z.array(DesignItem).max(200),
}).passthrough().refine(
  (value) => JSON.stringify(value).length <= 500_000,
  'That design is too large to send. Take out some of the blocks.',
)

/** Fields whose text the block renderer interpolates. The rest (colours,
 *  sizes, alignment, alt text) are filled in directly. */
const INTERPOLATED = new Set(['text', 'label', 'href', 'src', 'html', 'leftHtml', 'rightHtml'])

/** Of those, the ones it puts in as raw HTML without escaping the value. */
const RAW_HTML = new Set(['html', 'leftHtml', 'rightHtml'])

/** The site's own tags, which the blocks fill for every email the site sends -
 *  the small print's "(c) {{year}} {{siteName}}" above all. Left for the blocks
 *  rather than treated as a campaign tag nobody recognises. */
export const SITE_TAGS: ReadonlySet<string> = new Set(['siteName', 'siteUrl', 'logoUrl', 'year'])
const isSiteTag = (name: string) => SITE_TAGS.has(name)

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Whether there is anything in it at all. */
export function isEmptyDesign(design: CampaignDesign | null | undefined): boolean {
  return !design || !Array.isArray(design.content) || design.content.length === 0
}

/**
 * The words in it, as plain text, tags left exactly as typed.
 *
 * What `body` holds for a designed message. Every check that reads the message
 * - an empty one, a tag that is not a tag, a tag with nothing to fall back on -
 * reads this, and so works on a design without knowing it is one.
 */
export function designWords(design: CampaignDesign | null | undefined): string {
  if (isEmptyDesign(design)) return ''
  const parts: string[] = []
  const take = (value: unknown, key: string) => {
    if (typeof value !== 'string' || !INTERPOLATED.has(key) || key === 'src') return
    const text = RAW_HTML.has(key)
      ? value.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      : value
    // The site's own tags are the blocks' business and are always filled, so
    // the checks that read these words should not see them as strangers.
    const trimmed = text.replace(/\{\{\s*(siteName|siteUrl|logoUrl|year)\s*\}\}/g, '').trim()
    if (trimmed) parts.push(trimmed)
  }
  for (const item of design!.content ?? []) {
    const props = (item?.props ?? {}) as Record<string, unknown>
    for (const [key, value] of Object.entries(props)) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry && typeof entry === 'object') {
            for (const [k, v] of Object.entries(entry as Record<string, unknown>)) take(v, k)
          }
        }
      } else {
        take(value, key)
      }
    }
  }
  return parts.join('\n\n')
}

/**
 * The design with this person's details in it, rendered to the HTML that goes
 * into the email - or '' when there is nothing to render.
 *
 * `vars` are the site's own values the blocks already understand (siteName,
 * siteUrl, logoUrl, year); `colours` and `fonts` the site's palette, resolved
 * on the server.
 */
export function renderCampaignDesign(input: {
  design: CampaignDesign
  person: RecipientNames
  vars: Record<string, string>
  colours: Record<string, string>
  fonts: Record<string, string>
}): string {
  const values: Record<string, string> = {}
  let next = 0
  // A name for each placeholder that cannot collide with anything the site's
  // own blocks fill: theirs are camelCase words, these are not.
  const placeholder = (value: string, raw: boolean): string => {
    const key = `uin_tag_${next++}`
    values[key] = raw ? escapeHtml(value) : value
    return `{{${key}}}`
  }

  const fill = (value: unknown, key: string): unknown => {
    if (typeof value !== 'string') return value
    if (INTERPOLATED.has(key)) {
      return replaceTags(value, input.person, (filled) => placeholder(filled, RAW_HTML.has(key)), isSiteTag)
    }
    return replaceTags(value, input.person, (filled) => filled, isSiteTag)
  }

  const content = (input.design.content ?? []).map((item) => {
    const props = (item?.props ?? {}) as Record<string, unknown>
    const filled: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(props)) {
      filled[key] = Array.isArray(value)
        ? value.map((entry) => {
            if (!entry || typeof entry !== 'object') return entry
            const out: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(entry as Record<string, unknown>)) out[k] = fill(v, k)
            return out
          })
        : fill(value, key)
    }
    return { ...item, props: filled }
  })

  return renderEmailSignatureHtml({
    data: { ...input.design, content },
    vars: { ...input.vars, ...values },
    colours: input.colours,
    fonts: input.fonts,
  })
}

/** The same JSON whatever order its keys came back in - Postgres hands a JSONB
 *  document back with its keys reordered, and "has the first message changed"
 *  must not answer yes because of that. */
export function sameDesign(a: CampaignDesign | null | undefined, b: CampaignDesign | null | undefined): boolean {
  return stable(a ?? null) === stable(b ?? null)
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
