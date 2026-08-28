import { describe, it, expect } from 'vitest'
import { buildMessageDocument, messageDocumentCsp, openLinksInNewTab } from './message-document'

describe('openLinksInNewTab', () => {
  it('opens links away from the sandboxed frame, telling the far end nothing', () => {
    const out = openLinksInNewTab('<a href="https://example.com">click</a>')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
  })

  it('leaves an anchor with no href alone', () => {
    expect(openLinksInNewTab('<a name="top"></a>')).toBe('<a name="top"></a>')
  })

  it('does not overrule a target the sanitiser already allowed through', () => {
    const out = openLinksInNewTab('<a href="https://x.example" target="_self">x</a>')
    expect(out).toContain('target="_self"')
    expect(out).not.toContain('target="_blank"')
  })
})

describe('buildMessageDocument', () => {
  it('folds the quoted history behind something the reader can open', () => {
    const doc = buildMessageDocument({
      html: '<p>Yes, fine.</p><blockquote>the whole of last month</blockquote>',
      nonce: 'abc',
    })
    expect(doc).toContain('<details class="uin-quote">')
    expect(doc).toContain('Show the earlier messages')
    // The history is still there, folded rather than lost.
    expect(doc).toContain('the whole of last month')
  })

  it('leaves a message with no quoted history unfolded', () => {
    const doc = buildMessageDocument({ html: '<p>Just checking in.</p>', nonce: 'abc' })
    expect(doc).not.toContain('<details class="uin-quote">')
  })

  it('carries the nonce on the one script it has', () => {
    const doc = buildMessageDocument({ html: '<p>hi</p>', nonce: 'nonce-value' })
    const scripts = doc.match(/<script/g) ?? []
    expect(scripts).toHaveLength(1)
    expect(doc).toContain('<script nonce="nonce-value">')
  })
})

describe('messageDocumentCsp', () => {
  it('lets the frame load nothing but its own pictures and its own script', () => {
    const csp = messageDocumentCsp('abc')
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("img-src 'self' data:")
    expect(csp).toContain("script-src 'nonce-abc'")
    expect(csp).toContain("frame-ancestors 'self'")
    // Nothing in a stranger's email gets to reach out anywhere.
    expect(csp).not.toContain('connect-src')
    expect(csp).toContain("form-action 'none'")
  })
})
