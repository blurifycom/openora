#!/usr/bin/env node
/**
 * Structural-shape guard. After ADR-0025 the domains fold into @openora/core as
 * subpaths, so this asserts every folded domain under packages/core/src/<name>
 * still matches the canonical shape - an agent can't quietly delete or relocate a
 * required piece mid-task ("constraint decay"). Runs in `pnpm verify`.
 *
 * A "domain" is any dir under packages/core/src/ other than the engine zones
 * (contracts, server, react, scripts) and the cross-cutting shared zones (common,
 * testing - same exclusion as the oxlint boundaries/module-shape plugins). Single-slice
 * ones keep index.ts + plugin.ts
 * at their root (wallet, iam, audit, ...); multi-slice ones (casino: gaming/lobby;
 * engagement; pam) keep index.ts + per-slice plugin/contract/schema.
 *
 * Required per domain (checked against the @openora/core package.json exports):
 *   index.ts              - the domain slice root (its public API source)
 *   a contract subpath    - @openora/core exports "./<domain>/contract(s)..." (cross-domain
 *                           comms go through the published contract, never a sibling import)
 *   a runtime subpath     - @openora/core exports "./<domain>/plugin" | "./<domain>/server" |
 *                           "./<domain>/plugins/*" (the plugin host loads the domain through one)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
// Domains fold into @openora/core as subpaths. See ADR-0025.
const coreSrc = join(repoRoot, 'packages', 'core', 'src');
const engineDirs = new Set(['contracts', 'server', 'react', 'scripts', 'common', 'testing']);

type Check = { label: string; ok: boolean; hint: string };
type Pkg = { exports?: Record<string, unknown> };

const readPkg = (dir: string): Pkg | null => {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) {
    return null;
  }
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
  const moduleDirs = has('plugin.ts')
    ? [{ rel: '', dir }]
    : readdirSync(dir)
        .sort()
        .map((m) => ({ rel: `${m}/`, dir: join(dir, m) }))
        .filter(({ dir: m }) => statSync(m).isDirectory() && existsSync(join(m, 'plugin.ts')));

  return [
    ...moduleDirs.map(({ rel }) => ({
      label: `${rel}AGENTS.md`,
      ok: existsSync(join(dir, rel, 'AGENTS.md')),
      hint: 'every module ships an AGENTS.md (what it does, extension points, do/dont)',
    })),
    {
      label: 'index.ts (slice root)',
      ok: has('index.ts'),
      hint: 'the public API source under packages/core/src/<domain>/',
    },
    {
      label: `@openora/core exports "./${id}/contract(s)"`,
      ok: hasContract,
      hint: 'cross-domain communication goes through the published contract subpath of @openora/core',
    },
    {
      label: `@openora/core exports a runtime subpath ("./${id}/plugin" | "./${id}/server" | "./${id}/plugins/*")`,
      ok: hasRuntime,
      hint: 'the plugin host loads the domain through its plugin entry - export it from @openora/core',
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

const domains = results.filter((r) => r.kind === 'core/src').map((r) => r.name);
console.log(
  `[PASS] module-shape: ${domains.length} domains match the canonical shape ` +
    `(${domains.join(', ')}).`,
);
