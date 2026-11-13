import { describe, it, expect } from 'vitest'
import { designWords, isEmptyDesign, renderCampaignDesign, sameDesign, type CampaignDesign } from './design'
import { personalise, tagsWithoutFallback, usesUnsubscribeTag } from './personalise'

const person = {
  firstName: 'Ann <script>',
  lastName: 'Smith & Co',
  displayName: null,
  organisationName: null,
  address: 'ann@example.com',
  unsubscribeUrl: 'https://shop.example/api/m/unified-inbox/unsubscribe?e=ann%40example.com&t=abc',
}

const render = (design: CampaignDesign) => renderCampaignDesign({
  design, person, vars: { siteName: 'Shop' }, colours: {}, fonts: {},
})

describe('renderCampaignDesign', () => {
  it('escapes a name going into a heading, which the block escapes itself', () => {
    const html = render({ content: [{ type: 'EmailHeading', props: { text: 'Hello {{first_name|there}}' } }] })
    expect(html).toContain('Hello Ann &lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('escapes a name going into a block that takes raw HTML', () => {
    const html = render({ content: [{ type: 'EmailText', props: { html: '<p>Dear {{first_name}} {{last_name}}</p>' } }] })
    expect(html).toContain('<p>Dear Ann &lt;script&gt; Smith &amp; Co</p>')
  })

  it('puts their own unsubscribe link behind a button', () => {
    const html = render({ content: [{ type: 'EmailButton', props: { label: 'Unsubscribe', href: '{{unsubscribe_url}}' } }] })
    expect(html).toContain('href="https://shop.example/api/m/unified-inbox/unsubscribe?e=ann%40example.com&amp;t=abc"')
  })

  it('still fills the site’s own tags', () => {
    const html = render({ content: [{ type: 'EmailText', props: { html: 'From {{siteName}}' } }] })
    expect(html).toContain('From Shop')
  })

  it('falls back when there is nothing to fill a tag with', () => {
    const html = renderCampaignDesign({
      design: { content: [{ type: 'EmailHeading', props: { text: 'Hi {{company|friend}}' } }] },
      person, vars: {}, colours: {}, fonts: {},
    })
    expect(html).toContain('Hi friend')
  })
})

describe('designWords', () => {
  it('reads the words out with the tags left as typed, for the checks', () => {
    const words = designWords({
      content: [
        { type: 'EmailHeading', props: { text: 'Hi {{first_name|there}}' } },
        { type: 'EmailImage', props: { src: 'https://x/y.png', alt: 'chair' } },
        { type: 'EmailText', props: { html: '<p>New <b>chairs</b></p><p>{{firstname}}</p>' } },
      ],
    })
    expect(words).toContain('Hi {{first_name|there}}')
    expect(words).toContain('New chairs')
    expect(words).toContain('{{firstname}}')
    expect(words).not.toContain('https://x/y.png')
  })

  it('says an empty design is empty', () => {
    expect(isEmptyDesign({ content: [] })).toBe(true)
    expect(isEmptyDesign(null)).toBe(true)
    expect(designWords({ content: [] })).toBe('')
  })
})

describe('sameDesign', () => {
  it('ignores the order the keys came back in', () => {
    expect(sameDesign(
      { content: [{ type: 'EmailText', props: { html: 'a', fontSize: 16 } }] },
      { content: [{ props: { fontSize: 16, html: 'a' }, type: 'EmailText' }] },
    )).toBe(true)
    expect(sameDesign({ content: [] }, null)).toBe(false)
  })
})

describe('the unsubscribe tag', () => {
  it('is filled with their own link when sending, and never warned about for lacking a fallback', () => {
    expect(personalise('Stop: {{unsubscribe_url}}', person)).toBe(`Stop: ${person.unsubscribeUrl}`)
    expect(tagsWithoutFallback('{{unsubscribe_url}}')).toEqual([])
    expect(usesUnsubscribeTag('x {{ unsubscribe_url }} y')).toBe(true)
  })
})
