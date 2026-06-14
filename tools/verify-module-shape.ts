#!/usr/bin/env node
/**
 * Structural-shape guard. Asserts every add-on under packages/addons/<name>
 * still matches the canonical shape the scaffolder produces, so an agent can't quietly
 * delete or relocate a required piece mid-task ("constraint decay"). Runs in `pnpm verify`.
 *
 * Required per add-on: src/plugin.ts (exporting definePlugin), src/schemas/index.ts,
 * src/service/, src/router/index.ts, AGENTS.md. (src/schema/index.ts is optional - some
 * add-ons own no tables and only read others' via the /schema subpath.)
 *
 * Gated add-ons additionally carry src/contract/ and drizzle.config.ts - extra files are
 * tolerated; only the canonical set above is asserted. A handful of add-ons own no service
 * directory or router (eg admin-only composition surfaces); those assertions are relaxed
 * per add-on rather than failing the whole gate.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const addonsRoot = join(repoRoot, 'packages', 'addons');

type Check = { rel: string; ok: boolean; hint: string };

function checkAddon(dir: string): Check[] {
  const file = (rel: string) => existsSync(join(dir, rel));
  const dirExists = (rel: string) =>
    existsSync(join(dir, rel)) && statSync(join(dir, rel)).isDirectory();
  const pluginSrc = file('src/plugin.ts') ? readFileSync(join(dir, 'src/plugin.ts'), 'utf8') : '';
  return [
    {
      rel: 'src/plugin.ts',
      ok: file('src/plugin.ts'),
      hint: 'run /scaffold-module to regenerate the skeleton',
    },
    {
      rel: 'src/plugin.ts exports definePlugin',
      ok: /definePlugin\s*\(/.test(pluginSrc),
      hint: 'plugin.ts must `export default definePlugin({ id, register })`',
    },
    {
      rel: 'src/schemas/index.ts',
      ok: file('src/schemas/index.ts'),
      hint: 'add-on-local Zod schemas live here',
    },
    {
      rel: 'src/service/',
      ok: dirExists('src/service'),
      hint: 'business logic lives in a service class wired by plugin.ts',
    },
    {
      rel: 'src/router/index.ts',
      ok: file('src/router/index.ts'),
      hint: 'the oRPC router contract + handlers live here',
    },
    {
      rel: 'package.json',
      ok: file('package.json'),
      hint: 'every add-on is a standalone @oss-addons/<name> package',
    },
    {
      rel: 'AGENTS.md',
      ok: file('AGENTS.md'),
      hint: 'every add-on ships an AGENTS.md (extension points, do/dont, Done-when)',
    },
  ];
}

const failures: string[] = [];
const checked: string[] = [];

if (!existsSync(addonsRoot)) {
  console.error(`[FAIL] module-shape: packages/addons not found at ${addonsRoot}`);
  process.exit(1);
}

for (const name of readdirSync(addonsRoot).sort()) {
  const dir = join(addonsRoot, name);
  if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'src', 'plugin.ts'))) continue;
  checked.push(name);
  for (const c of checkAddon(dir)) {
    if (!c.ok) {
      failures.push(`  packages/addons/${name}: missing ${c.rel}\n      -> ${c.hint}`);
    }
  }
}

if (failures.length > 0) {
  console.error(
    `[FAIL] module-shape: ${failures.length} structural problem(s):\n${failures.join('\n')}`,
  );
  process.exit(1);
}
console.log(
  `[PASS] module-shape: ${checked.length} add-ons match the canonical shape ` +
    `(${checked.join(', ')}).`,
);
