import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDepGraph, impactOf, type DepGraph } from '../dep-graph.js';

const workspaceBin = resolve(import.meta.dirname, '../../../../node_modules/.bin');

const base = mkdtempSync(join(tmpdir(), 'dep-graph-'));
const repo = join(base, 'repo');
const outside = join(base, 'outside');

function write(root: string, file: string, text: string) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

let originalPath: string | undefined;

beforeAll(() => {
  originalPath = process.env['PATH'];
  process.env['PATH'] = `${workspaceBin}:${originalPath ?? ''}`;
  write(repo, '.dependency-cruiser.cjs', 'module.exports = { options: {} };\n');
  write(
    repo,
    'packages/lib/package.json',
    JSON.stringify({
      name: '@openora/lib',
      exports: {
        '.': { import: './dist/index.js' },
        './thing': { import: './dist/thing.js' },
        './missing': { import: './dist/missing.js' },
      },
    }),
  );
  write(
    repo,
    'packages/private/package.json',
    JSON.stringify({
      name: '@openora/private',
      private: true,
      exports: { '.': { import: './dist/index.js' } },
    }),
  );
  write(repo, 'packages/private/src/index.ts', 'export const p = 1;\n');
  write(repo, 'packages/lib/src/index.ts', "import { thing } from './thing';\nexport { thing };\n");
  write(
    repo,
    'packages/lib/src/thing.ts',
    "import { leaf } from './leaf';\nimport { out } from '../../../../outside/lib';\nimport { readFileSync } from 'node:fs';\nexport const thing = [leaf, out, readFileSync];\n",
  );
  write(repo, 'packages/lib/src/leaf.ts', 'export const leaf = 1;\n');
  write(
    repo,
    'packages/lib/src/user.ts',
    "import { thing } from './thing';\nimport { leaf } from './leaf';\nexport const u = [thing, leaf];\n",
  );
  write(outside, 'lib.ts', 'export const out = 1;\n');
});

afterAll(() => {
  if (originalPath === undefined) {
    delete process.env['PATH'];
  } else {
    process.env['PATH'] = originalPath;
  }
  rmSync(base, { recursive: true, force: true });
});

describe('buildDepGraph', () => {
  it('maps a published entry point back to its source file', () => {
    const graph = buildDepGraph(repo);
    expect(graph.entryPoints).toEqual({
      'packages/lib/src/index.ts': '@openora/lib',
      'packages/lib/src/thing.ts': '@openora/lib/thing',
    });
  });

  it('ignores imports that resolve outside the repo', () => {
    const graph = buildDepGraph(repo);
    const files = [...Object.keys(graph.dependents), ...Object.values(graph.dependents).flat()];
    expect(files.length).toBeGreaterThan(0);
    expect(
      files.some((f) => f.startsWith('..') || f.includes('outside') || f.includes('node:')),
    ).toBe(false);
  });

  it('records an edge for each relative import', () => {
    const graph = buildDepGraph(repo);
    expect(graph.dependents['packages/lib/src/thing.ts']).toEqual([
      'packages/lib/src/index.ts',
      'packages/lib/src/user.ts',
    ]);
    expect(graph.dependents['packages/lib/src/leaf.ts']).toEqual([
      'packages/lib/src/thing.ts',
      'packages/lib/src/user.ts',
    ]);
  });
});

const chain: DepGraph = {
  generatedAt: '',
  commit: null,
  dependents: {
    'a.ts': ['b.ts', 'c.ts'],
    'b.ts': ['d.ts'],
    'c.ts': ['d.ts'],
    'd.ts': ['e.ts'],
  },
  platform: {},
  entryPoints: {},
};

describe('impactOf', () => {
  it('returns every transitive dependant of a file', () => {
    const { importers } = impactOf(chain, 'a.ts', 10);
    expect([...importers].sort()).toEqual(['b.ts', 'c.ts', 'd.ts', 'e.ts']);
  });

  it('returns nearest dependants first and stops at max depth', () => {
    expect(impactOf(chain, 'a.ts', 1).importers).toEqual(['b.ts', 'c.ts']);
    expect(impactOf(chain, 'a.ts', 2).importers).toEqual(['b.ts', 'c.ts', 'd.ts']);
  });

  it('terminates on an import cycle', () => {
    const cyclic: DepGraph = {
      ...chain,
      dependents: { 'a.ts': ['b.ts'], 'b.ts': ['c.ts'], 'c.ts': ['a.ts'] },
    };
    const { importers } = impactOf(cyclic, 'a.ts', 100);
    expect([...importers].sort()).toEqual(['b.ts', 'c.ts']);
  });

  it('returns nothing for a file nobody imports', () => {
    const result = impactOf(chain, 'e.ts', 10);
    expect(result.importers).toEqual([]);
    expect(result.specifiers).toEqual([]);
    expect(result.consumerFiles).toEqual([]);
  });

  it('reaches the public entry points and the consumer files importing them', () => {
    const graph: DepGraph = {
      ...chain,
      entryPoints: { 'd.ts': '@openora/lib/d', 'a.ts': '@openora/lib/a' },
    };
    const consumer: DepGraph = {
      ...chain,
      platform: {
        'app/x.ts': ['@openora/lib/d'],
        'app/y.ts': ['@openora/lib/a'],
        'app/z.ts': ['@openora/other'],
      },
    };
    const result = impactOf(graph, 'a.ts', 10, consumer);
    expect(result.specifiers).toEqual(['@openora/lib/a', '@openora/lib/d']);
    expect(result.consumerFiles).toEqual(['app/y.ts', 'app/x.ts']);
  });
});
