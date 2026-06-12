#!/usr/bin/env node
// Unified migration runner across the core history + every premium package's own
// history. Each set tracks its applied migrations in its own table
// (__drizzle_migrations[_premium_<name>]) so the sets never collide on one DB.
//
// Order: core first (it owns the shared substrate - identity/user, wallet, the
// `player` table, etc.), then each present premium package. A premium package with
// no drizzle.config (e.g. player-management, which reads the core `player` table and
// owns no tables) is skipped automatically.
//
// See docs/adr/ADR-0020-editions-premium-modules.md. NOTE: activating the premium
// sets on an existing DB requires the one-time re-baseline described in the ADR
// (the core history still creates the premium tables until then).
import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const premiumDir = join(repoRoot, 'packages', 'premium');

function run(filter, script) {
  process.stdout.write(`\n> migrate ${filter} (${script})\n`);
  execFileSync('pnpm', ['-F', filter, script], { cwd: repoRoot, stdio: 'inherit' });
}

// 1) Core history.
run('@oss/db', 'migrate');

// 2) Each premium package that owns tables (has a drizzle.config.ts).
const premiumPackages = existsSync(premiumDir)
  ? readdirSync(premiumDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => existsSync(join(premiumDir, d.name, 'drizzle.config.ts')))
      .map((d) => d.name)
  : [];

for (const name of premiumPackages) {
  run(`@oss-premium/${name}`, 'db:migrate');
}

process.stdout.write(
  `\nDone: core + ${premiumPackages.length} premium migration set(s) applied.\n`,
);
