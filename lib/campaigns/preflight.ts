import { resolveTxt } from 'node:dns/promises'

// ---------------------------------------------------------------------------
// What to check before three hundred emails a day start leaving.
//
// Two kinds of finding, and the difference is whether it can be pressed past.
//
// A PROBLEM stops the start button. Something is missing that would make the
// campaign fail or make it break a rule - no address to send from, no
// unsubscribe link possible, a body full of tags that are not tags.
//
// A WARNING is said out loud and can be accepted. The domain's mail records
// being untidy is the big one: it does not stop anything, and it is the single
// best predictor of a campaign that "sent fine" and arrived nowhere.
//
// The DNS half is done here rather than trusted to the owner's memory because
// the answer takes two hundred milliseconds and the alternative is finding out
// from a customer three weeks later that nothing has been getting through.
// ---------------------------------------------------------------------------

export type PreflightFinding = {
  level: 'problem' | 'warning'
  /** One sentence, in the words somebody who does not run a mail server uses. */
  message: string
}

/** Whether a domain publishes an SPF record, and a DMARC one.
 *
 *  Never throws and never takes long: a DNS server that is not answering is a
 *  warning that says so, not a campaign that cannot be started. */
export async function checkDomainRecords(domain: string): Promise<PreflightFinding[]> {
  const findings: PreflightFinding[] = []

  const spf = await lookup(domain)
  if (spf.ok) {
    const hasSpf = spf.records.some((record) => record.toLowerCase().startsWith('v=spf1'))
    if (!hasSpf) {
      findings.push({
        level: 'warning',
        message: `${domain} has no SPF record, which is one of the things mail providers check before they trust an email. `
          + 'Whoever looks after your domain name can add one in a few minutes, and it makes a real difference to whether this lands in the inbox.',
      })
    }
  }

  const dmarc = await lookup(`_dmarc.${domain}`)
  if (dmarc.ok) {
    const hasDmarc = dmarc.records.some((record) => record.toLowerCase().startsWith('v=dmarc1'))
    if (!hasDmarc) {
      findings.push({
        level: 'warning',
        message: `${domain} has no DMARC record. Gmail and Outlook both now expect one from anybody sending in any quantity, `
          + 'and without it a good share of this campaign will go to the junk folder rather than the inbox.',
      })
    }
  }

  if (!spf.ok && !dmarc.ok) {
    findings.push({
      level: 'warning',
      message: `The mail records for ${domain} could not be looked up just now, so they have not been checked. `
        + 'That is usually a passing wobble rather than anything wrong.',
    })
  }

  return findings
}

async function lookup(name: string): Promise<{ ok: true; records: string[] } | { ok: false; records: [] }> {
  try {
    const records = await resolveTxt(name)
    // Long TXT records arrive split into chunks that have to be joined before
    // anything can be matched against them.
    return { ok: true, records: records.map((chunks) => chunks.join('')) }
  } catch (err) {
    // ENODATA and ENOTFOUND both mean "there is no such record", which is an
    // answer rather than a failure. Anything else is the lookup itself failing.
    const code = (err as { code?: string } | null)?.code ?? ''
    if (code === 'ENODATA' || code === 'ENOTFOUND') return { ok: true, records: [] }
    return { ok: false, records: [] }
  }
}

/** The domain half of an address, for the checks above. */
export function domainForPreflight(address: string): string | null {
  const at = address.lastIndexOf('@')
  if (at < 0) return null
  const domain = address.slice(at + 1).trim().toLowerCase()
  return domain || null
}
