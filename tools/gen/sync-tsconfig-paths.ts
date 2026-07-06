// Derives packages/core/tsconfig.json `compilerOptions.paths` from that package's
// `exports` map - the single source of truth for the public subpath surface. Keeps
// the compiler's source resolution in lockstep with the runtime resolver so the two
// can never drift. Run via `pnpm regen`; `--check` fails on drift (CI drift gate).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const coreDir = join(import.meta.dirname, '..', '..', 'packages', 'core');
const pkgPath = join(coreDir, 'package.json');
const tsconfigPath = join(coreDir, 'tsconfig.json');

type ExportEntry = string | { types?: string; import?: string; default?: string };

function typesTarget(entry: ExportEntry): string | undefined {
  const target = typeof entry === 'string' ? entry : entry.types;
  return target?.endsWith('.d.ts') ? target : undefined;
}

function derivePaths(exports: Record<string, ExportEntry>): Record<string, [string]> {
  return Object.fromEntries(
    Object.entries(exports).flatMap(([key, entry]) => {
      if (key === '.') return [];
      const target = typesTarget(entry);
      if (!target) return [];
      const src = target.replace(/^\.\/dist\//, './src/').replace(/\.d\.ts$/, '.ts');
      return [[`@blurifycom/core/${key.slice(2)}`, [src] as [string]] as const];
    }),
  );
}

function renderPaths(paths: Record<string, [string]>): string {
  return Object.entries(paths)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([alias, [src]]) => `      ${JSON.stringify(alias)}: [${JSON.stringify(src)}]`)
    .join(',\n');
}

// Canonical (sorted, key-value) form so formatting-only diffs - eg oxfmt wrapping a
// long path array across lines - never count as drift; only actual content changes do.
function canonicalize(paths: Record<string, [string]>): string {
  return JSON.stringify(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b)));
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { exports: Record<string, ExportEntry> };
const current = readFileSync(tsconfigPath, 'utf8');
const wantedPaths = derivePaths(pkg.exports);

// Replace the whole `"paths": { ... }` block (closed at 4-space indent) in place so
// every other field keeps its exact formatting.
const next = current.replace(
  /"paths": \{[\s\S]*?\n {4}\}/,
  `"paths": {\n${renderPaths(wantedPaths)}\n    }`,
);

if (process.argv.includes('--check')) {
  const actualPaths =
    (JSON.parse(current) as { compilerOptions?: { paths?: Record<string, [string]> } })
      .compilerOptions?.paths ?? {};
  if (canonicalize(actualPaths) !== canonicalize(wantedPaths)) {
    console.error('tsconfig paths are out of sync with package.json exports. Run `pnpm regen`.');
    process.exit(1);
  }
  console.log('tsconfig paths in sync.');
} else {
  if (current !== next) writeFileSync(tsconfigPath, next);
  console.log('synced tsconfig paths from exports.');
}
