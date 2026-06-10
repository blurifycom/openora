#!/usr/bin/env node
/**
 * Scaffold-and-verify eval (WS5).
 *
 * Proves the v1 AC: scaffold a new module -> regen -> verify is green end-to-end.
 * Non-interactive; safe to run in CI (exits non-zero on any failure).
 *
 * Usage:
 *   pnpm eval:scaffold          # scaffold, verify, clean up
 *   pnpm eval:scaffold --keep   # leave generated files in place
 *
 * Requires a clean working tree (or --keep). On a dirty tree the cleanup step
 * prints a warning and skips; use `git status` to inspect.
 */

import { spawnSync, execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const keep = process.argv.includes('--keep');
const GROUP = 'player';
const MODULE = 'eval-tournament';

function run(cmd: string, args: string[]): void {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root });
  if (r.status !== 0) {
    console.error(`\nFAIL: "${cmd} ${args.join(' ')}" exited ${r.status ?? '?'}`);
    process.exit(r.status ?? 1);
  }
}

function untrackedAndModified(): Set<string> {
  const out = execSync('git status --porcelain', { cwd: root }).toString();
  const files = new Set<string>();
  for (const line of out.split('\n')) {
    const f = line
      .slice(3)
      .trim()
      .replace(/ -> .*/, '');
    if (f) files.add(f);
  }
  return files;
}

function cleanup(before: Set<string>): void {
  const after = untrackedAndModified();
  const added = [...after].filter((f) => !before.has(f));
  const modified = [...after].filter((f) => before.has(f));

  if (added.length === 0 && modified.length === 0) {
    console.log('\nNothing to clean up.');
    return;
  }

  console.log(`\nCleaning up (${added.length} new, ${modified.length} modified)...`);

  // Restore tracked modifications (extensions.config.ts, contract index, catalog, etc.)
  if (modified.length > 0) {
    spawnSync('git', ['checkout', '--', ...modified], { stdio: 'inherit', cwd: root });
  }

  // Remove new untracked paths
  for (const f of added) {
    spawnSync('git', ['clean', '-fd', '--', f], { stdio: 'inherit', cwd: root });
  }
}

// ---- main ----

const before = untrackedAndModified();
if (!keep && before.size > 0) {
  console.warn(
    `\nWARN: working tree has ${before.size} uncommitted change(s). ` +
      'Cleanup will only remove files added by this eval.\n',
  );
}

console.log(`\n=== eval:scaffold ${GROUP}/${MODULE} ===\n`);

// 1. Scaffold the module
run('pnpm', ['gen', 'module', GROUP, MODULE]);

// 2. Regen (drizzle migrations + RLS policies + OpenAPI + catalog)
run('pnpm', ['regen']);

// 3. Full verify (typecheck + boundaries lint + unit tests)
run('pnpm', ['verify']);

// 4. Assert the new module surfaces in the catalog
const catalogPath = join(root, 'docs', 'CATALOG.md');
if (existsSync(catalogPath)) {
  const catalog = readFileSync(catalogPath, 'utf8');
  if (!catalog.includes(MODULE)) {
    console.error(`\nFAIL: "${MODULE}" not found in docs/CATALOG.md after regen`);
    if (!keep) cleanup(before);
    process.exit(1);
  }
  console.log(`\nPASS: "${MODULE}" appears in CATALOG.md`);
}

console.log('\n=== eval:scaffold PASSED ===\n');

if (!keep) cleanup(before);
