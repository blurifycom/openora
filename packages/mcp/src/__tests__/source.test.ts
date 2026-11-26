import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  LINE_WIDTH,
  findCoreSourceRoot,
  findSymbol,
  findUsages,
  outline,
  readSourceTree,
  type SourceFile,
} from '../source.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'source-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function write(file: string, text = '') {
  const path = join(base, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

describe('findCoreSourceRoot', () => {
  it('returns the source root next to the catalog', () => {
    mkdirSync(join(base, 'a/packages/core/src'), { recursive: true });
    const catalog = write('a/docs/catalog.json', '{}');
    expect(findCoreSourceRoot(catalog)).toBe(join(base, 'a/packages/core/src'));
  });

  it('finds the source root from the mcp package docs inside a checkout', () => {
    mkdirSync(join(base, 'b/packages/core/src'), { recursive: true });
    const catalog = write('b/packages/mcp/docs/catalog.json', '{}');
    expect(findCoreSourceRoot(catalog)).toBe(join(base, 'b/packages/core/src'));
  });

  it('returns null when no source tree exists', () => {
    const catalog = write('c/node_modules/@openora/mcp/docs/catalog.json', '{}');
    expect(findCoreSourceRoot(catalog)).toBeNull();
  });
});

const files: SourceFile[] = [
  {
    path: 'wallet/service.ts',
    text: [
      '// withdraw is documented here',
      'export async function withdraw(id: string) {',
      '  return id;',
      '}',
      'const x = withdrawAll();',
      'const y = withdraw(1);',
      'const z = $withdraw + withdraw_v2;',
    ].join('\n'),
  },
  { path: 'wallet/__tests__/service.test.ts', text: 'withdraw(1);' },
  { path: 'bonus/promo/bonus/a.ts', text: 'withdraw(2);' },
  { path: 'other/thing.ts', text: 'withdraw(3);' },
];

describe('findUsages', () => {
  it('finds whole-word usages with file and line', () => {
    const usages = findUsages(files, 'withdraw');
    expect(usages).toEqual([
      { path: 'wallet/service.ts', line: 2, text: 'export async function withdraw(id: string) {' },
      { path: 'wallet/service.ts', line: 6, text: 'const y = withdraw(1);' },
      { path: 'bonus/promo/bonus/a.ts', line: 1, text: 'withdraw(2);' },
      { path: 'other/thing.ts', line: 1, text: 'withdraw(3);' },
    ]);
  });

  it('includes test files only when asked', () => {
    const paths = findUsages(files, 'withdraw', { includeTests: true }).map((u) => u.path);
    expect(paths).toContain('wallet/__tests__/service.test.ts');
  });

  it('limits to a module by path segment', () => {
    expect(findUsages(files, 'withdraw', { module: 'wallet' }).map((u) => u.path)).toEqual([
      'wallet/service.ts',
      'wallet/service.ts',
    ]);
    expect(findUsages(files, 'withdraw', { module: 'promo/bonus' }).map((u) => u.path)).toEqual([
      'bonus/promo/bonus/a.ts',
    ]);
    expect(findUsages(files, 'withdraw', { module: 'wall' })).toEqual([]);
  });

  it('truncates a long line to the line width', () => {
    const long = [{ path: 'a.ts', text: `withdraw(${'x'.repeat(400)})` }];
    expect(findUsages(long, 'withdraw')[0]?.text).toHaveLength(LINE_WIDTH);
  });

  it('treats regex metacharacters in the name literally', () => {
    const odd = [{ path: 'a.ts', text: 'const a$b = 1;\nconst aXb = 2;' }];
    expect(findUsages(odd, 'a$b').map((u) => u.line)).toEqual([1]);
  });

  it('returns nothing for an unknown symbol', () => {
    expect(findUsages(files, 'nope')).toEqual([]);
  });
});

const decls: SourceFile[] = [
  {
    path: 'wallet/service.ts',
    text: [
      'export async function withdraw(id: string) {',
      '  if (!id) {',
      "    throw new Error('x');",
      '  }',
      '  return id;',
      '}',
      '',
      'export type WithdrawInput = {',
      '  id: string;',
      '};',
      '',
      'export class WalletService {',
      '  async deposit(id: string) {',
      '    return id;',
      '  }',
      '  withdraw(id: string) {',
      '    return id;',
      '  }',
      '}',
    ].join('\n'),
  },
  { path: 'wallet/__tests__/service.test.ts', text: 'export function withdraw() {}' },
];

describe('findSymbol and outline', () => {
  it('finds an exported function, class or type by name', () => {
    expect(findSymbol(decls, 'withdraw')[0]).toMatchObject({ path: 'wallet/service.ts', line: 1 });
    expect(findSymbol(decls, 'WithdrawInput')).toEqual([
      {
        path: 'wallet/service.ts',
        line: 8,
        body: ['export type WithdrawInput = {', '  id: string;', '};'],
      },
    ]);
    const klass = findSymbol(decls, 'WalletService');
    expect(klass[0]?.line).toBe(12);
    expect(klass[0]?.body.at(-1)).toBe('}');
  });

  it('returns the full body of a function up to its closing bracket', () => {
    const [hit] = findSymbol(decls, 'withdraw');
    expect(hit?.body).toHaveLength(6);
  });

  it('finds a member by Owner.member and skips tests', () => {
    const hits = findSymbol(decls, 'WalletService.withdraw');
    expect(hits.map((h) => h.line)).toEqual([16]);
    expect(findSymbol(decls, 'withdraw').map((h) => h.path)).not.toContain(
      'wallet/__tests__/service.test.ts',
    );
  });

  it('returns nothing for an unknown symbol', () => {
    expect(findSymbol(decls, 'nope')).toEqual([]);
    expect(findSymbol(decls, 'Nope.withdraw')).toEqual([]);
    expect(findSymbol(decls, '')).toEqual([]);
  });

  it('outline keeps statements and drops closers and deep nesting', () => {
    const [hit] = findSymbol(decls, 'withdraw');
    if (!hit) {
      throw new Error('no hit');
    }
    expect(outline(hit)).toEqual([
      '1: export async function withdraw(id: string) {',
      '2:   if (!id) {',
      "3:     throw new Error('x');",
      '5:   return id;',
    ]);
  });

  it.todo('GAP: outline lines stay within the line width');
});

describe('readSourceTree', () => {
  it('reads ts files sorted, skipping declarations, node_modules and dot dirs', () => {
    write('tree/b.ts', 'b');
    write('tree/a/x.tsx', 'x');
    write('tree/a/x.d.ts', 'd');
    write('tree/node_modules/n.ts', 'n');
    write('tree/.hidden/h.ts', 'h');
    write('tree/readme.md', 'r');
    expect(readSourceTree(join(base, 'tree')).map((f) => f.path)).toEqual(['a/x.tsx', 'b.ts']);
  });
});
