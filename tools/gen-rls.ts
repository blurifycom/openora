#!/usr/bin/env node
/**
 * RLS policy coverage generator (ADR-0018). drizzle-kit emits table DDL but NOT
 * Row-Level Security policies, which are hand-authored (migrations 0006/0007). So
 * any newly added tenant-scoped table (eg from `pnpm gen module`) ships without a
 * policy and fails the rls-policy-coverage test until covered.
 *
 * This step closes that gap automatically: it enumerates every `tenantId` table
 * across the modules + the outbox (the same scan the coverage test uses), checks
 * which already have a `CREATE POLICY "<t>_tenant_isolation"` in the migrations,
 * and for any uncovered table emits ONE new idempotent migration (ENABLE + FORCE
 * RLS + guarded CREATE POLICY) plus its journal entry. No-op when all covered.
 *
 * Run via `pnpm gen:rls` (wired into `pnpm regen` after drizzle-kit generate).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
// The engine + central migration history live in @oss/core (ADR-0025).
const coreRoot = join(repoRoot, 'packages/core');
const centralDrizzleConfig = join(coreRoot, 'drizzle.config.ts');
const migrationsDir = join(coreRoot, 'drizzle/migrations');
const journalFile = join(migrationsDir, 'meta/_journal.json');

// Deliberately non-RLS tenant tables (must match the coverage test's exemptions).
const RLS_EXEMPT = new Set<string>(['user']);

// Match the coverage test: pgTable blocks that declare a `tenantId: text('tenantId')`.
function tenantTablesInFile(source: string): string[] {
  const tables: string[] = [];
  const re = /pgTable\(\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const tableName = match[1]!;
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
    if (/['"]?tenantId['"]?\s*:\s*text\(\s*['"]tenantId['"]/.test(body)) tables.push(tableName);
  }
  return tables;
}

// The schema files in the central migration history = the `schema:` array of the
// central drizzle.config.ts (resolved relative to packages/core). This is the same
// source of truth the rls-policy-coverage test uses - a core add-on/domain that
// ships tables is listed there; gated histories own their own config and are
// excluded by construction. See ADR-0018/0024/0025.
function centralSchemaFiles(): string[] {
  const config = readFileSync(centralDrizzleConfig, 'utf8');
  const arrayMatch = config.match(/schema:\s*\[([\s\S]*?)\]/);
  if (!arrayMatch) throw new Error('Could not find the `schema:` array in drizzle.config.ts');
  return [...arrayMatch[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((m) => resolve(coreRoot, m[1]!));
}

function collectTenantTables(): string[] {
  const tables = new Set<string>();
  for (const file of centralSchemaFiles()) {
    for (const t of tenantTablesInFile(readFileSync(file, 'utf8'))) {
      if (!RLS_EXEMPT.has(t)) tables.add(t);
    }
  }
  return [...tables].sort();
}

function allMigrationsSql(): string {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(migrationsDir, f), 'utf8'))
    .join('\n');
}

function rlsBlock(table: string): string {
  return [
    `-- ${table}`,
    `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint`,
    `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint`,
    `DO $$`,
    `BEGIN`,
    `  IF NOT EXISTS (`,
    `    SELECT 1 FROM pg_policies`,
    `    WHERE schemaname = 'public' AND tablename = '${table}'`,
    `      AND policyname = '${table}_tenant_isolation'`,
    `  ) THEN`,
    `    CREATE POLICY "${table}_tenant_isolation" ON "${table}" FOR ALL`,
    `      USING ("tenantId" = current_setting('app.tenant_id', true))`,
    `      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));`,
    `  END IF;`,
    `END`,
    `$$;`,
  ].join('\n');
}

type JournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};
type Journal = {
  version: string;
  dialect: string;
  entries: JournalEntry[];
};

function main(): void {
  const tables = collectTenantTables();
  const sql = allMigrationsSql();
  const uncovered = tables.filter(
    (t) => !new RegExp(`CREATE POLICY "${t}_tenant_isolation" ON "${t}"`).test(sql),
  );

  if (uncovered.length === 0) {
    console.log('[rls] all tenant tables covered, nothing to generate');
    return;
  }

  const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as Journal;
  const last = journal.entries[journal.entries.length - 1];
  const idx = (last?.idx ?? -1) + 1;
  const idxStr = String(idx).padStart(4, '0');
  const suffix =
    uncovered.length === 1 ? uncovered[0]! : `${uncovered[0]!}_plus_${uncovered.length - 1}`;
  const tag = `${idxStr}_rls_${suffix}`;
  const when = Math.max((last?.when ?? 0) + 1, Date.now());

  const header = [
    `-- ADR-0018: auto-generated RLS tenant-isolation policies for newly added tables.`,
    `-- Emitted by tools/gen-rls.ts during \`pnpm regen\` (drizzle-kit does not emit`,
    `-- policies). Idempotent: ENABLE/FORCE are no-ops if set; the policy is created`,
    `-- only when absent. Runs under the migration owner/admin role, not oss_app.`,
    ``,
  ].join('\n');

  writeFileSync(
    join(migrationsDir, `${tag}.sql`),
    `${header}${uncovered.map(rlsBlock).join('\n--> statement-breakpoint\n\n')}\n`,
  );

  journal.entries.push({ idx, version: '7', when, tag, breakpoints: true });
  writeFileSync(journalFile, `${JSON.stringify(journal, null, 2)}\n`);

  console.log(`[rls] wrote ${tag}.sql covering: ${uncovered.join(', ')}`);
}

main();
