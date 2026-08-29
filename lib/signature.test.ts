import { describe, it, expect } from 'vitest'
import { cleanSignatureHtml, hasSignature, renderInboxSignature, signatureMergeVars, type SignatureSource } from './signature'

// A signature is the last thing a customer reads and the first thing that looks
// wrong when it breaks, so what is tested here is the awkward half: that pasted
// corporate markup survives being cleaned, that the fill-in tags resolve to the
// inbox rather than to whoever pressed Send, and that each of the three kinds
// produces both halves of an email - the HTML and the plain text fallback.

const INBOX: SignatureSource = {
  signatureKind: 'markdown',
  signature: null,
  signatureHtml: null,
  signaturePuck: null,
  name: 'Customer enquiries',
  address: 'hi@deskwell.co.uk',
  fromName: 'Deskwell',
}

const PASTED = `<table cellpadding="0" cellspacing="0" border="0" width="520" style="border-collapse:collapse">
  <tr>
    <td style="padding:0 18px 0 0;vertical-align:top">
      <img src="https://deskwell.co.uk/brand/signature.png" alt="Deskwell"
           onerror="this.onerror=null;this.src='x.png'" width="178" height="34">
    </td>
    <td style="border-left:3px solid #E3A857;padding:0 0 0 18px">
      <div style="font-weight:bold">{{FROM_NAME}}</div>
      <div>{{INBOX_NAME}}</div>
      <a href="mailto:{{EMAIL}}">{{EMAIL}}</a>
    </td>
  </tr>
</table>`

describe('signatureMergeVars', () => {
  it('answers as the inbox, not as whoever is typing', () => {
    const vars = signatureMergeVars(INBOX)
    expect(vars.FROM_NAME).toBe('Deskwell')
    expect(vars.INBOX_NAME).toBe('Customer enquiries')
    expect(vars.EMAIL).toBe('hi@deskwell.co.uk')
  })

  it('falls back to the inbox name when nothing is set for replies', () => {
    expect(signatureMergeVars({ ...INBOX, fromName: null }).FROM_NAME).toBe('Customer enquiries')
    expect(signatureMergeVars({ ...INBOX, fromName: '   ' }).FROM_NAME).toBe('Customer enquiries')
  })
})

describe('hasSignature', () => {
  it('asks the active kind and nothing else', () => {
    expect(hasSignature({ ...INBOX, signatureKind: 'markdown', signature: 'Kind regards' })).toBe(true)
    // The other two are still stored - switching kind must not lose them - but
    // an empty rich text box means replies go out without a signature.
    expect(hasSignature({ ...INBOX, signatureKind: 'markdown', signatureHtml: '<p>x</p>' })).toBe(false)
    expect(hasSignature({ ...INBOX, signatureKind: 'html', signatureHtml: '<p>x</p>' })).toBe(true)
    expect(hasSignature({ ...INBOX, signatureKind: 'puck', signaturePuck: { content: [] } })).toBe(false)
    expect(hasSignature({ ...INBOX, signatureKind: 'puck', signaturePuck: { content: [{ type: 'EmailText' }] } })).toBe(true)
    expect(hasSignature(null)).toBe(false)
  })
})

describe('cleanSignatureHtml', () => {
  const clean = cleanSignatureHtml(PASTED)!

  it('keeps the table layout, the inline styles, the image and the links', () => {
    for (const attr of ['cellpadding="0"', 'cellspacing="0"', 'width="520"', 'height="34"']) {
      expect(clean, attr).toContain(attr)
    }
    expect(clean).toContain('border-left:3px solid #E3A857')
    expect(clean).toContain('src="https://deskwell.co.uk/brand/signature.png"')
    expect(clean).toContain('href="mailto:{{EMAIL}}"')
  })

  it('strips anything that runs on its own', () => {
    expect(clean).not.toContain('onerror')
    expect(clean).not.toMatch(/on[a-z]+=/i)
    expect(cleanSignatureHtml('<div>hi<script>alert(1)</script></div>')).not.toContain('script')
  })

  it('stores nothing rather than an empty string', () => {
    expect(cleanSignatureHtml('   ')).toBeNull()
    expect(cleanSignatureHtml(null)).toBeNull()
    expect(cleanSignatureHtml('<script>alert(1)</script>')).toBeNull()
  })
})

describe('renderInboxSignature', () => {
  it('renders the rich text kind as HTML and as readable plain text', async () => {
    const out = await renderInboxSignature({
      ...INBOX,
      signature: 'Kind regards,\nThe Sales Team\n\n**Deskwell**',
    })
    expect(out?.html).toContain('<strong>Deskwell</strong>')
    expect(out?.text).toContain('Kind regards,')
    expect(out?.text).toContain('Deskwell')
    expect(out?.text).not.toContain('**')
  })

  it('fills the tags in on the pasted kind, and escapes what it fills', async () => {
    const out = await renderInboxSignature({
      ...INBOX,
      signatureKind: 'html',
      signatureHtml: cleanSignatureHtml(PASTED),
      fromName: 'Deskwell & Co',
    })
    expect(out?.html).toContain('href="mailto:hi@deskwell.co.uk"')
    expect(out?.html).toContain('Customer enquiries')
    expect(out?.html).toContain('Deskwell &amp; Co')
    expect(out?.html).not.toContain('{{')
    expect(out?.text).toContain('hi@deskwell.co.uk')
  })

  it('renders the block-built kind without reading the site twice', async () => {
    const out = await renderInboxSignature(
      {
        ...INBOX,
        signatureKind: 'puck',
        signaturePuck: {
          root: { props: {} },
          content: [{ type: 'EmailText', props: { html: '{{FROM_NAME}} - {{siteName}}' } }],
        },
      },
      // Passed in rather than read: the send path already has both in hand.
      {
        palette: { colours: {}, fonts: {} },
        site: { siteName: 'Deskwell', siteUrl: 'https://deskwell.co.uk', logoUrl: '', year: '2026' },
      },
    )
    expect(out?.html).toContain('Deskwell - Deskwell')
    expect(out?.html).toContain('<table')
    expect(out?.text).toContain('Deskwell')
  })

  it('is nothing at all when the active kind is empty', async () => {
    expect(await renderInboxSignature({ ...INBOX, signature: '   ' })).toBeNull()
    expect(await renderInboxSignature({ ...INBOX, signatureKind: 'html', signatureHtml: null })).toBeNull()
    expect(await renderInboxSignature(null)).toBeNull()
  })
})
