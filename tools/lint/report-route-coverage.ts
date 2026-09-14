#!/usr/bin/env node
/**
 * Route-coverage report. Lists every oRPC route no test file references, grouped by the
 * contract that declares it. Deliberately NOT part of `pnpm verify` and always exits 0:
 * it is a map of where the suite is thin, not a gate. Run it with
 * `pnpm report:route-coverage`.
 *
 * "Referenced" is coarse on purpose - a test mentioning the route's path prefix or its
 * procedure name counts. That over-reports coverage (a mention is not an assertion) and
 * never under-reports it, which is the right bias for a report nobody is forced to act
 * on: everything it prints is genuinely untouched.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

// Tracked files only, so build output and gitignored paths are excluded by construction.
// Filtering in JS rather than with a git pathspec: `**` is not a glob git ls-files honours.
const tracked = (dir: string, keep: (file: string) => boolean): string[] =>
  execSync(`git ls-files ${dir}`, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1e8 })
    .split('\n')
    .filter((file) => file !== '' && keep(file));

/** `procedureName: oc ... .route({ method: 'GET', path: '/x/{id}' })` */
const ROUTE = /(\w+):\s*oc[\s\S]{0,400}?\.route\(\{\s*method:\s*'(\w+)',\s*path:\s*'([^']+)'/g;

type Route = { name: string; method: string; path: string; contract: string };

function declaredRoutes(): Route[] {
  const contracts = tracked(
    'packages/core/src',
    (file) => file.includes('/contract/') && file.endsWith('.ts') && !file.includes('__tests__'),
  );
  return contracts.flatMap((file) => {
    const source = readFileSync(join(repoRoot, file), 'utf8');
    return [...source.matchAll(ROUTE)].map(([, name = '', method = '', path = '']) => ({
      name,
      method,
      path,
      contract: file,
    }));
  });
}

/** The leading literal segments of a path, i.e. everything before the first `{param}`. */
function staticPrefix(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split('/').filter(Boolean)) {
    if (segment.startsWith('{') || segment.startsWith(':')) {
      break;
    }
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

function main(): void {
  const routes = declaredRoutes();
  const tests = tracked('packages', (file) => file.endsWith('.test.ts'))
    .map((file) => readFileSync(join(repoRoot, file), 'utf8'))
    .join('\n');

  const untouched = routes.filter(
    (route) => !tests.includes(staticPrefix(route.path)) && !tests.includes(route.name),
  );

  const covered = routes.length - untouched.length;
  console.log(`[report] route coverage: ${covered}/${routes.length} routes referenced by a test`);
  if (untouched.length === 0) {
    return;
  }

  const byContract = new Map<string, Route[]>();
  for (const route of untouched) {
    byContract.set(route.contract, [...(byContract.get(route.contract) ?? []), route]);
  }
  for (const [contract, group] of [...byContract].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n${relative('packages/core/src', contract)} (${group.length})`);
    for (const route of group) {
      console.log(`  ${route.method.padEnd(6)} ${route.path}`);
    }
  }
}

main();
