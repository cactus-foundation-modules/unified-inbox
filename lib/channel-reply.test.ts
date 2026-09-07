import { describe, it, expect } from 'vitest'
import {
  CHANNEL_REPLY_STYLE,
  EMAIL_REPLY_STYLE,
  replyDestination,
  replyStyleFor,
} from './channel-reply'

describe('replyStyleFor', () => {
  it('gives an email conversation the whole box', () => {
    expect(replyStyleFor({ providerModule: null })).toEqual(EMAIL_REPLY_STYLE)
  })

  it('gives a conversation another module owns the channel style', () => {
    expect(replyStyleFor({ providerModule: 'twilio-whatsapp' })).toEqual(CHANNEL_REPLY_STYLE)
  })

  // The one that was broken: nothing on a WhatsApp conversation is addressed by
  // hand, so a blank To box must not be what stops the reply going.
  it('never asks a channel conversation for an address', () => {
    expect(replyStyleFor({ providerModule: 'twilio-whatsapp' }).addressed).toBe(false)
    expect(replyStyleFor({ providerModule: 'twilio' }).addressed).toBe(false)
    expect(replyStyleFor({ providerModule: 'live-chat' }).addressed).toBe(false)
  })

  it('offers no files and no forward on a channel', () => {
    const style = replyStyleFor({ providerModule: 'twilio-whatsapp' })
    expect(style.richText).toBe(false)
    expect(style.attachments).toBe(false)
    expect(style.forward).toBe(false)
  })

  it('offers no emphasis at all on a channel that declared none', () => {
    expect(replyStyleFor({ providerModule: 'twilio' }).styles).toEqual([])
    expect(replyStyleFor({ providerModule: 'twilio' }, null).styles).toEqual([])
    expect(replyStyleFor({ providerModule: 'twilio' }, {}).styles).toEqual([])
  })

  // WhatsApp DOES have emphasis - it writes it with a marker rather than a tag
  // - so the buttons for it are offered rather than the whole strip hidden.
  it('offers exactly what the channel declared', () => {
    const style = replyStyleFor(
      { providerModule: 'twilio-whatsapp' },
      { bold: '*', italic: '_', strikethrough: '~' },
    )
    expect(style.styles).toEqual(['bold', 'italic', 'strikethrough'])
    // Still a channel in every other respect.
    expect(style.addressed).toBe(false)
    expect(style.richText).toBe(false)
    expect(style.attachments).toBe(false)
    expect(style.forward).toBe(false)
  })

  it('draws them in one order whatever order they were declared in', () => {
    expect(replyStyleFor({ providerModule: 'x' }, { italic: '_', bold: '*' }).styles)
      .toEqual(['bold', 'italic'])
  })

  it('never lets a channel’s declaration reach an email', () => {
    expect(replyStyleFor({ providerModule: null }, { bold: '*' })).toEqual(EMAIL_REPLY_STYLE)
  })
})

describe('replyDestination', () => {
  it('names them and the channel', () => {
    expect(replyDestination({ channelLabel: 'WhatsApp', party: '+447700900123', name: 'Sam Reid' }))
      .toBe('This goes back to Sam Reid (+447700900123) on WhatsApp.')
  })

  it('falls back to what the conversation is keyed on', () => {
    expect(replyDestination({ channelLabel: 'WhatsApp', party: '+447700900123', name: null }))
      .toBe('This goes back to +447700900123 on WhatsApp.')
  })

  it('does not say the same thing twice', () => {
    expect(replyDestination({ channelLabel: 'Text', party: '+447700900123', name: '+447700900123' }))
      .toBe('This goes back to +447700900123 on Text.')
  })

  it('still names the channel when there is nobody to name', () => {
    expect(replyDestination({ channelLabel: 'Live chat', party: null, name: null }))
      .toBe('This goes back on Live chat.')
    expect(replyDestination({ channelLabel: 'Live chat', party: '  ', name: '  ' }))
      .toBe('This goes back on Live chat.')
  })
})
