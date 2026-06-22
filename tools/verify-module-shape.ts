#!/usr/bin/env node
/**
 * Structural-shape guard. After ADR-0025 the domains fold into @blurifycom/core as
 * subpaths, so this asserts every folded domain under packages/core/src/<name>
 * still matches the canonical shape - an agent can't quietly delete or relocate a
 * required piece mid-task ("constraint decay"). Runs in `pnpm verify`.
 *
 * A "domain" is any dir under packages/core/src/ other than the engine zones
 * (contracts, server, react, scripts). Single-slice ones keep index.ts + plugin.ts
 * at their root (wallet, iam, audit, ...); multi-slice ones (casino: gaming/lobby/
 * aggregator; engagement; pam) keep index.ts + per-slice plugin/contract/schema.
 *
 * Required per domain (checked against the @blurifycom/core package.json exports):
 *   index.ts              - the domain slice root (its public API source)
 *   a contract subpath    - @blurifycom/core exports "./<domain>/contract(s)..." (cross-domain
 *                           comms go through the published contract, never a sibling import)
 *   a runtime subpath     - @blurifycom/core exports "./<domain>/plugin" | "./<domain>/server" |
 *                           "./<domain>/plugins/*" (the plugin host loads the domain through one)
 *
 * Premium add-on packages (packages/addons/*, currently none - ADR-0025) keep their own
 * canon and are checked only when the folder ships any.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// Domains fold into @blurifycom/core as subpaths. See ADR-0025.
const coreSrc = join(repoRoot, 'packages', 'core', 'src');
const engineDirs = new Set(['contracts', 'server', 'react', 'scripts']);
const addonsRoot = join(repoRoot, 'packages', 'addons');

type Check = { label: string; ok: boolean; hint: string };
type Pkg = { exports?: Record<string, unknown> };

const readPkg = (dir: string): Pkg | null => {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Pkg;
  } catch {
    return null;
  }
};

const coreExports = (readPkg(join(repoRoot, 'packages', 'core'))?.exports ?? {}) as Record<
  string,
  unknown
>;

function checkDomain(dir: string, id: string): Check[] {
  const has = (rel: string) => existsSync(join(dir, rel));
  const keys = Object.keys(coreExports);
  const hasContract = keys.some(
    (k) => k === `./${id}/contract` || k.startsWith(`./${id}/contract`),
  );
  const hasRuntime = keys.some(
    (k) => k === `./${id}/plugin` || k === `./${id}/server` || k.startsWith(`./${id}/plugins/`),
  );

  return [
    {
      label: 'index.ts (slice root)',
      ok: has('index.ts'),
      hint: 'the public API source under packages/core/src/<domain>/',
    },
    {
      label: `@blurifycom/core exports "./${id}/contract(s)"`,
      ok: hasContract,
      hint: 'cross-domain communication goes through the published contract subpath of @blurifycom/core',
    },
    {
      label: `@blurifycom/core exports a runtime subpath ("./${id}/plugin" | "./${id}/server" | "./${id}/plugins/*")`,
      ok: hasRuntime,
      hint: 'the plugin host loads the domain through its plugin entry - export it from @blurifycom/core',
    },
  ];
}

function checkAddon(dir: string): Check[] {
  const file = (rel: string) => existsSync(join(dir, rel));
  const dirExists = (rel: string) =>
    existsSync(join(dir, rel)) && statSync(join(dir, rel)).isDirectory();
  const pluginSrc = file('src/plugin.ts') ? readFileSync(join(dir, 'src/plugin.ts'), 'utf8') : '';
  return [
    {
      label: 'src/plugin.ts',
      ok: file('src/plugin.ts'),
      hint: 'run /scaffold-module to regenerate the skeleton',
    },
    {
      label: 'src/plugin.ts exports definePlugin',
      ok: /definePlugin\s*\(/.test(pluginSrc),
      hint: 'plugin.ts must `export default definePlugin({ id, register })`',
    },
    {
      label: 'src/schemas/index.ts',
      ok: file('src/schemas/index.ts'),
      hint: 'add-on-local Zod schemas live here',
    },
    {
      label: 'src/service/',
      ok: dirExists('src/service'),
      hint: 'business logic lives in a service class wired by plugin.ts',
    },
    {
      label: 'src/router/index.ts',
      ok: file('src/router/index.ts'),
      hint: 'the oRPC router contract + handlers live here',
    },
    {
      label: 'package.json',
      ok: file('package.json'),
      hint: 'every add-on is a standalone @blurifycom-addons/<name> package',
    },
    {
      label: 'AGENTS.md',
      ok: file('AGENTS.md'),
      hint: 'every add-on ships an AGENTS.md (extension points, do/dont, Done-when)',
    },
  ];
}

const collect = (
  kind: string,
  root: string,
  check: (dir: string, name: string) => Check[],
  gate: (dir: string, name: string) => boolean,
) =>
  !existsSync(root)
    ? []
    : readdirSync(root)
        .sort()
        .map((name) => ({ kind, name, dir: join(root, name) }))
        .filter(({ dir, name }) => statSync(dir).isDirectory() && gate(dir, name))
        .map(({ kind, name, dir }) => ({ kind, name, checks: check(dir, name) }));

const results = [
  ...collect(
    'core/src',
    coreSrc,
    checkDomain,
    (dir, name) => !engineDirs.has(name) && existsSync(join(dir, 'index.ts')),
  ),
  ...collect('addons', addonsRoot, checkAddon, (dir) => existsSync(join(dir, 'src', 'plugin.ts'))),
];

const failures = results.flatMap(({ kind, name, checks }) =>
  checks
    .filter((c) => !c.ok)
    .map((c) => `  packages/${kind}/${name}: missing ${c.label}\n      -> ${c.hint}`),
);

if (failures.length > 0) {
  console.error(
    `[FAIL] module-shape: ${failures.length} structural problem(s):\n${failures.join('\n')}`,
  );
  process.exit(1);
}

const byKind = (kind: string) => results.filter((r) => r.kind === kind).map((r) => r.name);
const domains = byKind('core/src');
const addons = byKind('addons');
console.log(
  `[PASS] module-shape: ${domains.length} domains match the canonical shape ` +
    `(${domains.join(', ')})` +
    (addons.length ? `; ${addons.length} add-ons (${addons.join(', ')}).` : '.'),
);
