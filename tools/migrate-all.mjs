#!/usr/bin/env node
// Unified migration runner across the core history + every add-on package's own
// history. Each set tracks its applied migrations in its own table
// (__drizzle_migrations[_addon_<name>]) so the sets never collide on one DB.
//
// Order: core first (it owns the shared substrate - identity/user, wallet, the
// `player` table, etc.), then each present add-on package. An add-on package with
// no drizzle.config (e.g. player-management, which reads the core `player` table and
// owns no tables) is skipped automatically.
//
// See docs/adr/0020-editions-and-add-on-modules.md. NOTE: activating the add-on
// sets on an existing DB requires the one-time re-baseline described in the ADR
// (the core history still creates the add-on tables until then).
import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const addonDir = join(repoRoot, 'packages', 'addons');

function run(filter, script) {
  process.stdout.write(`\n> migrate ${filter} (${script})\n`);
  execFileSync('pnpm', ['-F', filter, script], { cwd: repoRoot, stdio: 'inherit' });
}

// 1) Core history.
run('@oss/db', 'migrate');

// 2) Each add-on package that owns tables (has a drizzle.config.ts).
const addonPackages = existsSync(addonDir)
  ? readdirSync(addonDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => existsSync(join(addonDir, d.name, 'drizzle.config.ts')))
      .map((d) => d.name)
  : [];

for (const name of addonPackages) {
  run(`@oss-addons/${name}`, 'db:migrate');
}

process.stdout.write(`\nDone: core + ${addonPackages.length} add-on migration set(s) applied.\n`);
