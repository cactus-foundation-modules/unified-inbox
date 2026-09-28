// ---------------------------------------------------------------------------
// The service worker that shows a new-mail nudge when the site pushes one.
//
// A string rather than a file in /public, because a module owns nothing in
// /public: the route beside it serves this from the module's own address, and
// the worker's scope is that address's folder. A worker never needs to control
// the page that registered it to receive a push - it only has to exist - so it
// is registered well away from the admin area and takes over none of it.
//
// Plain ES5-ish JavaScript, no build step: it runs in the browser exactly as
// written here. Kept deliberately small, because a broken worker is one the
// browser keeps running until it next checks for an update. Tested by running
// it in a stand-in worker - see push-worker.test.ts.
//
// Every push shows a notification, without exception. Safari withdraws the
// permission from a site that receives pushes and shows nothing, and Chrome
// puts up a "this site has been updated in the background" of its own.
// ---------------------------------------------------------------------------

/** Where the page finds it. The folder is the worker's scope. */
export const PUSH_WORKER_PATH = '/api/m/unified-inbox/push/worker'

/** What the worker posts to an open hub window asking it to show a
 *  conversation, and what NewMailNotifier listens for. */
export const OPEN_MESSAGE_TYPE = 'uin-open'

/** What the worker posts to every open window of the site when a push lands,
 *  so a list already on the screen redraws now rather than on its own next
 *  round. The mail is filed before the nudge is sent (see push-nudges.ts), so
 *  a redraw at this moment finds it. */
export const ARRIVED_MESSAGE_TYPE = 'uin-arrived'

export const PUSH_WORKER_SOURCE = `'use strict'
// Unified Inbox: new-mail nudges. Served by the site (lib/push-worker.ts).

self.addEventListener('install', function () { self.skipWaiting() })
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()) })

// Only addresses on this site, and only paths: a payload is sealed to this
// browser, but a worker that would follow one anywhere is a worker waiting for
// the day something else gets written into it.
function localPath(value) {
  return typeof value === 'string' && value.charAt(0) === '/' && value.charAt(1) !== '/' && value.charAt(1) !== '\\\\'
}

function readNudge(event) {
  var data = null
  try { data = event.data ? event.data.json() : null } catch (e) { data = null }
  if (!data || typeof data !== 'object') data = {}
  return {
    title: typeof data.title === 'string' && data.title ? data.title : 'New post',
    body: typeof data.body === 'string' ? data.body : '',
    href: localPath(data.href) ? data.href : '/',
    tag: typeof data.tag === 'string' && data.tag ? data.tag : 'uin-new-mail',
    icon: localPath(data.icon) ? data.icon : undefined
  }
}

// An open list hears about the post at the same moment the notification
// appears, instead of a minute later on its own round. Best effort: a window
// that misses it still catches up on its next round, so a failure here must
// never stand between the push and its notification.
function tellOpenWindows() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windows) {
    for (var i = 0; i < windows.length; i++) {
      try { windows[i].postMessage({ type: '${ARRIVED_MESSAGE_TYPE}' }) } catch (e) {}
    }
  }).catch(function () {})
}

self.addEventListener('push', function (event) {
  var nudge = readNudge(event)
  event.waitUntil(Promise.all([
    self.registration.showNotification(nudge.title, {
      body: nudge.body,
      // One per conversation, and a second reply on it still makes a sound:
      // without renotify a notification that replaces another arrives silently.
      tag: nudge.tag,
      renotify: true,
      icon: nudge.icon,
      data: { href: nudge.href }
    }),
    tellOpenWindows()
  ]))
})

self.addEventListener('notificationclick', function (event) {
  event.notification.close()
  var href = event.notification.data && localPath(event.notification.data.href) ? event.notification.data.href : '/'
  var target = new URL(href, self.location.origin)
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windows) {
    var i
    // The conversation already open somewhere: bring that one forward.
    for (i = 0; i < windows.length; i++) {
      if (windows[i].url === target.href && 'focus' in windows[i]) return windows[i].focus()
    }
    // The hub open on some other conversation: bring it forward and ask it to
    // go there, rather than opening a second copy of the admin area.
    for (i = 0; i < windows.length; i++) {
      var here = new URL(windows[i].url)
      if (here.origin === target.origin && here.pathname === target.pathname && 'focus' in windows[i]) {
        windows[i].postMessage({ type: '${OPEN_MESSAGE_TYPE}', href: target.pathname + target.search })
        return windows[i].focus()
      }
    }
    return self.clients.openWindow(target.href)
  }))
})

// The push service replaced this browser's subscription, which Firefox does now
// and then. Take the new one out on the same key and tell the site, so the
// nudges keep coming without anybody pressing the bell again.
self.addEventListener('pushsubscriptionchange', function (event) {
  var old = event.oldSubscription
  var key = old && old.options && old.options.applicationServerKey
  if (!key) return
  event.waitUntil(self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    .then(function (fresh) {
      return fetch('/api/m/unified-inbox/push/subscription', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fresh.toJSON())
      })
    })
    .catch(function () {}))
})
`
