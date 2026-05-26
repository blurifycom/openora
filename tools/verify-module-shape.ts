#!/usr/bin/env node
/**
 * Structural-shape guard. Asserts every module under packages/modules/<group>/<name>
 * still matches the canonical shape the scaffolder produces, so an agent can't quietly
 * delete or relocate a required piece mid-task ("constraint decay"). Runs in `pnpm verify`.
 *
 * Required per module: src/plugin.ts (exporting definePlugin), src/schemas/index.ts,
 * src/service/, src/router/index.ts, AGENTS.md. (src/schema/index.ts is optional - some
 * modules own no tables and only read others' via the /schema subpath.)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const GROUPS = ['player', 'backoffice', 'platform'] as const;

type Check = { rel: string; ok: boolean; hint: string };

function checkModule(group: string, name: string, dir: string): Check[] {
  const file = (rel: string) => existsSync(join(dir, rel));
  const dirExists = (rel: string) => existsSync(join(dir, rel)) && statSync(join(dir, rel)).isDirectory();
  const pluginSrc = file('src/plugin.ts') ? readFileSync(join(dir, 'src/plugin.ts'), 'utf8') : '';
  return [
    { rel: 'src/plugin.ts', ok: file('src/plugin.ts'), hint: 'run /scaffold-module to regenerate the skeleton' },
    {
      rel: 'src/plugin.ts exports definePlugin',
      ok: /definePlugin\s*\(/.test(pluginSrc),
      hint: "plugin.ts must `export default definePlugin({ id, register })`",
    },
    { rel: 'src/schemas/index.ts', ok: file('src/schemas/index.ts'), hint: 'module-local Zod schemas live here' },
    { rel: 'src/service/', ok: dirExists('src/service'), hint: 'business logic lives in a Nest-injectable service' },
    { rel: 'src/router/index.ts', ok: file('src/router/index.ts'), hint: 'the oRPC router contract + handlers live here' },
    { rel: 'AGENTS.md', ok: file('AGENTS.md'), hint: 'every module ships an AGENTS.md (extension points, do/dont, Done-when)' },
  ];
}

const failures: string[] = [];
let moduleCount = 0;

for (const group of GROUPS) {
  const groupDir = join(repoRoot, 'packages', 'modules', group);
  if (!existsSync(groupDir)) continue;
  for (const name of readdirSync(groupDir)) {
    const dir = join(groupDir, name);
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'src', 'plugin.ts'))) continue;
    moduleCount += 1;
    for (const c of checkModule(group, name, dir)) {
      if (!c.ok) {
        failures.push(`  packages/modules/${group}/${name}: missing ${c.rel}\n      -> ${c.hint}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`[FAIL] module-shape: ${failures.length} structural problem(s):\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`[PASS] module-shape: ${moduleCount} modules match the canonical shape.`);
