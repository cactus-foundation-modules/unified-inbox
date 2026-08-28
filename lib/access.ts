import { hasPermission } from '@/lib/permissions/check'
import { prisma } from '@/lib/db/prisma'
import { listAllInboxAccess, listInboxAccess } from './db'
import type { InboxAccess } from './types'
import type { SessionUser } from '@/lib/auth/session'

// ---------------------------------------------------------------------------
// Per-inbox access (D16). Get this right once, here, because every stage from
// the sync engine onwards asks it the same question and a leak in one place is
// a leak everywhere.
//
// The rule, in one sentence: an inbox with NO access rows is open to anybody
// holding `unifiedinbox.view`, and an inbox with ANY access rows is open to the
// people named on them and nobody else.
//
// That way an ordinary one-person site never has to configure anything, and the
// moment somebody restricts accounts@ it is genuinely restricted rather than
// merely hidden from the rail. Holding `unifiedinbox.manage` is the one way
// past a list, because the person who edits the guest lists can put themselves
// on any of them in two clicks - pretending otherwise would be theatre, not
// security. Search and the All view must filter with visibleInboxIds INSIDE
// their query rather than dropping rows afterwards: a snippet from accounts@ in
// somebody's search results is the same breach as opening it.
// ---------------------------------------------------------------------------

/** Pure half of the rule, so the interesting cases can be tested without a
 *  database or a session. `rows` is every access row for the inbox in question. */
export function decideInboxAccess(
  rows: Array<{ userId: string; canReply: boolean }>,
  userId: string,
  perms: { canView: boolean; canReply: boolean; canManage: boolean }
): { view: boolean; reply: boolean } {
  if (perms.canManage) return { view: true, reply: true }
  if (!perms.canView) return { view: false, reply: false }
  if (rows.length === 0) return { view: true, reply: perms.canReply }
  const mine = rows.find((r) => r.userId === userId)
  if (!mine) return { view: false, reply: false }
  return { view: true, reply: perms.canReply && mine.canReply }
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
  if (perms.canManage) return true
  if (!perms.canView) return false
  const rows = await listInboxAccess(inboxId)
  return decideInboxAccess(rows, user.id, perms).view
}

export async function canReplyToInbox(user: SessionUser, inboxId: string): Promise<boolean> {
  const perms = await permissionsFor(user)
  if (!perms.canManage && !perms.canReply) return false
  const rows = await listInboxAccess(inboxId)
  return decideInboxAccess(rows, user.id, perms).reply
}

/** Every inbox id this user may read, in one query - the shape a list, a search
 *  or the All view wants, because they must filter inside the SQL. */
export async function visibleInboxIds(user: SessionUser, allInboxIds: string[]): Promise<string[]> {
  const perms = await permissionsFor(user)
  if (perms.canManage) return allInboxIds
  if (!perms.canView) return []
  const all = await listAllInboxAccess()
  const byInbox = new Map<string, InboxAccess[]>()
  for (const row of all) {
    const list = byInbox.get(row.inboxId)
    if (list) list.push(row)
    else byInbox.set(row.inboxId, [row])
  }
  return allInboxIds.filter((id) =>
    decideInboxAccess(byInbox.get(id) ?? [], user.id, perms).view
  )
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
  const rows = await listInboxAccess(inboxId)
  return decideInboxAccess(rows, userId, perms).view
}
