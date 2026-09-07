// ---------------------------------------------------------------------------
// The sending service's own counters, recognised so nothing here ever follows
// one.
//
// A message does not come back the way it went out. Brevo rewrites it on the
// way through: an invisible picture is added whose only purpose is to report
// that the message was opened, and every link is replaced with one that goes to
// Brevo first and on to the real address afterwards. The copy that lands back
// in the Sent folder carries both, and so does the copy quoted underneath the
// next reply.
//
// So reading our own Sent post used to file an open against it. Pictures in a
// message from ourselves are shown without being asked for - the note about
// tracking pixels is about what a STRANGER learns, and there is no stranger in
// our own outbox - the site fetches each one through its own proxy, and one of
// them was Brevo's counter. The customer had not opened anything. We had. The
// receipt on the screen and the open count in Brevo's reports were both
// counting the sender reading their own sent mail.
//
// The addresses carry a token naming the exact send, so this is not a vague
// "somebody looked": it is attributed to the person the message went to, and it
// is the number a colleague then makes a decision on.
//
// Matched on the PATH rather than the host. Brevo has moved the hostname
// repeatedly - r.sendibm1.com, then a per-account subdomain of sendibt2.com,
// then sendibt3.com, and the marketing half sits on brevo.net - and a host list
// that has fallen behind fails silently, in the direction of counting a fake
// open again. A path list that is too broad fails by not drawing a picture,
// which is the cheaper of the two by a distance, and `/tr/op/` is not a path
// anything anybody wants to look at is served from.
//
// Nothing refused here is visible in any case: an open beacon is a transparent
// single pixel.
// ---------------------------------------------------------------------------

/** The counters that report a message was opened. `tr` is the transactional
 *  half of Brevo, `mk` the marketing one; this module sends through both. */
const OPEN_BEACON_PATHS = ['/tr/op/', '/mk/op/']

/** The redirectors that report a link in a message was followed. The address
 *  underneath is not recoverable without following it, which is the whole
 *  difficulty - see LinkPeek. */
const CLICK_WRAPPER_PATHS = ['/tr/cl/', '/mk/cl/']

/** The path of a web address, or null when it is not one. Never throws: it is
 *  handed whatever was written in an href or a src. */
function pathOf(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.pathname
  } catch {
    return null
  }
}

/** True when fetching this address would tell the sending service the message
 *  had been opened. Never fetched, by anything, for anybody. */
export function isOpenBeacon(url: string): boolean {
  const path = pathOf(url)
  return path !== null && OPEN_BEACON_PATHS.some((prefix) => path.startsWith(prefix))
}

/** True when following this address would be counted as the recipient having
 *  clicked the link. Still openable - somebody may genuinely need to check
 *  where a link in their own mailshot goes - but not without being told. */
export function isClickWrapper(url: string): boolean {
  const path = pathOf(url)
  return path !== null && CLICK_WRAPPER_PATHS.some((prefix) => path.startsWith(prefix))
}
