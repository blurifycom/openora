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
      if (key === '.') {
        return [];
      }
      const target = typesTarget(entry);
      if (!target) {
        return [];
      }
      const src = target.replace(/^\.\/dist\//, './src/').replace(/\.d\.ts$/, '.ts');
      return [[`@openora/core/${key.slice(2)}`, [src] as [string]] as const];
    }),
  );
}

function renderPaths(paths: Record<string, [string]>): string {
  return Object.entries(paths)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([alias, [src]]) => `      ${JSON.stringify(alias)}: [${JSON.stringify(src)}]`)
    .join(',\n');
}

function canonicalize(paths: Record<string, [string]>): string {
  return JSON.stringify(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b)));
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { exports: Record<string, ExportEntry> };
const current = readFileSync(tsconfigPath, 'utf8');
const wantedPaths = derivePaths(pkg.exports);

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
  if (current !== next) {
    writeFileSync(tsconfigPath, next);
  }
  console.log('synced tsconfig paths from exports.');
}
