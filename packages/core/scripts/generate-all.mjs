// Generates migrations for every per-module drizzle.config.ts under src/. Each config uses
// paths relative to its own dir (./schema, ./drizzle/migrations), so we run drizzle-kit with
// cwd set to the config's directory. Discovery means a new module needs no wiring here - just
// drop a drizzle.config.ts next to its schema. No DB connection required (generate diffs the
// schema against its snapshot). See ADR-0027.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const core = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(core, 'src');

// Local bin, NOT `pnpm exec` (which triggers a recursive workspace run from a nested cwd).
const bin = [
  join(core, 'node_modules/.bin/drizzle-kit'),
  join(core, '../../node_modules/.bin/drizzle-kit'),
].find(existsSync);
if (!bin) {
  throw new Error('drizzle-kit binary not found in node_modules/.bin');
}

const dirs = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) {
      if (name === 'drizzle.config.ts') {
        dirs.push(dir);
      }
      continue;
    }
    walk(p);
  }
};
walk(src);
dirs.sort();

for (const dir of dirs) {
  const rel = dir.replace(`${core}/`, '');
  process.stdout.write(`\n> drizzle-kit generate (${rel})\n`);
  execFileSync(bin, ['generate'], { cwd: dir, stdio: 'inherit' });
}

process.stdout.write(`\nDone: generated ${dirs.length} module migration set(s).\n`);
