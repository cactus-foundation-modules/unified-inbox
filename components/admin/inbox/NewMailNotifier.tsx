'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { BellIcon, BellOffIcon } from './icons'
import {
  nudgeFor,
  readPreference,
  shouldPoll,
  writePreference,
  type ArrivalsReply,
} from '@/modules/unified-inbox/lib/notify'
import { OPEN_MESSAGE_TYPE, PUSH_WORKER_PATH } from '@/modules/unified-inbox/lib/push-worker'

// The bell at the foot of the rail, and the offer that appears the first time
// somebody opens the hub.
//
// WHERE THE OFFER APPEARS. In the middle of the window, in the same dialog
// shell as everything else in here. It used to hang off the bell, which put the
// one question the hub ever asks unprompted into the bottom left corner of the
// screen behind the rail's own scrolling - the least looked-at spot there is,
// and close enough to a cookie strip to be dismissed as one.
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
// HOW A NUDGE ARRIVES, in order of preference (see lib/notify.ts):
//   push      - the browser subscribes with its own push service and the site
//               sends to it the moment mail is collected. Arrives with the tab
//               closed. Every current desktop browser, and an iPhone or iPad
//               from the Home Screen app.
//   poll      - the older round of asking, from an open tab behind something
//               else, for a browser that has notifications but no push.
//   homescreen - Safari in an ordinary iPhone or iPad tab, which has neither:
//               the bell explains how to get them rather than vanishing.

/** How long between rounds, once somebody has looked away. Comfortably inside
 *  the ceiling the route will look back over, and slow enough that a tab left
 *  open all day is a rounding error on the site's bill. */
const POLL_MS = 60_000

/** How long a window has to have been left alone before the first round. Alt-
 *  tabbing to a spreadsheet and back should cost the site nothing at all. */
const SETTLE_MS = 15_000

const SUBSCRIPTION_API = '/api/m/unified-inbox/push/subscription'

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

/** Whether this person has been offered the move from the older road to push,
 *  in this browser. Asked once: a colleague happy with nudges from an open tab
 *  is not asked every morning. */
function upgradeKey(userId: string): string {
  return `uin:notify-push-asked:${userId}`
}

type Mode = 'push' | 'poll' | 'homescreen' | 'unsupported'

/** What this browser can do, read once. */
function detectMode(): Mode {
  if (typeof window === 'undefined') return 'unsupported'
  const notifications = 'Notification' in window
  if (notifications && 'serviceWorker' in navigator && 'PushManager' in window) return 'push'
  if (notifications) return 'poll'
  // Safari on an iPhone or iPad, in an ordinary tab: the only browser that
  // says whether it is running as a Home Screen app, and the only one that
  // keeps notifications for that case alone.
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone
  if (standalone === false) return 'homescreen'
  return 'unsupported'
}

/** The site's public key as the browser wants it. */
function keyBytes(publicKey: string): Uint8Array<ArrayBuffer> {
  const padded = publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (publicKey.length % 4)) % 4)
  const raw = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function sameKey(subscription: PushSubscription, expected: Uint8Array): boolean {
  const held = subscription.options?.applicationServerKey
  // A browser that does not say which key it subscribed with is taken at its
  // word; the site says so soon enough if it is wrong, and forgets the row.
  if (!held) return true
  const bytes = new Uint8Array(held)
  return bytes.length === expected.length && bytes.every((b, i) => b === expected[i])
}

async function tellSite(subscription: PushSubscription): Promise<boolean> {
  try {
    const response = await fetch(SUBSCRIPTION_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    })
    return response.ok
  } catch {
    return false
  }
}

type Props = {
  /** Whose browser this is, so a machine two colleagues share does not hand the
   *  first one's answer to the second. */
  userId: string
  /** Told once, when this browser has been asked what it can do, whether there
   *  is a bell to show at all. The rail needs the answer: on a site with no
   *  mail account to fetch from, the bell is the ONLY thing in the box at the
   *  foot of the rail, and a bordered box with nothing in it is worse than no
   *  box. Only the browsers with no way to be told anything say false. */
  onAvailable: (available: boolean) => void
}

type Permission = NotificationPermission | 'unsupported'

/** Everything this browser had to say for itself, read once on the way in.
 *  One piece of state rather than several, because they are one answer: what
 *  the browser supports decides what the stored preference can mean, and both
 *  decide whether the offer appears. Null until it has been read. */
type Boot = { mode: Mode; permission: Permission; enabled: boolean; offering: boolean }

/** The push half, once it is known: the worker's registration and the site's
 *  key, both fetched before anybody presses anything, because Safari only lets
 *  a press ask for permission if nothing is awaited in between. */
type PushKit = { registration: ServiceWorkerRegistration; key: Uint8Array<ArrayBuffer> }

export function NewMailNotifier({ userId, onAvailable }: Props) {
  const router = useRouter()
  // Nothing is drawn until the browser has been asked what it supports and what
  // it remembers, both of which only exist on the client. Rendering the bell
  // before then would be a button whose state the server had guessed, and a
  // button that changes under the reader on the first frame.
  const [boot, setBoot] = useState<Boot | null>(null)
  // Whether the site is pushing to this browser. Until it is, the older road
  // carries the nudges, so nobody is left without while the worker starts.
  const [pushed, setPushed] = useState(false)
  // The one-off offer to move from the older road to push, and the iPhone help.
  const [upgrading, setUpgrading] = useState(false)
  const [helping, setHelping] = useState(false)
  const kit = useRef<PushKit | null>(null)
  // Whether the window is the one being used. Read straight off the document
  // rather than in an effect: nothing on the screen depends on it - it decides
  // only whether to ask the site anything - so the server's guess of "yes" is
  // never rendered and never has to match.
  const [focused, setFocused] = useState(
    () => typeof document === 'undefined' || document.hasFocus(),
  )

  useEffect(() => {
    const mode = detectMode()
    const supported = mode === 'push' || mode === 'poll'
    const permission: Permission = supported ? Notification.permission : 'unsupported'
    const stored = readPreference(store(), userId)
    // Granted already, on a browser that has never been asked in here: another
    // tab, or a previous visit before the answer was being kept. Taking that as
    // yes is the honest reading - the person did grant it - and it stops the
    // offer reappearing for ever on a browser that has already agreed.
    const inherited = supported && permission === 'granted' && stored === null
    if (inherited) writePreference(store(), userId, 'on')
    const enabled = inherited || (stored === 'on' && permission === 'granted')
    // eslint-disable-next-line react-hooks/set-state-in-effect -- post-mount read of what this browser supports and what it remembers; neither exists on the server, so there is no honest first render to put it in
    setBoot({
      mode,
      permission,
      enabled,
      // The offer, once, to somebody who has never answered and whose browser
      // has not already refused. A browser that has refused is offered nothing:
      // the page cannot undo that, and pretending otherwise wastes a press.
      offering: supported && permission === 'default' && stored === null,
    })
    onAvailable(mode !== 'unsupported')
    if (mode !== 'push') return

    let cancelled = false
    void (async () => {
      try {
        const registration = await navigator.serviceWorker.register(PUSH_WORKER_PATH)
        const response = await fetch(SUBSCRIPTION_API, { cache: 'no-store' })
        if (!response.ok) return
        const { publicKey } = await response.json() as { publicKey?: unknown }
        if (typeof publicKey !== 'string' || cancelled) return
        const key = keyBytes(publicKey)
        kit.current = { registration, key }

        let subscription = await registration.pushManager.getSubscription()
        // Bound to a key the site no longer signs with - a site restored onto a
        // new server, say. Dead already; let it go and take out a fresh one.
        if (subscription && !sameKey(subscription, key)) {
          await subscription.unsubscribe().catch(() => false)
          subscription = null
        }
        if (!enabled) return
        if (!subscription) {
          // Allowed already, so most browsers subscribe without a press. Safari
          // may not; if it refuses, the older road carries on and the offer
          // below asks for the press it wants.
          subscription = await registration.pushManager
            .subscribe({ userVisibleOnly: true, applicationServerKey: key })
            .catch(() => null)
        }
        if (cancelled) return
        if (subscription && await tellSite(subscription)) {
          if (!cancelled) setPushed(true)
          return
        }
        const asked = (() => { try { return store()?.getItem(upgradeKey(userId)) === '1' } catch { return true } })()
        if (!asked && !cancelled) setUpgrading(true)
      } catch {
        // No worker in this browser after all - a private window, or site data
        // blocked. The older road is what is left, and it needs nothing here.
      }
    })()
    return () => { cancelled = true }
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

  // A nudge pressed while the hub is open on some other conversation: the
  // worker brings this window forward and asks it to go there, rather than
  // opening a second copy of the admin area.
  useEffect(() => {
    if (boot?.mode !== 'push') return
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; href?: unknown } | null
      if (data?.type !== OPEN_MESSAGE_TYPE || typeof data.href !== 'string') return
      if (!data.href.startsWith('/') || data.href.startsWith('//')) return
      router.push(data.href)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [boot?.mode, router])

  // The server's clock as of the last round. Held in a ref rather than in state
  // because nothing on the screen depends on it and a re-render every minute
  // for a value nobody can see is a re-render for nothing. Null means the next
  // round is a quiet one that only asks what the time is.
  const since = useRef<string | null>(null)

  const show = useCallback((reply: ArrivalsReply) => {
    const nudge = nudgeFor(reply)
    if (!nudge) return
    // Without renotify, a nudge that replaces an earlier one with the same tag
    // arrives in silence - which, with the first still sitting in the
    // notification centre, was every nudge after the first.
    const options: NotificationOptions & { renotify?: boolean } = {
      body: nudge.body,
      tag: nudge.tag,
      renotify: true,
      icon: nudge.icon,
    }
    try {
      const note = new Notification(nudge.title, options)
      note.onclick = () => {
        // Bring the window forward first: a click that navigates a window
        // nobody can see has done nothing anybody can tell.
        window.focus()
        note.close()
        router.push(nudge.href)
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
      if (typeof reply?.now !== 'string' || !Array.isArray(reply.arrivals)) return
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
    if (!shouldPoll({ enabled: boot.enabled, permission: boot.permission, focused, pushed })) {
      // Back in front of somebody, or pushed to. Whatever landed while they
      // were away is on the screen, so the next spell away starts from a fresh
      // mark rather than announcing it all over again.
      since.current = null
      return
    }
    const settle = window.setTimeout(() => { void poll() }, SETTLE_MS)
    const id = window.setInterval(() => { void poll() }, POLL_MS)
    return () => {
      window.clearTimeout(settle)
      window.clearInterval(id)
    }
  }, [boot, focused, poll, pushed])

  const turnOn = useCallback(async () => {
    if (!boot) return
    if (boot.mode === 'homescreen') {
      setHelping(true)
      return
    }
    if (boot.permission === 'unsupported') return
    let permission: Permission = boot.permission
    let isPushed = false
    const ready = kit.current
    if (boot.mode === 'push' && ready) {
      // The very first thing awaited on the back of the press, which is what
      // Safari insists on: subscribing is what asks for permission there.
      const subscription = await ready.registration.pushManager
        .subscribe({ userVisibleOnly: true, applicationServerKey: ready.key })
        .catch(() => null)
      permission = Notification.permission
      if (subscription) isPushed = await tellSite(subscription)
    }
    if (permission === 'default') {
      // No push to be had (no worker, or a push service that turned the
      // browser away before asking anything), so the older road asks for
      // itself. Nothing is written until it comes back: a preference saved as
      // "on" beside a box somebody then dismissed would be a bell that says it
      // is ringing and is not.
      permission = await Notification.requestPermission()
    }
    const on = permission === 'granted'
    writePreference(store(), userId, on ? 'on' : 'off')
    setPushed(on && isPushed)
    setBoot({ ...boot, permission, enabled: on, offering: false })
  }, [boot, userId])

  const turnOff = useCallback(() => {
    if (!boot) return
    writePreference(store(), userId, 'off')
    setBoot({ ...boot, enabled: false, offering: false })
    setPushed(false)
    const ready = kit.current
    if (!ready) return
    void (async () => {
      const subscription = await ready.registration.pushManager.getSubscription().catch(() => null)
      if (!subscription) return
      // The site first, so it stops sending before the browser stops listening.
      await fetch(SUBSCRIPTION_API, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      }).catch(() => undefined)
      await subscription.unsubscribe().catch(() => false)
    })()
  }, [boot, userId])

  const settleUpgrade = useCallback(() => {
    try { store()?.setItem(upgradeKey(userId), '1') } catch { /* asked again next visit; no worse than that */ }
    setUpgrading(false)
  }, [userId])

  const acceptUpgrade = useCallback(async () => {
    settleUpgrade()
    await turnOn()
  }, [settleUpgrade, turnOn])

  const offering = boot?.offering ?? false
  // One dialog at a time, and the first-visit offer before either of the others.
  const dialog: 'offer' | 'upgrade' | 'help' | null = offering ? 'offer' : upgrading ? 'upgrade' : helping ? 'help' : null

  // Escape, and the dimmed background, answer the same way the quiet button
  // does. On the offer that is a no that is remembered: leaving it unanswered
  // would only mean asking the same person the same question on every visit,
  // which is the nagging this whole component exists to avoid.
  const dismiss = useCallback(() => {
    if (dialog === 'offer') turnOff()
    else if (dialog === 'upgrade') settleUpgrade()
    else if (dialog === 'help') setHelping(false)
  }, [dialog, settleUpgrade, turnOff])

  useEffect(() => {
    if (!dialog) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); dismiss() }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [dialog, dismiss])

  if (!boot || boot.mode === 'unsupported') return null

  const { enabled } = boot
  const homescreen = boot.mode === 'homescreen'
  const blocked = boot.permission === 'denied'
  const label = homescreen
    ? 'How to get nudges on this phone'
    : blocked
      ? 'Your browser is blocking notifications from this site'
      : enabled
        ? 'Stop nudging me when post arrives'
        : 'Nudge me when post arrives'

  return (
    <span className="uin-notify">
      <button
        type="button"
        className="uin-refresh uin-notify-toggle"
        onClick={() => { if (enabled) turnOff(); else void turnOn() }}
        disabled={blocked}
        aria-pressed={homescreen ? undefined : enabled}
        title={label}
        aria-label={label}
      >
        {enabled ? BellIcon : BellOffIcon}
      </button>

      {/* Into the page itself rather than into the rail, so the middle of the
          window means the middle of the window: the rail is a scrolling column
          in a grid, and a dialog left inside it would be centred on the column.
          There is no page on the server, and this is never open on a first
          render, so the two sides agree. */}
      {dialog && typeof document !== 'undefined' && createPortal(
        <div
          className="uin-modal"
          onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss() }}
        >
          <div
            className="uin-modal-card uin-modal-card-notify"
            role="dialog"
            aria-modal="true"
            aria-labelledby="uin-notify-offer-title"
          >
            <div className="uin-modal-head">
              <h2 className="uin-modal-title" id="uin-notify-offer-title">
                {dialog === 'help' ? 'Nudges on this phone' : 'Notifications'}
              </h2>
            </div>
            <div className="uin-modal-body">
              {dialog === 'offer' && (
                <p className="uin-confirm-body">
                  Want a nudge when something new lands in your inbox, or in any shared or team
                  inbox you can read? Your browser will ask you to allow it.
                </p>
              )}
              {dialog === 'upgrade' && (
                <p className="uin-confirm-body">
                  Nudges can now reach you with this tab closed, rather than only while it is
                  open in the background. Your browser may ask you to allow it once more.
                </p>
              )}
              {dialog === 'help' && (
                <>
                  <p className="uin-confirm-body">
                    iPhone and iPad only pass on notifications from apps on the Home Screen, so
                    the inbox needs to be one first:
                  </p>
                  <ol className="uin-confirm-body">
                    <li>Tap the Share button, then <strong>Add to Home Screen</strong>.</li>
                    <li>Open the new icon, sign in, and come back to the inbox.</li>
                    <li>Press the bell there and allow notifications.</li>
                  </ol>
                </>
              )}
            </div>
            <div className="uin-modal-foot">
              {dialog === 'help' ? (
                <button type="button" className="btn btn-primary" autoFocus onClick={dismiss}>
                  Got it
                </button>
              ) : (
                <>
                  <button type="button" className="btn btn-secondary" onClick={dismiss}>
                    {dialog === 'offer' ? 'No thanks' : 'Not now'}
                  </button>
                  {/* The one thing on the screen worth pressing, so it is where
                      the keyboard lands. Also what Safari hangs its own box on:
                      the browser will only ask on the back of a press. */}
                  <button
                    type="button"
                    className="btn btn-primary"
                    autoFocus
                    onClick={() => { if (dialog === 'offer') void turnOn(); else void acceptUpgrade() }}
                  >
                    Yes, nudge me
                  </button>
                </>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </span>
  )
}
