import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
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
const dbRoot = join(repoRoot, 'packages/platform/db');
const migrationsDir = join(dbRoot, 'drizzle/migrations');
// The authoritative list of schema files in the CENTRAL migration history is the
// `schema:` array of the central drizzle.config.ts. Driving the scan from it (rather
// than walking add-on/domain dirs and guessing gated-ness) is correct regardless of
// layout - flat add-ons, single-member domains (src/schema), or multi-member domains
// (src/<member>/schema). Gated histories own their own config and are excluded by
// construction. See ADR-0020 / ADR-0024.
const centralDrizzleConfig = join(dbRoot, 'drizzle.config.ts');

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

// The schema files in the central migration history = the `schema:` array of the
// central drizzle.config.ts, resolved relative to the db package root. This is the
// source of truth: a core add-on or domain that ships tables is listed there; gated
// histories are not. Far more robust than walking dirs and inferring gated-ness.
function centralSchemaFiles(): string[] {
  const config = readFileSync(centralDrizzleConfig, 'utf8');
  const arrayMatch = config.match(/schema:\s*\[([\s\S]*?)\]/);
  if (!arrayMatch) throw new Error('Could not find the `schema:` array in drizzle.config.ts');
  const rels = [...arrayMatch[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!);
  return rels.map((rel) => resolve(dbRoot, rel));
}

function collectTenantTables(): string[] {
  const files = centralSchemaFiles();
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
