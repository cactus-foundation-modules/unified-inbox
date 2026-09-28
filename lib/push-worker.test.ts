import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { ARRIVED_MESSAGE_TYPE, OPEN_MESSAGE_TYPE, PUSH_WORKER_SOURCE } from './push-worker'

// The worker runs in the browser as written, with no build step and no types,
// so it is run here the same way: in a fresh context with a stand-in `self`
// that records what it was asked to do.

type Shown = { title: string; options: Record<string, unknown> }
type FakeWindow = { url: string; focused: boolean; posted: unknown[]; focus: () => Promise<void>; postMessage: (m: unknown) => void }

function boot(windows: Array<{ url: string }> = []) {
  const listeners = new Map<string, (event: unknown) => void>()
  const shown: Shown[] = []
  const opened: string[] = []
  const clients: FakeWindow[] = windows.map((w) => {
    const client: FakeWindow = {
      url: w.url,
      focused: false,
      posted: [],
      focus: async () => { client.focused = true },
      postMessage: (m) => { client.posted.push(m) },
    }
    return client
  })
  const self = {
    location: { origin: 'https://site.example' },
    addEventListener: (type: string, fn: (event: unknown) => void) => { listeners.set(type, fn) },
    skipWaiting: () => undefined,
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }) },
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => clients,
      openWindow: async (url: string) => { opened.push(url) },
    },
  }
  runInNewContext(PUSH_WORKER_SOURCE, { self, URL, fetch: async () => new Response(null) })

  async function fire(type: string, event: Record<string, unknown>) {
    let pending: Promise<unknown> = Promise.resolve()
    listeners.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => { pending = p } })
    await pending
  }
  const push = (data: unknown) => fire('push', {
    data: data === undefined ? null : { json: () => (typeof data === 'string' ? JSON.parse(data) : data) },
  })
  const click = (href: unknown) => {
    let closed = false
    return fire('notificationclick', { notification: { data: { href }, close: () => { closed = true } } })
      .then(() => closed)
  }
  return { shown, opened, clients, push, click }
}

describe('the push worker', () => {
  it('shows the nudge it was sent, one per conversation, and still makes a sound on a repeat', async () => {
    const worker = boot()
    await worker.push({
      title: 'Ada Lovelace',
      body: 'Chair quote - in Sales',
      href: '/hq/inbox?tab=unified-inbox&inbox=i1&id=t1',
      tag: 'uin-thread-t1',
      icon: '/web-app-manifest-512x512.png',
    })
    expect(worker.shown).toHaveLength(1)
    const [note] = worker.shown
    expect(note!.title).toBe('Ada Lovelace')
    expect(note!.options).toMatchObject({
      body: 'Chair quote - in Sales',
      tag: 'uin-thread-t1',
      renotify: true,
      icon: '/web-app-manifest-512x512.png',
      data: { href: '/hq/inbox?tab=unified-inbox&inbox=i1&id=t1' },
    })
  })

  it('tells every open window that post has arrived, so an open list redraws straight away', async () => {
    const worker = boot([{ url: 'https://site.example/hq/inbox' }, { url: 'https://site.example/hq/orders' }])
    await worker.push({ title: 'Ada Lovelace', href: '/hq/inbox' })
    expect(worker.shown).toHaveLength(1)
    expect(worker.clients.map((c) => c.posted)).toEqual([[{ type: ARRIVED_MESSAGE_TYPE }], [{ type: ARRIVED_MESSAGE_TYPE }]])
  })

  it('still shows something for a push it cannot read, because a silent push costs the permission', async () => {
    const worker = boot()
    await worker.push(undefined)
    await worker.push('"just a string"')
    expect(worker.shown.map((s) => s.title)).toEqual(['New post', 'New post'])
    expect(worker.shown[0]!.options.tag).toBe('uin-new-mail')
  })

  it('follows nothing off this site', async () => {
    const worker = boot()
    await worker.push({ title: 'x', href: 'https://elsewhere.example/phish', icon: '//elsewhere.example/i.png' })
    await worker.push({ title: 'y', href: '/\\elsewhere.example' })
    expect(worker.shown[0]!.options.data).toEqual({ href: '/' })
    expect(worker.shown[0]!.options.icon).toBeUndefined()
    expect(worker.shown[1]!.options.data).toEqual({ href: '/' })
    expect(await worker.click('https://elsewhere.example/phish')).toBe(true)
    expect(worker.opened).toEqual(['https://site.example/'])
  })

  it('opens the conversation when nothing of the site is open', async () => {
    const worker = boot()
    expect(await worker.click('/hq/inbox?tab=unified-inbox&id=t1')).toBe(true)
    expect(worker.opened).toEqual(['https://site.example/hq/inbox?tab=unified-inbox&id=t1'])
  })

  it('brings forward the window already showing that conversation', async () => {
    const worker = boot([
      { url: 'https://site.example/hq/pages' },
      { url: 'https://site.example/hq/inbox?tab=unified-inbox&id=t1' },
    ])
    await worker.click('/hq/inbox?tab=unified-inbox&id=t1')
    expect(worker.clients[1]!.focused).toBe(true)
    expect(worker.clients[1]!.posted).toEqual([])
    expect(worker.opened).toEqual([])
  })

  it('sends an open hub to the conversation rather than opening a second one', async () => {
    const worker = boot([{ url: 'https://site.example/hq/inbox?tab=unified-inbox&id=other' }])
    await worker.click('/hq/inbox?tab=unified-inbox&inbox=i1&id=t1')
    expect(worker.clients[0]!.focused).toBe(true)
    expect(worker.clients[0]!.posted).toEqual([
      { type: OPEN_MESSAGE_TYPE, href: '/hq/inbox?tab=unified-inbox&inbox=i1&id=t1' },
    ])
    expect(worker.opened).toEqual([])
  })
})
