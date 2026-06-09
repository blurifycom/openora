#!/usr/bin/env node
/**
 * Module-boundary guard. Enforces the cross-module communication rule
 * (clean-architecture.md): a module may reach another module ONLY through the
 * three sanctioned paths - domain events (`EventBus`), shared contracts
 * (`@oss/shared-schemas` / oRPC), and read-only table reads via the
 * `@oss/modules/<group>/<name>/schema` subpath. Importing another module's root,
 * service, router, or any non-`schema` subpath is forbidden, because it couples
 * the modules so tightly they can never be extracted into separate services.
 *
 * Two levels:
 *   FAIL  - a cross-module import that is NOT the `/schema` subpath (root,
 *           /service, /router, ...). Hard error; breaks `pnpm verify`.
 *   WARN  - a cross-module `/schema` read. Allowed today, but it shares a table
 *           across a module boundary, which blocks extracting either module to
 *           its own database. Listed so the coupling is visible and can migrate
 *           to an event or a command port (see ADR on data ownership).
 *
 * Runs in `pnpm verify`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const modulesRoot = join(repoRoot, 'packages', 'modules');
const GROUPS = ['player', 'backoffice', 'platform'] as const;

// Matches `@oss/modules/<group>/<name>` with an optional `/<subpath...>`, in both
// static imports and dynamic import()/export-from forms.
const IMPORT_RE =
  /from\s+['"]@oss\/modules\/([a-z-]+)\/([a-z0-9-]+)(\/[^'"]+)?['"]|import\(\s*['"]@oss\/modules\/([a-z-]+)\/([a-z0-9-]+)(\/[^'"]+)?['"]/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'dist' || entry === 'node_modules' || entry === '__tests__') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const failures: string[] = [];
const warnings: string[] = [];
let fileCount = 0;

for (const group of GROUPS) {
  const groupDir = join(modulesRoot, group);
  if (!existsSync(groupDir)) continue;
  for (const name of readdirSync(groupDir)) {
    const moduleDir = join(groupDir, name);
    const srcDir = join(moduleDir, 'src');
    if (!statSync(moduleDir).isDirectory() || !existsSync(srcDir)) continue;

    for (const file of walk(srcDir)) {
      fileCount += 1;
      const src = readFileSync(file, 'utf8');
      const rel = relative(repoRoot, file);
      for (const m of src.matchAll(IMPORT_RE)) {
        const g = m[1] ?? m[4];
        const n = m[2] ?? m[5];
        const sub = (m[3] ?? m[6] ?? '').replace(/^\//, '');
        if (g === group && n === name) continue; // self-import: fine
        const target = `@oss/modules/${g}/${n}${sub ? '/' + sub : ''}`;
        if (sub === 'schema') {
          warnings.push(
            `  ${rel}\n      reads ${target} (cross-module table read - migrate to event/command before extraction)`,
          );
        } else {
          failures.push(
            `  ${rel}\n      imports ${target}\n      -> only the \`/schema\` subpath may cross a module boundary; use events/contracts instead`,
          );
        }
      }
    }
  }
}

if (warnings.length > 0) {
  console.warn(
    `[WARN] module-boundaries: ${warnings.length} cross-module table read(s):\n${warnings.join('\n')}`,
  );
}
if (failures.length > 0) {
  console.error(
    `[FAIL] module-boundaries: ${failures.length} illegal cross-module import(s):\n${failures.join('\n')}`,
  );
  process.exit(1);
}
console.log(
  `[PASS] module-boundaries: ${fileCount} files clean (${warnings.length} table-read warning(s)).`,
);
