// ---------------------------------------------------------------------------
// Whether the Unified Inbox's mail view is on screen in this tab.
//
// For the one thing outside the view that needs to know: AdminMailPulse, which
// lives in the admin layout and checks the mail at the Settings pace only while
// somebody is actually reading it (see lib/auto-check-pace.ts). The view says
// so itself, by mounting MailViewBeacon, rather than the pulse guessing from
// the address bar: the admin path differs per site, a bare /inbox opens
// whichever tab comes first, and the campaigns screen shares the same ?tab=.
//
// Counted rather than a flag, so two mounts overlapping across a navigation
// cannot leave it saying "closed" while one of them is still up.
// ---------------------------------------------------------------------------

const CHANGE_EVENT = 'uin:mail-view-change'
let mounted = 0

export function isMailViewOpen(): boolean {
  return mounted > 0
}

/** Marks the mail view as on screen. Call what it returns when the view leaves. */
export function openMailView(): () => void {
  mounted += 1
  window.dispatchEvent(new Event(CHANGE_EVENT))
  let closed = false
  return () => {
    if (closed) return
    closed = true
    mounted -= 1
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }
}

export function onMailViewChange(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener)
  return () => window.removeEventListener(CHANGE_EVENT, listener)
}
