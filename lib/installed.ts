import { prisma } from '@/lib/db/prisma'
import { INSTALLED_MODULE_WHERE } from '@/lib/modules/live-status'

// "Is that module here, and are its tables?" - asked once per render, cheaply,
// for every adapter in the context rail at the same time.
//
// Both halves are needed and neither is enough on its own. A module row says
// the site has installed it, which is the question the rail is really asking;
// the tables say its migrations have actually run, which a module installed
// five minutes ago in the middle of a deploy has not. Reading a table that is
// not there is an exception rather than an empty list, and an exception in a
// side panel takes the conversation down with it.
//
// Deliberately no import of anything belonging to another module. A cross-module
// READ by raw SQL is fine and is what every adapter does; importing another
// module's code is not, because it drags that module's dependencies into our
// graph and breaks the moment it is uninstalled.

const TTL_MS = 30_000

let modulesSlot: { promise: Promise<Set<string>>; at: number } | null = null

/** Every module name installed on this site. Says nothing about its tables. */
export function installedModuleNames(): Promise<Set<string>> {
  const now = Date.now()
  if (modulesSlot && now - modulesSlot.at < TTL_MS) return modulesSlot.promise
  const promise = prisma.module
    .findMany({ where: { ...INSTALLED_MODULE_WHERE }, select: { name: true } })
    .then((rows) => new Set(rows.map((r) => r.name)))
  const mine = { promise, at: now }
  modulesSlot = mine
  // A failed read clears the slot so the next caller tries again rather than
  // being told for the next thirty seconds that nothing is installed.
  promise.catch(() => { if (modulesSlot === mine) modulesSlot = null })
  return promise
}

let tablesSlot: { promise: Promise<Set<string>>; at: number; asked: string } | null = null

/**
 * Which of the given tables exist, in one round trip for all of them.
 *
 * `to_regclass` is the cheap form of the question: it answers from the system
 * catalogue and returns NULL rather than raising for a name that is not there,
 * which is exactly the shape needed when the answer is routinely "no".
 */
export async function existingTables(names: readonly string[]): Promise<Set<string>> {
  const asked = [...names].sort().join(',')
  const now = Date.now()
  if (tablesSlot && tablesSlot.asked === asked && now - tablesSlot.at < TTL_MS) return tablesSlot.promise

  const promise = prisma
    .$queryRaw<{ name: string }[]>`
      SELECT n AS name
        FROM unnest(${[...names]}::text[]) AS n
       WHERE to_regclass('public.' || quote_ident(n)) IS NOT NULL
    `
    .then((rows) => new Set(rows.map((r) => r.name)))
  const mine = { promise, at: now, asked }
  tablesSlot = mine
  promise.catch(() => { if (tablesSlot === mine) tablesSlot = null })
  return promise
}

/** Drop both memos. Anything that installs or removes a module should call it. */
export function invalidateInstalledCache(): void {
  modulesSlot = null
  tablesSlot = null
}
