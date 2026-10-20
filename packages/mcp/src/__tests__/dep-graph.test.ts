import { describe, expect, it } from 'vitest';
import { impactOf, importersOf, type DepGraph } from '../dep-graph.js';

const graph = (dependents: DepGraph['dependents'], rest: Partial<DepGraph> = {}): DepGraph => ({
  generatedAt: '',
  commit: null,
  dependents,
  platform: {},
  entryPoints: {},
  ...rest,
});

const chain = graph({ 'a.ts': ['b.ts'], 'b.ts': ['c.ts'], 'c.ts': ['d.ts'] });

describe('importersOf', () => {
  it('returns importers nearest first', () => {
    expect(importersOf(chain, 'a.ts', 10)).toEqual(['b.ts', 'c.ts', 'd.ts']);
  });

  it('respects maxDepth', () => {
    expect(importersOf(chain, 'a.ts', 2)).toEqual(['b.ts', 'c.ts']);
    expect(importersOf(chain, 'a.ts', 0)).toEqual([]);
  });

  it('terminates on a cycle and excludes the file itself', () => {
    const cyclic = graph({ 'a.ts': ['b.ts'], 'b.ts': ['a.ts'] });
    expect(importersOf(cyclic, 'a.ts', 10)).toEqual(['b.ts']);
  });

  it('returns empty for an unknown file', () => {
    expect(importersOf(chain, 'missing.ts', 10)).toEqual([]);
  });
});

describe('impactOf', () => {
  const platform = graph(
    { 'src/a.ts': ['src/index.ts'], 'src/index.ts': ['src/server.ts'] },
    { entryPoints: { 'src/index.ts': '@openora/core', 'src/server.ts': '@openora/core/server' } },
  );

  it('lists reached specifiers nearest first', () => {
    const impact = impactOf(platform, 'src/a.ts', 5);
    expect(impact.importers).toEqual(['src/index.ts', 'src/server.ts']);
    expect(impact.specifiers).toEqual(['@openora/core', '@openora/core/server']);
    expect(impact.consumerFiles).toEqual([]);
  });

  it('maps specifiers to consumer files, ranked by nearest specifier then name', () => {
    const consumer = graph(
      {},
      {
        platform: {
          'z.ts': ['@openora/core'],
          'b.ts': ['@openora/core/server'],
          'a.ts': ['@openora/core/server'],
          'other.ts': ['@openora/ui'],
        },
      },
    );
    expect(impactOf(platform, 'src/a.ts', 5, consumer).consumerFiles).toEqual([
      'z.ts',
      'a.ts',
      'b.ts',
    ]);
  });

  it('respects maxDepth when collecting specifiers', () => {
    expect(impactOf(platform, 'src/a.ts', 1).specifiers).toEqual(['@openora/core']);
  });
});
