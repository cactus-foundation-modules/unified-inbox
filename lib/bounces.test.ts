import { describe, it, expect } from 'vitest'
import { readBounce } from './bounces'

// Reading a delivery report back to the message it is about. The shapes below
// are the ones mail servers actually send: a standard RFC 3464 report with the
// original's headers quoted, a delay warning, a success report nobody wanted,
// and a plain-text bounce with only a References header to go on.

const STATUS_FAILED = [
  'Reporting-MTA: dns; p00-icloudmta-asmtp-us-west-1a-100-percent-1.p00-icloudmta-asmtp-vip.icloud-mail-production.svc.kube.us-west-1a.k8s.cloud.apple.com',
  '',
  'Final-Recipient: rfc822; nobody@customer.example',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 <nobody@customer.example>: Recipient address rejected: User unknown',
].join('\n')

const ORIGINAL_HEADERS = [
  'From: Deskwell <sales@deskwell.co.uk>',
  'To: nobody@customer.example',
  'Subject: Your quote',
  'Message-ID: <uin-abc123@deskwell.co.uk>',
  'In-Reply-To: <their-first@customer.example>',
].join('\n')

describe('reading a bounce', () => {
  it('finds the original in the quoted headers and calls a 5.x.x failure hard', () => {
    const reading = readBounce({
      contentType: 'multipart/report; report-type=delivery-status; boundary="x"',
      parts: ['This message could not be delivered.', STATUS_FAILED, ORIGINAL_HEADERS],
      inReplyTo: null,
      references: [],
      subject: 'Undelivered Mail Returned to Sender',
    })
    expect(reading).not.toBeNull()
    expect(reading!.kind).toBe('hard')
    expect(reading!.originalMessageIds).toEqual(['uin-abc123@deskwell.co.uk'])
    expect(reading!.detail).toContain('That address does not exist at their end.')
    expect(reading!.detail).toContain('User unknown')
    // The In-Reply-To of the ORIGINAL is not what the bounce is about.
    expect(reading!.originalMessageIds).not.toContain('their-first@customer.example')
  })

  it('calls a delay soft', () => {
    const reading = readBounce({
      contentType: 'multipart/report; report-type=delivery-status',
      parts: ['Action: delayed\nStatus: 4.4.7', ORIGINAL_HEADERS],
      inReplyTo: null,
      references: [],
      subject: 'Delivery Status Notification (Delay)',
    })
    expect(reading?.kind).toBe('soft')
    expect(reading?.detail).toBe('Their mail server has not taken it yet and is still trying.')
  })

  it('ignores a report that says the message arrived', () => {
    expect(readBounce({
      contentType: 'multipart/report; report-type=delivery-status',
      parts: ['Action: delivered\nStatus: 2.0.0', ORIGINAL_HEADERS],
      inReplyTo: null, references: [], subject: 'Delivered',
    })).toBeNull()
  })

  it('falls back to the report\'s own References', () => {
    const reading = readBounce({
      contentType: 'text/plain',
      parts: ['Sorry, we were unable to deliver your message.'],
      inReplyTo: null,
      references: ['<uin-xyz@deskwell.co.uk>'],
      subject: 'failure notice',
    })
    expect(reading).toEqual({
      originalMessageIds: ['uin-xyz@deskwell.co.uk'],
      kind: 'hard',
      detail: 'Their mail server would not take it.',
    })
  })

  it('gives up on a report that names nothing', () => {
    expect(readBounce({ contentType: 'text/plain', parts: ['Mail delivery failed'], inReplyTo: null, references: [], subject: 'x' })).toBeNull()
  })
})
