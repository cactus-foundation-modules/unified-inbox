import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The uninstall list, checked against the real tables rather than against
// somebody's memory of them.
//
// Uninstalling with data drops exactly what the manifest names and nothing
// else. A table left off the list survives an uninstall, so a site that removes
// the module and later reinstalls it finds a stranger's mail still sitting
// there; a name on the list that no migration ever creates is a silent no-op
// that makes the list look more complete than it is. Both are the sort of thing
// nobody notices for a year, so they are asserted here on every test run
// instead - the migrations and the manifest are both on disk, so this needs no
// database and can never be skipped.

const MODULE_DIR = join(__dirname, '..')
const MIGRATIONS = join(MODULE_DIR, 'migrations')

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
}

function allMigrationSql(): string {
  return migrationFiles().map((f) => readFileSync(join(MIGRATIONS, f), 'utf8')).join('\n')
}

const manifest = JSON.parse(
  readFileSync(join(MODULE_DIR, 'cactus.module.json'), 'utf8'),
) as { tablePrefix: string; teardown: string[] }

/** Every table any migration creates. */
function declaredTables(): string[] {
  const sql = allMigrationSql()
  return [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([a-z0-9_]+)"/gi)]
    .map((m) => m[1])
    .filter((name): name is string => !!name)
}

/** Every foreign key one of our tables holds on another of our tables, as
 *  [child, parent]. Core's own tables (User) are not ours to order. */
function foreignKeys(): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8')

    // Inline, inside a CREATE TABLE: the child is whichever table block we are in.
    const blocks = sql.split(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"/i).slice(1)
    for (const block of blocks) {
      const child = block.slice(0, block.indexOf('"'))
      for (const m of block.matchAll(/REFERENCES\s+"([a-z0-9_]+)"/gi)) {
        if (m[1]) out.push([child, m[1]])
      }
    }

    // ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ... REFERENCES ...
    for (const m of sql.matchAll(
      /ALTER\s+TABLE\s+"([a-z0-9_]+)"\s+ADD\s+CONSTRAINT[\s\S]*?REFERENCES\s+"([a-z0-9_]+)"/gi,
    )) {
      if (m[1] && m[2]) out.push([m[1], m[2]])
    }
  }
  return out
}

describe('teardown', () => {
  it('names every table the migrations create, and nothing else', () => {
    const tables = [...new Set(declaredTables())].sort()
    expect(tables.length).toBeGreaterThan(0)
    expect([...manifest.teardown].sort()).toEqual(tables)
  })

  it('names only tables carrying this module’s prefix', () => {
    for (const table of manifest.teardown) {
      expect(table.startsWith(manifest.tablePrefix)).toBe(true)
    }
  })

  it('lists children before their parents', () => {
    const position = new Map(manifest.teardown.map((t, i) => [t, i]))
    for (const [child, parent] of foreignKeys()) {
      // A table pointing at itself is one drop either way.
      if (child === parent) continue
      // Core's tables are not in our list and are never dropped by us.
      if (!position.has(parent) || !position.has(child)) continue
      expect(
        position.get(child)!,
        `${child} references ${parent} and must be dropped first`,
      ).toBeLessThan(position.get(parent)!)
    }
  })
})

describe('the migrations, and what the backup harness can cope with', () => {
  it('introduces no sequence anywhere', () => {
    // A sequence is invisible to information_schema.tables, so a backup that is
    // not looking for one misses it, and a restored site hands out the number 1
    // again for something that was up in the thousands. This module owns none,
    // and the day it does, the backup's sequence handling is what to check
    // before this line is relaxed.
    const sql = allMigrationSql()
    expect(sql).not.toMatch(/\bBIGSERIAL\b|\bSERIAL\b|CREATE\s+SEQUENCE|GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY/i)
  })

  it('uses no dollar quoting, comments included', () => {
    // The backup round-trip harness skips any module whose migrations contain
    // one - splitSqlStatements is not dollar-quote aware - so a file with one
    // buys a green gate that never checked the columns it was meant to check.
    // This module has paid for that twice, both times from a comment.
    for (const file of migrationFiles()) {
      expect(readFileSync(join(MIGRATIONS, file), 'utf8'), file).not.toContain('$$')
    }
  })
})
