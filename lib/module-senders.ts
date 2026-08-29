import { prisma } from '@/lib/db/prisma'

// ---------------------------------------------------------------------------
// Which inbox a module's automatic emails leave as.
//
// One row per module, and no row at all for a module nobody has chosen an
// answer for - which is every module on every site until somebody does, and the
// state core has always been in.
//
// Kept out of lib/db.ts on purpose: that file is the settings screen's view of
// the mail accounts and inboxes, and this is a single two-column lookup that
// the send path reads on a hot route. Nothing here touches a secret.
// ---------------------------------------------------------------------------

export type ModuleSender = { moduleName: string; inboxId: string }

/** Every module a sender has been chosen for. The settings panels read it. */
export async function listModuleSenders(): Promise<ModuleSender[]> {
  const rows = await prisma.$queryRaw<{ module_name: string; inbox_id: string }[]>`
    SELECT "module_name", "inbox_id" FROM "uin_module_senders" ORDER BY "module_name" ASC
  `
  return rows.map((r) => ({ moduleName: r.module_name, inboxId: r.inbox_id }))
}

/** The inbox chosen for one module, or null for "leave it to the site's own
 *  address". */
export async function getModuleSenderInboxId(moduleName: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ inbox_id: string }[]>`
    SELECT "inbox_id" FROM "uin_module_senders" WHERE "module_name" = ${moduleName}
  `
  return rows[0]?.inbox_id ?? null
}

/**
 * Chooses an inbox for a module, or clears the choice when `inboxId` is null.
 *
 * Nothing here checks that the module exists. A site can perfectly well pick an
 * inbox for a module, uninstall it for a fortnight and put it back, and having
 * lost the setting in between would be its own small annoyance.
 */
export async function setModuleSender(moduleName: string, inboxId: string | null): Promise<void> {
  if (!inboxId) {
    await prisma.$executeRaw`DELETE FROM "uin_module_senders" WHERE "module_name" = ${moduleName}`
    return
  }
  await prisma.$executeRaw`
    INSERT INTO "uin_module_senders" ("module_name", "inbox_id")
    VALUES (${moduleName}, ${inboxId})
    ON CONFLICT ("module_name")
    DO UPDATE SET "inbox_id" = EXCLUDED."inbox_id", "updated_at" = CURRENT_TIMESTAMP
  `
}
