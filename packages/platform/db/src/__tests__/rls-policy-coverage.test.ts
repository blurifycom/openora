import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// I3 (ADR-0018): a CI guard that every tenant-scoped table is RLS-covered. It
// enumerates every Drizzle pgTable that declares a `tenantId` column across the
// modules and the platform db (the outbox), then asserts each table has the full
// ENABLE + FORCE ROW LEVEL SECURITY + tenant-isolation policy in the hand-authored
// migrations SQL. This would have caught the user_limit / notification leak (C1):
// a tenant table that ships without a policy fails this test.

const here = dirname(fileURLToPath(import.meta.url));
// .../packages/platform/db/src/__tests__ -> repo root is five levels up.
const repoRoot = resolve(here, '../../../../..');
const modulesRoot = join(repoRoot, 'packages/modules');
const migrationsDir = join(repoRoot, 'packages/platform/db/drizzle/migrations');
const outboxSchema = join(repoRoot, 'packages/platform/db/src/outbox/schema.ts');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

// Extract `pgTable('name', { ... })` blocks that declare a tenantId column. We
// scan the brace-balanced body of each pgTable call so a tenantId in one table
// is not attributed to a neighbour.
function tenantTablesInFile(source: string): string[] {
  const tables: string[] = [];
  const re = /pgTable\(\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const tableName = match[1]!;
    // Find the first `{` after the table name and walk to its matching `}`.
    const braceStart = source.indexOf('{', re.lastIndex);
    if (braceStart === -1) continue;
    let depth = 0;
    let end = braceStart;
    for (let i = braceStart; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = source.slice(braceStart, end + 1);
    if (/['"]?tenantId['"]?\s*:\s*text\(\s*['"]tenantId['"]/.test(body)) {
      tables.push(tableName);
    }
  }
  return tables;
}

// Tables that carry a tenantId column but are DELIBERATELY not RLS-scoped, with
// the documented reason. The `user` table must be readable before any tenant
// context exists (auth resolves the user, then derives the tenant) - it is only
// ever touched on the admin/system path during request bootstrap (ADR-0018).
const RLS_EXEMPT = new Set<string>(['user']);

function collectTenantTables(): string[] {
  const files = [...walk(modulesRoot), outboxSchema];
  const tables = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const t of tenantTablesInFile(source)) {
      if (!RLS_EXEMPT.has(t)) tables.add(t);
    }
  }
  return [...tables].sort();
}

function migrationsSql(): string {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(migrationsDir, f), 'utf8'))
    .join('\n');
}

describe('RLS policy coverage (ADR-0018 I3)', () => {
  const tenantTables = collectTenantTables();
  const sql = migrationsSql();

  it('finds the known tenant-scoped tables (sanity)', () => {
    // A non-empty discovery, including the two C1-fixed tables, guards against the
    // scanner silently matching nothing (which would make the assertions vacuous).
    expect(tenantTables.length).toBeGreaterThan(10);
    expect(tenantTables).toContain('user_limit');
    expect(tenantTables).toContain('notification');
    expect(tenantTables).toContain('wallet');
  });

  it.each(collectTenantTables())('table "%s" has ENABLE + FORCE RLS + a tenant policy', (table) => {
    const enable = new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`).test(sql);
    const force = new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`).test(sql);
    // The policy may be a bare CREATE POLICY (0006) or a guarded CREATE inside a
    // DO block (0007) - both contain `CREATE POLICY "<table>_tenant_isolation"`.
    const policy = new RegExp(`CREATE POLICY "${table}_tenant_isolation" ON "${table}"`).test(sql);

    expect(enable, `${table}: missing ENABLE ROW LEVEL SECURITY`).toBe(true);
    expect(force, `${table}: missing FORCE ROW LEVEL SECURITY`).toBe(true);
    expect(policy, `${table}: missing tenant-isolation policy`).toBe(true);
  });
});
