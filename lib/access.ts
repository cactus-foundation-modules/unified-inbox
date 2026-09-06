import { hasPermission } from '@/lib/permissions/check'
import { prisma } from '@/lib/db/prisma'
import { getInboxAudience, listAllInboxAccess, listInboxAccess, listInboxAudiences } from './db'
import type { InboxAccess, InboxAudience, InboxKind } from './types'
import type { SessionUser } from '@/lib/auth/session'

// ---------------------------------------------------------------------------
// Per-inbox access (D16). Get this right once, here, because every stage from
// the sync engine onwards asks it the same question and a leak in one place is
// a leak everywhere.
//
// There are two questions, asked in this order.
//
// FIRST: which kind of address is it?
//
//   individual - one person's own post at work. Their answer is yes and every
//                other answer is no, an administrator's included. This is the
//                ONE place in this module where `unifiedinbox.manage` is not a
//                way past a list, and it is deliberate: an address is only ever
//                somebody's own because a person deliberately made it so, and a
//                promise of privacy that the site owner can read anyway is not
//                a promise, it is a label. What an administrator keeps is the
//                configuration - the name, the folder, who it belongs to, and
//                whether it exists at all - which is the honest half. An
//                individual inbox whose owner's staff account has been deleted
//                belongs to nobody, and falls back to `manage` so the post is
//                not sealed in with no way to reach it.
//
//   shared     - an address the business owns, and the rule this module has
//                always had: NO access rows means open to anybody holding
//                `unifiedinbox.view`, ANY access rows means open to the people
//                named on them and nobody else. `manage` goes past that list,
//                because whoever edits the guest lists can put themselves on
//                one in two clicks - pretending otherwise would be theatre.
//
// That way an ordinary one-person site never has to configure anything, and the
// moment somebody restricts accounts@ it is genuinely restricted rather than
// merely hidden from the rail.
//
// SECOND, and unchanged: reading and answering are two grants, so `view` never
// implies `reply`.
//
// Search and the All view must filter with visibleInboxIds INSIDE their query
// rather than dropping rows afterwards: a snippet from accounts@ in somebody's
// search results is the same breach as opening it.
// ---------------------------------------------------------------------------

/** What one address is, without the twenty facts that do not bear on who may
 *  open it. Shaped so a caller can hand over a whole `Inbox` and be right. */
export type InboxShape = { kind: InboxKind; ownerUserId: string | null }

/** Pure half of the rule, so the interesting cases can be tested without a
 *  database or a session. `rows` is every access row for the inbox in question,
 *  and is ignored entirely on an individual inbox - the owner is the guest
 *  list there. */
export function decideInboxAccess(
  inbox: InboxShape,
  rows: Array<{ userId: string; canReply: boolean }>,
  userId: string,
  perms: { canView: boolean; canReply: boolean; canManage: boolean }
): { view: boolean; reply: boolean } {
  if (inbox.kind === 'individual') {
    // Nobody's, because whoever it belonged to no longer has an account. Left
    // to an administrator rather than to nobody at all, which is the same
    // answer this module gives for mail it could not place.
    if (!inbox.ownerUserId) {
      return perms.canManage ? { view: true, reply: true } : { view: false, reply: false }
    }
    if (inbox.ownerUserId !== userId) return { view: false, reply: false }
    // Their own post, but they still have to be allowed in the hub at all: a
    // colleague whose access to the whole thing has been withdrawn does not
    // keep one address of it.
    if (!perms.canView && !perms.canManage) return { view: false, reply: false }
    return { view: true, reply: perms.canReply || perms.canManage }
  }

  if (perms.canManage) return { view: true, reply: true }
  if (!perms.canView) return { view: false, reply: false }
  if (rows.length === 0) return { view: true, reply: perms.canReply }
  const mine = rows.find((r) => r.userId === userId)
  if (!mine) return { view: false, reply: false }
  return { view: true, reply: perms.canReply && mine.canReply }
}

/**
 * What to write to the two tables when an inbox is saved.
 *
 * An individual inbox has one member and one owner, and they are the same
 * person - so the guest list is written to say exactly that rather than left
 * empty. Redundant on purpose: any query that reads the guest list and has
 * never heard of `kind` then still gets the right answer, which is the sort of
 * belt-and-braces worth having on the one rule in here whose failure mode is a
 * privacy breach rather than a bug.
 *
 * It also settles what happens to the address somebody opens on. Making an
 * inbox theirs points them at it; the older "their own inbox" tick on a shared
 * address is untouched, because a person can perfectly well have a private
 * address and still open the hub on the team's.
 */
export function audienceForSave(
  inbox: InboxShape,
  entries: Array<{ userId: string; canReply: boolean }>,
  defaultUserIds: string[],
): { entries: Array<{ userId: string; canReply: boolean }>; defaultUserIds: string[] } {
  if (inbox.kind !== 'individual') return { entries, defaultUserIds }
  if (!inbox.ownerUserId) return { entries: [], defaultUserIds: [] }
  return {
    entries: [{ userId: inbox.ownerUserId, canReply: true }],
    defaultUserIds: [inbox.ownerUserId],
  }
}

async function permissionsFor(user: SessionUser) {
  const [canView, canReply, canManage] = await Promise.all([
    hasPermission(user, 'unifiedinbox.view'),
    hasPermission(user, 'unifiedinbox.reply'),
    hasPermission(user, 'unifiedinbox.manage'),
  ])
  return { canView, canReply, canManage }
}

export async function canViewInbox(user: SessionUser, inboxId: string): Promise<boolean> {
  const perms = await permissionsFor(user)
  if (!perms.canView && !perms.canManage) return false
  // The kind is read before the shortcut, not after it: an administrator is
  // past a shared address's guest list and is not past an individual one, and
  // answering true before asking which kind it is was exactly the bug this
  // whole distinction exists to make impossible.
  const inbox = await getInboxAudience(inboxId)
  if (!inbox) return false
  const rows = inbox.kind === 'individual' ? [] : await listInboxAccess(inboxId)
  return decideInboxAccess(inbox, rows, user.id, perms).view
}

export async function canReplyToInbox(user: SessionUser, inboxId: string): Promise<boolean> {
  const perms = await permissionsFor(user)
  if (!perms.canManage && !perms.canReply) return false
  const inbox = await getInboxAudience(inboxId)
  if (!inbox) return false
  const rows = inbox.kind === 'individual' ? [] : await listInboxAccess(inboxId)
  return decideInboxAccess(inbox, rows, user.id, perms).reply
}

/** Every inbox id this user may read, in one query - the shape a list, a search
 *  or the All view wants, because they must filter inside the SQL. */
export async function visibleInboxIds(user: SessionUser, allInboxIds: string[]): Promise<string[]> {
  const perms = await permissionsFor(user)
  if (!perms.canView && !perms.canManage) return []
  const { byInbox, kinds } = await audienceIndex()
  return allInboxIds.filter((id) => {
    const inbox = kinds.get(id)
    return inbox ? decideInboxAccess(inbox, byInbox.get(id) ?? [], user.id, perms).view : false
  })
}

/** Every inbox id this user may SEND FROM, in one query.
 *
 *  The compose screen needs this rather than `visibleInboxIds`: reading
 *  accounts@ and writing as accounts@ are two different grants (D16), and an
 *  address offered in the From menu that the send route would then refuse is a
 *  worse answer than not offering it. Shaped like `visibleInboxIds` on purpose -
 *  one query for the whole list, never one per inbox.
 */
export async function replyableInboxIds(user: SessionUser, allInboxIds: string[]): Promise<string[]> {
  const perms = await permissionsFor(user)
  if (!perms.canManage && !perms.canReply) return []
  const { byInbox, kinds } = await audienceIndex()
  return allInboxIds.filter((id) => {
    const inbox = kinds.get(id)
    return inbox ? decideInboxAccess(inbox, byInbox.get(id) ?? [], user.id, perms).reply : false
  })
}

/** Both halves of what the rule needs about every address on the site, in two
 *  queries rather than two per address. Shared by the two bulk helpers above,
 *  which ask the same question about reading and about answering. */
async function audienceIndex(): Promise<{
  byInbox: Map<string, InboxAccess[]>
  kinds: Map<string, InboxAudience>
}> {
  const [all, audiences] = await Promise.all([listAllInboxAccess(), listInboxAudiences()])
  const byInbox = new Map<string, InboxAccess[]>()
  for (const row of all) {
    const list = byInbox.get(row.inboxId)
    if (list) list.push(row)
    else byInbox.set(row.inboxId, [row])
  }
  return { byInbox, kinds: new Map(audiences.map((a) => [a.id, a])) }
}

/**
 * The same question about somebody who is not the person making the request.
 *
 * Mentioning a colleague raises a notification, and a notification about a
 * conversation they may not read would tell them it exists - so their own
 * permissions and their own place on the guest list are what decide it, not the
 * permissions of whoever typed the note. Their role is read here rather than
 * taken from a session, because there is no session but our own to read.
 */
export async function canUserViewInbox(userId: string, inboxId: string): Promise<boolean> {
  const person = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, roleId: true, suspendedAt: true, role: { select: { isProtected: true } } },
  })
  if (!person || person.suspendedAt) return false
  if (person.role.isProtected) return true

  const granted = await prisma.rolePermission.findMany({
    where: { roleId: person.roleId, permissionKey: { in: ['unifiedinbox.view', 'unifiedinbox.reply', 'unifiedinbox.manage'] } },
    select: { permissionKey: true },
  })
  const has = new Set(granted.map((g) => g.permissionKey))
  const perms = {
    canView: has.has('unifiedinbox.view'),
    canReply: has.has('unifiedinbox.reply'),
    canManage: has.has('unifiedinbox.manage'),
  }
  const inbox = await getInboxAudience(inboxId)
  if (!inbox) return false
  const rows = inbox.kind === 'individual' ? [] : await listInboxAccess(inboxId)
  return decideInboxAccess(inbox, rows, userId, perms).view
}

/**
 * May this colleague SEND from this address? The reply half of the same
 * question `canUserViewInbox` asks about reading.
 *
 * It exists for the one thing this module does with nobody sitting there:
 * posting a message somebody scheduled. The rights that decide it are the ones
 * held at the moment it leaves, not the ones held when the time was set -
 * somebody taken off accounts@ on Friday does not have a message leave as
 * accounts@ on Monday.
 */
export async function canUserReplyToInbox(userId: string, inboxId: string): Promise<boolean> {
  const held = await permissionsForUserId(userId, [
    'unifiedinbox.view',
    'unifiedinbox.reply',
    'unifiedinbox.manage',
  ])
  if (!held) return false
  const perms = {
    canView: held.has('unifiedinbox.view'),
    canReply: held.has('unifiedinbox.reply'),
    canManage: held.has('unifiedinbox.manage'),
  }
  if (!perms.canManage && !perms.canReply) return false
  const inbox = await getInboxAudience(inboxId)
  if (!inbox) return false
  const rows = inbox.kind === 'individual' ? [] : await listInboxAccess(inboxId)
  return decideInboxAccess(inbox, rows, userId, perms).reply
}

/** Whether this colleague may answer anything at all. Asked about a channel
 *  another module owns, where there is no inbox guest list to consult and the
 *  channel's own permission is the other half. */
export async function userCanReply(userId: string): Promise<boolean> {
  const held = await permissionsForUserId(userId, ['unifiedinbox.reply', 'unifiedinbox.manage'])
  if (!held) return false
  return held.has('unifiedinbox.reply') || held.has('unifiedinbox.manage')
}

// ---------------------------------------------------------------------------
// Conversations that sit in no inbox.
//
// A conversation has one of three shapes, and telling them apart is the whole
// of this section:
//
//   filed    - an email in one of the site's inboxes. The guest list decides.
//   channel  - a chat, an enquiry, a call. It never had an address to be filed
//              under, so the module that owns it decides, exactly as the tabs
//              and the send route already do.
//   unfiled  - an email that reached the account and matched no address at all.
//              "Nobody could place this" is an administrator's problem.
//
// Reading `inbox_id IS NULL` as unfiled collapses the middle one into the last,
// which locks every colleague out of the chats and enquiries they can plainly
// see on the screen in front of them - the same shape of defect as suppressing
// a tab from somebody who cannot see its replacement.
// ---------------------------------------------------------------------------

export type ThreadShape = { inboxId: string | null; providerModule: string | null }

/** Pure half, so the distinction above is a test rather than a memory. */
export function threadAccessKind(thread: ThreadShape): 'filed' | 'channel' | 'unfiled' {
  if (thread.providerModule) return 'channel'
  if (thread.inboxId) return 'filed'
  return 'unfiled'
}

/** May this person open, and therefore act on, this conversation? */
export async function canOpenThread(user: SessionUser, thread: ThreadShape): Promise<boolean> {
  switch (threadAccessKind(thread)) {
    case 'channel': {
      const { visibleProviderModules } = await import('./provider-registry')
      const allowed = await visibleProviderModules(user)
      return allowed.includes(thread.providerModule as string)
    }
    case 'filed':
      return await canViewInbox(user, thread.inboxId as string)
    default:
      return await hasPermission(user, 'unifiedinbox.manage')
  }
}

/** The same question about a colleague who is not the one asking - see
 *  `canUserViewInbox` for why their own permissions are what decide it. */
export async function canUserOpenThread(userId: string, thread: ThreadShape): Promise<boolean> {
  if (threadAccessKind(thread) !== 'channel') {
    return thread.inboxId ? await canUserViewInbox(userId, thread.inboxId) : false
  }
  const { providerPermissionFor } = await import('./provider-registry')
  const channel = await providerPermissionFor(thread.providerModule as string)
  // A channel whose module has gone answers to nobody (E20).
  if (!channel.known) return false
  const keys = ['unifiedinbox.view', 'unifiedinbox.manage']
  if (channel.permission) keys.push(channel.permission)
  const held = await permissionsForUserId(userId, keys)
  if (!held) return false
  if (held.has('unifiedinbox.manage')) return true
  if (!held.has('unifiedinbox.view')) return false
  return !channel.permission || held.has(channel.permission)
}

/** The permission keys a colleague actually holds, out of the ones asked for.
 *  Null means there is no such person to ask about. A protected role holds
 *  everything, which is how the rest of the site reads one. */
async function permissionsForUserId(userId: string, keys: string[]): Promise<Set<string> | null> {
  const person = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, roleId: true, suspendedAt: true, role: { select: { isProtected: true } } },
  })
  if (!person || person.suspendedAt) return null
  if (person.role.isProtected) return new Set(keys)
  const granted = await prisma.rolePermission.findMany({
    where: { roleId: person.roleId, permissionKey: { in: keys } },
    select: { permissionKey: true },
  })
  return new Set(granted.map((g) => g.permissionKey))
}
