'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { BellIcon, BellOffIcon } from './icons'
import {
  notificationCopy,
  readPreference,
  shouldPoll,
  writePreference,
  type ArrivalsReply,
} from '@/modules/unified-inbox/lib/notify'

// The bell at the foot of the rail, and the offer that appears under it the
// first time somebody opens the hub.
//
// WHY IT IS OFFERED RATHER THAN SIMPLY ASKED FOR. Firing the browser's own
// permission box at somebody the moment a page loads is the single most
// disliked pattern on the web, and it is worse than disliked: a refusal is
// permanent, per site, and cannot be undone from inside the page. Safari will
// not even show the box without a press to hang it on. So this asks in the
// site's own words first, and only reaches for the browser's box once somebody
// has said yes to something they could read. Somebody who says no is not asked
// twice; the bell is still there for the day they change their mind.
//
// WHAT IT WATCHES is decided by the site, not here - see the route. In short:
// the address that is theirs, if they have been given one, and everything they
// may read if they have not.
//
// WHEN IT ASKS: only while the window is behind something else. A colleague
// looking at the list can see what has landed in it. See shouldPoll.

/** How long between rounds, once somebody has looked away. Comfortably inside
 *  the ceiling the route will look back over, and slow enough that a tab left
 *  open all day is a rounding error on the site's bill. */
const POLL_MS = 60_000

/** How long a window has to have been left alone before the first round. Alt-
 *  tabbing to a spreadsheet and back should cost the site nothing at all. */
const SETTLE_MS = 15_000

/** One tag for the lot, so a morning away comes back to the latest nudge rather
 *  than to a stack of forty. */
const TAG = 'uin-new-mail'

/** Reaching for localStorage is itself what throws in a browser told to block
 *  site data - not merely reading from it - so even the handle is fetched
 *  behind a guard. */
function store(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

type Props = {
  /** Whose browser this is, so a machine two colleagues share does not hand the
   *  first one's answer to the second. */
  userId: string
  /** The address being watched, for the copy - or null when it is everything
   *  this person can read, which needs no naming. */
  scopeName: string | null
  /** Where a nudge about one conversation goes when it is clicked. */
  threadHref: (threadId: string) => string
  /** And where a nudge about several goes: the list itself. */
  listHref: string
  /** Told once, when this browser has been asked what it can do, whether there
   *  is a bell to show at all. The rail needs the answer: on a site with no
   *  mail account to fetch from, the bell is the ONLY thing in the box at the
   *  foot of the rail, and a bordered box with nothing in it is worse than no
   *  box. Only the browsers with no notifications at all say false. */
  onAvailable: (available: boolean) => void
}

type Permission = NotificationPermission | 'unsupported'

/** Everything this browser had to say for itself, read once on the way in.
 *  One piece of state rather than three, because they are one answer: what the
 *  browser supports decides what the stored preference can mean, and both
 *  decide whether the offer appears. Null until it has been read. */
type Boot = { permission: Permission; enabled: boolean; offering: boolean }

export function NewMailNotifier({ userId, scopeName, threadHref, listHref, onAvailable }: Props) {
  const router = useRouter()
  // Nothing is drawn until the browser has been asked what it supports and what
  // it remembers, both of which only exist on the client. Rendering the bell
  // before then would be a button whose state the server had guessed, and a
  // button that changes under the reader on the first frame.
  const [boot, setBoot] = useState<Boot | null>(null)
  // Whether the window is the one being used. Read straight off the document
  // rather than in an effect: nothing on the screen depends on it - it decides
  // only whether to ask the site anything - so the server's guess of "yes" is
  // never rendered and never has to match.
  const [focused, setFocused] = useState(
    () => typeof document === 'undefined' || document.hasFocus(),
  )

  useEffect(() => {
    const supported = typeof window !== 'undefined' && 'Notification' in window
    const permission: Permission = supported ? Notification.permission : 'unsupported'
    const stored = readPreference(store(), userId)
    // Granted already, on a browser that has never been asked in here: another
    // tab, or a previous visit before the answer was being kept. Taking that as
    // yes is the honest reading - the person did grant it - and it stops the
    // offer reappearing for ever on a browser that has already agreed.
    const inherited = supported && permission === 'granted' && stored === null
    if (inherited) writePreference(store(), userId, 'on')
    // eslint-disable-next-line react-hooks/set-state-in-effect -- post-mount read of what this browser supports and what it remembers; neither exists on the server, so there is no honest first render to put it in
    setBoot({
      permission,
      enabled: inherited || (stored === 'on' && permission === 'granted'),
      // The offer, once, to somebody who has never answered and whose browser
      // has not already refused. A browser that has refused is offered nothing:
      // the page cannot undo that, and pretending otherwise wastes a press.
      offering: supported && permission === 'default' && stored === null,
    })
    onAvailable(supported)
  }, [onAvailable, userId])

  useEffect(() => {
    const onFocus = () => setFocused(true)
    const onBlur = () => setFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    // A tab going behind another tab in the same window fires neither, so the
    // page has to watch both facts to know it is not being looked at.
    const onVisible = () => setFocused(document.visibilityState === 'visible' && document.hasFocus())
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // The server's clock as of the last round. Held in a ref rather than in state
  // because nothing on the screen depends on it and a re-render every minute
  // for a value nobody can see is a re-render for nothing. Null means the next
  // round is a quiet one that only asks what the time is.
  const since = useRef<string | null>(null)

  // Where a nudge goes when it is clicked, and what the address is called, held
  // in a ref rather than read straight out of the props.
  //
  // NOT a tidiness thing. The parent builds these fresh on every render, so a
  // callback that named them would be a new function every render, and the
  // effect below would tear its timer down and build a new one each time - a
  // timer that is rebuilt never reaches the end of its wait, and the asking
  // would silently never happen. Same trap, same fix, as the refresh button
  // beside this one.
  const scene = useRef({ scopeName, threadHref, listHref })
  useEffect(() => { scene.current = { scopeName, threadHref, listHref } }, [scopeName, threadHref, listHref])

  const show = useCallback((reply: ArrivalsReply) => {
    const first = reply.arrivals[0]
    if (!first) return
    const { title, body } = notificationCopy(reply.arrivals, reply.total, scene.current.scopeName)
    const single = reply.total <= 1 && reply.arrivals.length === 1
    const href = single ? scene.current.threadHref(first.threadId) : scene.current.listHref
    try {
      const note = new Notification(title, { body, tag: TAG, icon: '/cactus-favicon-32x32.png' })
      note.onclick = () => {
        // Bring the window forward first: a click that navigates a window
        // nobody can see has done nothing anybody can tell.
        window.focus()
        note.close()
        router.push(href)
      }
    } catch {
      // Some browsers refuse to construct one outside a service worker, on
      // Android in particular. Nothing to be done about it from here, and
      // certainly nothing worth putting on the screen.
    }
  }, [router])

  const poll = useCallback(async () => {
    const mark = since.current
    const url = mark
      ? `/api/m/unified-inbox/notifications?since=${encodeURIComponent(mark)}`
      : '/api/m/unified-inbox/notifications'
    try {
      const response = await fetch(url, { cache: 'no-store' })
      if (!response.ok) return
      const reply = await response.json() as ArrivalsReply
      if (typeof reply?.now !== 'string') return
      const first = mark === null
      since.current = reply.now
      // The first round of a spell away is quiet by construction: it was asked
      // with no mark, so the site had nothing to measure from and sent nothing
      // back. Said out loud here too, because "we sent nothing" and "say
      // nothing" being the same thing is exactly the sort of coincidence that
      // stops being true later.
      if (!first) show(reply)
    } catch {
      // A moment offline. The next round tries again, and a colleague who has
      // stepped away does not want an alert about the connection either.
    }
  }, [show])

  useEffect(() => {
    if (!boot) return
    if (!shouldPoll({ enabled: boot.enabled, permission: boot.permission, focused })) {
      // Back in front of somebody. Whatever landed while they were away is on
      // the screen, so the next spell away starts from a fresh mark rather than
      // announcing it all over again.
      since.current = null
      return
    }
    const settle = window.setTimeout(() => { void poll() }, SETTLE_MS)
    const id = window.setInterval(() => { void poll() }, POLL_MS)
    return () => {
      window.clearTimeout(settle)
      window.clearInterval(id)
    }
  }, [boot, focused, poll])

  const turnOn = useCallback(async () => {
    const permission = boot?.permission
    if (!permission || permission === 'unsupported') return
    let granted = permission
    if (permission === 'default') {
      // On the back of a press, which is what Safari requires and what every
      // other browser deserves. Nothing is written until it comes back: a
      // preference saved as "on" beside a box somebody then dismissed would be
      // a bell that says it is ringing and is not.
      granted = await Notification.requestPermission()
    }
    const on = granted === 'granted'
    writePreference(store(), userId, on ? 'on' : 'off')
    setBoot({ permission: granted, enabled: on, offering: false })
  }, [boot, userId])

  const turnOff = useCallback(() => {
    if (!boot) return
    writePreference(store(), userId, 'off')
    setBoot({ ...boot, enabled: false, offering: false })
  }, [boot, userId])

  if (!boot || boot.permission === 'unsupported') return null

  const { enabled, offering } = boot
  const blocked = boot.permission === 'denied'
  const label = blocked
    ? 'Your browser is blocking notifications from this site'
    : enabled
      ? `Stop nudging me when post arrives${scopeName ? ` in ${scopeName}` : ''}`
      : `Nudge me when post arrives${scopeName ? ` in ${scopeName}` : ''}`

  return (
    <span className="uin-notify">
      <button
        type="button"
        className="uin-refresh uin-notify-toggle"
        onClick={() => { if (enabled) turnOff(); else void turnOn() }}
        disabled={blocked}
        aria-pressed={enabled}
        title={label}
        aria-label={label}
      >
        {enabled ? BellIcon : BellOffIcon}
      </button>

      {offering && (
        <div className="uin-notify-offer" role="dialog" aria-label="Notifications">
          <p className="uin-notify-offer-text">
            Want a nudge when something new lands
            {scopeName ? <> in <strong>{scopeName}</strong></> : ' in your inbox'}? Your
            browser will ask you to allow it.
          </p>
          <div className="uin-notify-offer-buttons">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void turnOn()}>
              Yes, nudge me
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={turnOff}>
              No thanks
            </button>
          </div>
        </div>
      )}
    </span>
  )
}
