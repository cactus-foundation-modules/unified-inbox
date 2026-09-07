import { prisma } from '@/lib/db/prisma'

// ---------------------------------------------------------------------------
// What a module's automatic emails do with this module's inboxes.
//
// Two separate answers, one row per module, and no row at all for a module
// nobody has answered either question for - which is every module on every site
// until somebody does, and the state core has always been in.
//
//   inboxId      - the inbox that module's mail goes out AS. Null means the
//                  site's usual address (Settings > Emails), unchanged.
//   copyInboxId  - the inbox a copy of that mail is filed in, so a reply lands
//                  underneath what prompted it. Null means nothing is filed.
//
// They were one setting until migration 046, which was fine while the only
// module using it was Purchase Orders and both answers were the same address.
// A shop wants the second without necessarily wanting the first: its order
// emails leave through the site's sending service and never touch a mail
// folder, so there is nothing for anyone to read afterwards - but which address
// a customer sees on their confirmation is a decision of its own.
//
// Kept out of lib/db.ts on purpose: that file is the settings screen's view of
// the mail accounts and inboxes, and this is a small lookup the send path reads
// on a hot route. Nothing here touches a secret.
// ---------------------------------------------------------------------------

export type ModuleMailSettings = {
  /** The inbox this module's mail goes out as, or null for the site's own. */
  inboxId: string | null
  /** The inbox a copy is filed in, or null for "file nothing". */
  copyInboxId: string | null
}

export type ModuleSender = ModuleMailSettings & { moduleName: string }

const NO_SETTINGS: ModuleMailSettings = { inboxId: null, copyInboxId: null }

type Row = { inbox_id: string | null; copy_inbox_id: string | null }

/** Every module either question has been answered for. */
export async function listModuleSenders(): Promise<ModuleSender[]> {
  const rows = await prisma.$queryRaw<(Row & { module_name: string })[]>`
    SELECT "module_name", "inbox_id", "copy_inbox_id"
      FROM "uin_module_senders"
     ORDER BY "module_name" ASC
  `
  return rows.map((r) => ({ moduleName: r.module_name, inboxId: r.inbox_id, copyInboxId: r.copy_inbox_id }))
}

/**
 * Which modules an inbox is used for - the other way round from the lookups
 * below, and the question the conversation screen asks: an address purchasing
 * sends from is an address suppliers reply to about purchase orders, so the
 * picker for attaching a record to a conversation there should open on those.
 *
 * Either column counts. An inbox that a module only files copies into is still
 * an inbox where that module's conversations live, and is arguably the stronger
 * signal of the two - the copy IS the conversation.
 */
export async function modulesForInbox(inboxId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ module_name: string }[]>`
    SELECT "module_name" FROM "uin_module_senders"
     WHERE "inbox_id" = ${inboxId} OR "copy_inbox_id" = ${inboxId}
     ORDER BY "created_at" ASC, "module_name" ASC
  `
  return rows.map((r) => r.module_name)
}

/** Both answers for one module, for the settings panel that draws them. */
export async function getModuleMailSettings(moduleName: string): Promise<ModuleMailSettings> {
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT "inbox_id", "copy_inbox_id" FROM "uin_module_senders" WHERE "module_name" = ${moduleName}
  `
  const row = rows[0]
  if (!row) return NO_SETTINGS
  return { inboxId: row.inbox_id, copyInboxId: row.copy_inbox_id }
}

/** The inbox chosen for a module to send as, or null for "leave it to the
 *  site's own address". Read on the way out of every module email. */
export async function getModuleSenderInboxId(moduleName: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ inbox_id: string | null }[]>`
    SELECT "inbox_id" FROM "uin_module_senders" WHERE "module_name" = ${moduleName}
  `
  return rows[0]?.inbox_id ?? null
}

/** The inbox a module's sent mail is filed in, or null for "file nothing". */
export async function getModuleCopyInboxId(moduleName: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ copy_inbox_id: string | null }[]>`
    SELECT "copy_inbox_id" FROM "uin_module_senders" WHERE "module_name" = ${moduleName}
  `
  return rows[0]?.copy_inbox_id ?? null
}

/**
 * Chooses the address a module sends as, or clears it when `inboxId` is null.
 *
 * Nothing here checks that the module exists. A site can perfectly well pick an
 * inbox for a module, uninstall it for a fortnight and put it back, and having
 * lost the setting in between would be its own small annoyance.
 */
export async function setModuleSender(moduleName: string, inboxId: string | null): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "uin_module_senders" ("module_name", "inbox_id")
    VALUES (${moduleName}, ${inboxId})
    ON CONFLICT ("module_name")
    DO UPDATE SET "inbox_id" = EXCLUDED."inbox_id", "updated_at" = CURRENT_TIMESTAMP
  `
  await pruneEmpty(moduleName)
}

/** Chooses where a module's sent mail is filed, or stops filing it when
 *  `inboxId` is null. Independent of the address it goes out as. */
export async function setModuleCopyInbox(moduleName: string, inboxId: string | null): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "uin_module_senders" ("module_name", "copy_inbox_id")
    VALUES (${moduleName}, ${inboxId})
    ON CONFLICT ("module_name")
    DO UPDATE SET "copy_inbox_id" = EXCLUDED."copy_inbox_id", "updated_at" = CURRENT_TIMESTAMP
  `
  await pruneEmpty(moduleName)
}

/**
 * Takes away a row that no longer answers either question.
 *
 * A row holding two nulls behaves exactly as no row at all, so this is tidiness
 * rather than correctness - but it is also what makes clearing the last setting
 * on a module leave the table as it was found, and it sweeps up rows left
 * hollow by an inbox being deleted (both foreign keys are ON DELETE SET NULL
 * since migration 046).
 */
async function pruneEmpty(moduleName: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "uin_module_senders"
     WHERE "module_name" = ${moduleName}
       AND "inbox_id" IS NULL
       AND "copy_inbox_id" IS NULL
  `
}
