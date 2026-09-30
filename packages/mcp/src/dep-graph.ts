import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

/**
 * Who imports what, per repo-relative file, built from the repo's own dependency-cruiser config
 * (the one its boundary check runs). Answers "what else can this change break" without reading
 * the code: walk `dependents` up from a changed file.
 */
export type DepGraph = {
  generatedAt: string;
  commit: string | null;
  /** file -> files that import it */
  dependents: Record<string, string[]>;
  /** file -> `@openora/*` specifiers it imports from outside the repo (consumer repos only) */
  platform: Record<string, string[]>;
  /** source file -> the public `@openora/*` specifier it is published as (platform repo only) */
  entryPoints: Record<string, string>;
};

type CruiseDependency = {
  module: string;
  resolved: string;
  coreModule: boolean;
  couldNotResolve: boolean;
};
type CruiseModule = CruiseDependency & { source: string; dependencies: CruiseDependency[] };

const WORKSPACE_ROOTS = ['apps', 'packages'];
const CONFIG = '.dependency-cruiser.cjs';

function cruise(cwd: string, targets: string[]): CruiseModule[] {
  const out = execFileSync(
    'pnpm',
    ['exec', 'depcruise', ...targets, '--config', CONFIG, '--output-type', 'json'],
    { cwd, maxBuffer: 512 * 1024 * 1024 },
  );
  return (JSON.parse(out.toString()) as { modules: CruiseModule[] }).modules;
}

// A consumer repo keeps one config per workspace; the platform repo keeps one at the root.
function cruiseRuns(root: string): { dir: string; targets: string[] }[] {
  const workspaces = WORKSPACE_ROOTS.filter((r) => existsSync(join(root, r))).flatMap((r) =>
    readdirSync(join(root, r))
      .map((name) => `${r}/${name}`)
      .filter((dir) => existsSync(join(root, dir, CONFIG))),
  );
  if (workspaces.length > 0) {
    return workspaces.map((dir) => ({
      dir,
      targets: [existsSync(join(root, dir, 'src')) ? 'src' : '.'],
    }));
  }
  if (!existsSync(join(root, CONFIG))) {
    throw new Error(`No ${CONFIG} at ${root} or in any of ${WORKSPACE_ROOTS.join('/')}/*`);
  }
  return [{ dir: '.', targets: WORKSPACE_ROOTS.filter((r) => existsSync(join(root, r))) }];
}

// `exports` point at dist; the graph speaks source, so map each entry back to its src file.
function publishedEntryPoints(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const packagesDir = join(root, 'packages');
  if (!existsSync(packagesDir)) {
    return entries;
  }
  for (const name of readdirSync(packagesDir)) {
    const manifestPath = join(packagesDir, name, 'package.json');
    if (!existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name?: string;
      private?: boolean;
      exports?: Record<string, unknown>;
    };
    if (!manifest.name?.startsWith('@openora/') || manifest.private) {
      continue;
    }
    for (const [key, target] of Object.entries(manifest.exports ?? {})) {
      const importPath =
        typeof target === 'string' ? target : (target as { import?: string } | null)?.import;
      const dist = importPath?.match(/^\.\/dist\/(.+)\.js$/)?.[1];
      if (!dist) {
        continue;
      }
      const source = ['ts', 'tsx']
        .map((ext) => `packages/${name}/src/${dist}.${ext}`)
        .find((file) => existsSync(join(root, file)));
      if (source) {
        entries[source] = manifest.name + key.slice(1);
      }
    }
  }
  return entries;
}

export function buildDepGraph(root: string): DepGraph {
  const dependents: Record<string, Set<string>> = {};
  const platform: Record<string, Set<string>> = {};
  for (const { dir, targets } of cruiseRuns(root)) {
    const toRepoPath = (source: string) => posix.normalize(`${dir}/${source}`);
    // Linked or installed @openora/* resolve outside the repo; the graph covers the repo's own files.
    const isInternal = (
      d: Pick<CruiseDependency, 'coreModule' | 'couldNotResolve'>,
      path: string,
    ) =>
      !d.coreModule &&
      !d.couldNotResolve &&
      !path.includes('node_modules/') &&
      !toRepoPath(path).startsWith('../');
    for (const module of cruise(join(root, dir), targets)) {
      if (!isInternal(module, module.source)) {
        continue;
      }
      const file = toRepoPath(module.source);
      for (const dependency of module.dependencies) {
        if (isInternal(dependency, dependency.resolved)) {
          (dependents[toRepoPath(dependency.resolved)] ??= new Set()).add(file);
        } else if (dependency.module.startsWith('@openora/')) {
          (platform[file] ??= new Set()).add(dependency.module);
        }
      }
    }
  }
  const sorted = (map: Record<string, Set<string>>) =>
    Object.fromEntries(
      Object.entries(map)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([file, values]) => [file, [...values].sort()]),
    );
  return {
    generatedAt: new Date().toISOString(),
    commit: process.env['CI_COMMIT_SHA'] ?? process.env['GITHUB_SHA'] ?? null,
    dependents: sorted(dependents),
    platform: sorted(platform),
    entryPoints: publishedEntryPoints(root),
  };
}

/** Transitive importers of `file`, up to `maxDepth` hops, nearest first. */
export function importersOf(graph: DepGraph, file: string, maxDepth: number): string[] {
  const depth = new Map([[file, 0]]);
  const queue = [file];
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    const level = depth.get(current) ?? 0;
    if (level >= maxDepth) {
      continue;
    }
    for (const importer of graph.dependents[current] ?? []) {
      if (!depth.has(importer)) {
        depth.set(importer, level + 1);
        queue.push(importer);
      }
    }
  }
  depth.delete(file);
  return [...depth.keys()];
}

export type Impact = {
  file: string;
  importers: string[];
  /** platform repo only: the public specifiers the change reaches */
  specifiers: string[];
  /** consumer files importing one of those specifiers, when a consumer graph is given */
  consumerFiles: string[];
};

/**
 * What a change to `file` can break. With a consumer graph, a platform file is followed through
 * the public entry points it reaches into the consumer files that import them - the cross-repo
 * half that no single-repo graph shows.
 */
export function impactOf(
  graph: DepGraph,
  file: string,
  maxDepth: number,
  consumer?: DepGraph,
): Impact {
  const importers = importersOf(graph, file, maxDepth);
  // Nearest first: a change reaches its own entry point before the barrels that re-export it.
  const specifiers = [...new Set([file, ...importers].flatMap((f) => graph.entryPoints[f] ?? []))];
  const rank = (specs: string[]) =>
    Math.min(...specs.map((s) => specifiers.indexOf(s)).filter((i) => i >= 0));
  const consumerFiles = consumer
    ? Object.entries(consumer.platform)
        .filter(([, specs]) => specs.some((s) => specifiers.includes(s)))
        .sort(([a, x], [b, y]) => rank(x) - rank(y) || a.localeCompare(b))
        .map(([f]) => f)
    : [];
  return { file, importers, specifiers, consumerFiles };
}
