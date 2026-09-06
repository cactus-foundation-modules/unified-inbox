import { hasPermission } from '@/lib/permissions/check'
import { prisma } from '@/lib/db/prisma'
import { getInboxAudience, hasMentionOn, listAllInboxAccess, listInboxAccess, listInboxAudiences } from './db'
import { effectiveInboxIds } from './thread-merge'
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
//   individual - one person's own post at work. Its owner's answer is yes.
//                Everybody else's is no UNLESS they have been named on it, and
//                that includes an administrator: this is the ONE place in this
//                module where `unifiedinbox.manage` is not a way past a list,
//                and it is deliberate: an address is only ever somebody's own
//                because a person deliberately made it so, and a promise of
//                privacy that the site owner can read anyway is not a promise,
//                it is a label. What an administrator keeps without being named
//                is the configuration - the name, the folder, who it belongs
//                to, and whether it exists at all - which is the honest half.
//
//                Being named on one is the deliberate act that opens it: a
//                colleague covering somebody's post while they are on leave, an
//                assistant who works their diary. It is a guest list of exactly
//                the people somebody put on it, and an EMPTY one means the
//                owner and nobody else - which is the opposite of what an empty
//                guest list means on a shared address, and is the whole reason
//                the two kinds are asked apart before the rows are read.
//
//                An individual inbox whose owner's staff account has been
//                deleted belongs to nobody, and falls back to `manage` so the
//                post is not sealed in with no way to reach it.
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
 *  and what an EMPTY one means depends entirely on the kind: everybody, on a
 *  shared address; the owner and nobody else, on an individual one. */
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
    // Their own post, or somebody's the owner's address was deliberately opened
    // to - and either way they still have to be allowed in the hub at all: a
    // colleague whose access to the whole thing has been withdrawn does not
    // keep one address of it.
    if (!perms.canView && !perms.canManage) return { view: false, reply: false }
    if (inbox.ownerUserId === userId) {
      return { view: true, reply: perms.canReply || perms.canManage }
    }
    // Named on it, or not in it. No `manage` shortcut above this line, which is
    // the difference between this branch and the shared one below.
    const named = rows.find((r) => r.userId === userId)
    if (!named) return { view: false, reply: false }
    return { view: true, reply: named.canReply && (perms.canReply || perms.canManage) }
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
 * An individual inbox's owner is always on its own guest list, whatever the
 * form sent, and always with the right to answer: it is their post. Written out
 * rather than left implied, so any query that reads the guest list and has
 * never heard of `kind` still gets the right answer about its owner - the sort
 * of belt-and-braces worth having on the one rule in here whose failure mode is
 * a privacy breach rather than a bug. Anybody else the form named is kept
 * beside them, which is how somebody covering the post while its owner is away
 * gets in at all.
 *
 * It also settles what happens to the address somebody opens on. An individual
 * inbox is only ever its OWNER's landing address - being let in to cover
 * somebody's post is not being moved into it - so the defaults the form sent
 * are replaced rather than added to. The older "their own inbox" tick on a
 * shared address is untouched, because a person can perfectly well have a
 * private address and still open the hub on the team's.
 */
export function audienceForSave(
  inbox: InboxShape,
  entries: Array<{ userId: string; canReply: boolean }>,
  defaultUserIds: string[],
): { entries: Array<{ userId: string; canReply: boolean }>; defaultUserIds: string[] } {
  if (inbox.kind !== 'individual') return { entries, defaultUserIds }
  const owner = inbox.ownerUserId
  if (!owner) return { entries: [], defaultUserIds: [] }
  return {
    entries: [
      { userId: owner, canReply: true },
      ...entries.filter((e) => e.userId !== owner),
    ],
    defaultUserIds: [owner],
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
  // Read on every kind now. An individual inbox's rows are its owner and
  // whoever the owner's post was deliberately opened to, and skipping them here
  // was the whole of "nobody else, ever".
  const rows = await listInboxAccess(inboxId)
  return decideInboxAccess(inbox, rows, user.id, perms).view
}

export async function canReplyToInbox(user: SessionUser, inboxId: string): Promise<boolean> {
  const perms = await permissionsFor(user)
  if (!perms.canManage && !perms.canReply) return false
  const inbox = await getInboxAudience(inboxId)
  if (!inbox) return false
  // Read on every kind now. An individual inbox's rows are its owner and
  // whoever the owner's post was deliberately opened to, and skipping them here
  // was the whole of "nobody else, ever".
  const rows = await listInboxAccess(inboxId)
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
  // Read on every kind now. An individual inbox's rows are its owner and
  // whoever the owner's post was deliberately opened to, and skipping them here
  // was the whole of "nobody else, ever".
  const rows = await listInboxAccess(inboxId)
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
  // Read on every kind now. An individual inbox's rows are its owner and
  // whoever the owner's post was deliberately opened to, and skipping them here
  // was the whole of "nobody else, ever".
  const rows = await listInboxAccess(inboxId)
  return decideInboxAccess(inbox, rows, userId, perms).reply
}

/**
 * Whether this colleague may be in the hub at all.
 *
 * The one guard left on being asked to look at something. A tag grants one
 * conversation to one person (see canOpenThread) - it does not hand somebody a
 * module nobody gave them, and a bell notice pointing at a screen that would
 * refuse them is worse than no notice.
 */
export async function userCanOpenHub(userId: string): Promise<boolean> {
  const held = await permissionsForUserId(userId, ['unifiedinbox.view', 'unifiedinbox.manage'])
  if (!held) return false
  return held.has('unifiedinbox.view') || held.has('unifiedinbox.manage')
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

export type ThreadShape = {
  /** The conversation's own id, where the caller has it. Optional because two
   *  routes ask this question about a MESSAGE and have only the columns that
   *  decide the guest list. Without it the tag grant below cannot be consulted,
   *  which is the old answer rather than a wrong one - so anything that wants a
   *  tagged colleague let in has to hand it over. */
  id?: string | null
  inboxId: string | null
  providerModule: string | null
  /** Every address a merged conversation belongs to.
   *
   *  Anybody who can read ANY of them can read the whole of it, which is the
   *  deliberate consequence of merging across addresses (see
   *  migrations/031_thread_merges.sql): a merged conversation half the people
   *  on it cannot open is not one conversation, it is a conversation with a
   *  hole in it. It does widen the guest list, and the screen that merges says
   *  so in as many words, with the addresses named, before it happens.
   *
   *  Absent on an ordinary conversation, which belongs to `inboxId` and nothing
   *  else. */
  absorbedInboxIds?: string[]
}

/** Pure half, so the distinction above is a test rather than a memory.
 *
 *  An address beats a channel, and the order matters. A channel can now say
 *  where its conversations belong - the person who built the page pointed that
 *  form's enquiries at sales@ - and once one has, it is post that arrived at
 *  sales@ and the guest list on sales@ is the honest answer to who may read it.
 *  A channel that addressed nothing still decides for itself, which is every
 *  chat, every call and every form nobody has pointed anywhere. */
export function threadAccessKind(thread: ThreadShape): 'filed' | 'channel' | 'unfiled' {
  if (effectiveInboxIds(thread).length > 0) return 'filed'
  if (thread.providerModule) return 'channel'
  return 'unfiled'
}

/** May this person open, and therefore act on, this conversation? */
export async function canOpenThread(user: SessionUser, thread: ThreadShape): Promise<boolean> {
  const byRule = await openThreadByRule(user, thread)
  if (byRule) return true
  return await openThreadByTag(user.id, thread, await hasPermission(user, 'unifiedinbox.view'))
}

/** The guest list's own answer, before anybody was asked to look at anything. */
async function openThreadByRule(user: SessionUser, thread: ThreadShape): Promise<boolean> {
  switch (threadAccessKind(thread)) {
    case 'channel': {
      const { visibleProviderModules } = await import('./provider-registry')
      const allowed = await visibleProviderModules(user)
      return allowed.includes(thread.providerModule as string)
    }
    case 'filed': {
      // Any one of the addresses is enough. Asked one at a time rather than all
      // at once, because a conversation that has never been merged has exactly
      // one and this stays exactly one question for nearly every thread there is.
      for (const inboxId of effectiveInboxIds(thread)) {
        if (await canViewInbox(user, inboxId)) return true
      }
      return false
    }
    default:
      return await hasPermission(user, 'unifiedinbox.manage')
  }
}

/**
 * The second answer: somebody was asked to look at this one.
 *
 * A tag in an internal note grants THAT conversation to THAT person, and this
 * is where the grant is spent. Three things keep it narrow, and all three
 * matter:
 *
 *   - it is one conversation, never the address it sits in. Being asked about
 *     an invoice in accounts@ does not open accounts@;
 *   - it can only be handed over by somebody who could already open it, which
 *     is checked where the note is written rather than here;
 *   - it grants READING. Answering is a separate grant everywhere else in this
 *     module (D16) and stays one - canReplyToInbox never consults this.
 *
 * The hub's own view permission is still required, so a tag cannot let somebody
 * into a module nobody gave them.
 */
async function openThreadByTag(
  userId: string,
  thread: ThreadShape,
  canView: boolean,
): Promise<boolean> {
  if (!canView || !thread.id) return false
  return await hasMentionOn(thread.id, userId)
}

/** The same question about a colleague who is not the one asking - see
 *  `canUserViewInbox` for why their own permissions are what decide it. */
export async function canUserOpenThread(userId: string, thread: ThreadShape): Promise<boolean> {
  if (await userOpenThreadByRule(userId, thread)) return true
  const held = await permissionsForUserId(userId, ['unifiedinbox.view'])
  return await openThreadByTag(userId, thread, !!held?.has('unifiedinbox.view'))
}

async function userOpenThreadByRule(userId: string, thread: ThreadShape): Promise<boolean> {
  if (threadAccessKind(thread) !== 'channel') {
    for (const inboxId of effectiveInboxIds(thread)) {
      if (await canUserViewInbox(userId, inboxId)) return true
    }
    return false
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
