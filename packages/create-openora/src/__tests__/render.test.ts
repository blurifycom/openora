import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildVars, emitTree, isTelemetryEnabled, parseArgs, sanitizeName } from '../render.js';

const argv = (...rest: string[]) => ['node', 'create-openora', ...rest];

describe('parseArgs', () => {
  it('takes the first positional argument as the target', () => {
    expect(parseArgs(argv('first', 'second')).target).toBe('first');
    expect(parseArgs(argv('--no-telemetry', 'first', 'second')).target).toBe('first');
  });

  it('reads --name with a space or an equals sign', () => {
    expect(parseArgs(argv('app', '--name', 'shop')).name).toBe('shop');
    expect(parseArgs(argv('app', '--name=shop')).name).toBe('shop');
    expect(parseArgs(argv('--name', 'shop', 'app'))).toEqual({
      target: 'app',
      name: 'shop',
      telemetry: true,
    });
  });

  it('--no-telemetry turns telemetry off', () => {
    expect(parseArgs(argv('app')).telemetry).toBe(true);
    expect(parseArgs(argv('app', '--no-telemetry')).telemetry).toBe(false);
  });

  it('fails with usage when the target is missing', () => {
    expect(() => parseArgs(argv())).toThrow(/missing target directory[\s\S]*Usage:/);
    expect(() => parseArgs(argv('--no-telemetry', '--name', 'x'))).toThrow(/missing target/);
  });
});

describe('isTelemetryEnabled', () => {
  it('is on by default', () => {
    expect(isTelemetryEnabled(true, {})).toBe(true);
  });

  it('is off when the flag, OPENORA_TELEMETRY_DISABLED or DO_NOT_TRACK is set', () => {
    expect(isTelemetryEnabled(false, {})).toBe(false);
    expect(isTelemetryEnabled(true, { OPENORA_TELEMETRY_DISABLED: '1' })).toBe(false);
    expect(isTelemetryEnabled(true, { DO_NOT_TRACK: 'true' })).toBe(false);
    expect(isTelemetryEnabled(true, { DO_NOT_TRACK: ' YES ' })).toBe(false);
  });

  it('is off in CI and under NODE_ENV test', () => {
    expect(isTelemetryEnabled(true, { CI: 'true' })).toBe(false);
    expect(isTelemetryEnabled(true, { NODE_ENV: 'test' })).toBe(false);
    expect(isTelemetryEnabled(true, { NODE_ENV: 'production' })).toBe(true);
  });

  it('does not treat 0 or an empty value as set', () => {
    for (const value of ['0', '', 'false', 'no']) {
      expect(isTelemetryEnabled(true, { OPENORA_TELEMETRY_DISABLED: value })).toBe(true);
      expect(isTelemetryEnabled(true, { DO_NOT_TRACK: value })).toBe(true);
    }
  });
});

describe('sanitizeName', () => {
  it('lowercases and replaces unsafe characters', () => {
    expect(sanitizeName('My App!')).toBe('my-app');
    expect(sanitizeName('a b/c')).toBe('a-b-c');
    expect(sanitizeName('keep_this-1')).toBe('keep_this-1');
  });

  it('trims leading and trailing dashes', () => {
    expect(sanitizeName('--x--')).toBe('x');
    expect(sanitizeName('  x  ')).toBe('x');
  });

  it('falls back to a default name when nothing is left', () => {
    expect(sanitizeName('')).toBe('igaming-app');
    expect(sanitizeName('!!!')).toBe('igaming-app');
    expect(sanitizeName('---')).toBe('igaming-app');
  });

  it('turns path traversal and scoped npm names into a flat safe name', () => {
    expect(sanitizeName('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeName('..\\..\\windows')).toBe('windows');
    expect(sanitizeName('/abs/path')).toBe('abs-path');
    expect(sanitizeName('@scope/pkg')).toBe('scope-pkg');
    expect(sanitizeName('a;rm -rf ~')).toBe('a-rm--rf');
    expect(sanitizeName('..')).toBe('igaming-app');
  });

  it('never emits a name containing a separator, dot or uppercase letter', () => {
    for (const raw of ['../x', 'A.B', 'x/../y', 'Ünï', 'a\nb', 'a%2e%2eb']) {
      expect(sanitizeName(raw)).toMatch(/^[a-z0-9_-]+$/);
    }
  });
});

describe('emitTree', () => {
  let root: string;
  let src: string;
  let out: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'create-openora-'));
    src = join(root, 'src');
    out = join(root, 'out');
    mkdirSync(src);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('substitutes known variables and leaves unknown placeholders', () => {
    writeFileSync(join(src, 'a.txt.tpl'), 'hi {{name}} {{missing}} {{ name }} {{scope}}');
    writeFileSync(join(src, 'raw.txt'), 'keep {{name}}');
    emitTree(src, { name: 'shop', scope: '@shop' }, out);
    expect(readFileSync(join(out, 'a.txt'), 'utf8')).toBe('hi shop {{missing}} {{ name }} @shop');
    expect(readFileSync(join(out, 'raw.txt'), 'utf8')).toBe('keep {{name}}');
  });

  it('does not re-expand placeholders carried inside a substituted value', () => {
    writeFileSync(join(src, 'a.tpl'), '{{name}}');
    emitTree(src, { name: '{{scope}}', scope: 'x' }, out);
    expect(readFileSync(join(out, 'a'), 'utf8')).toBe('{{scope}}');
  });

  it('maps __dot__ segments to dotfiles', () => {
    mkdirSync(join(src, '__dot__claude'));
    writeFileSync(join(src, '__dot__gitignore'), 'x');
    writeFileSync(join(src, '__dot__claude', 'settings.json'), '{}');
    writeFileSync(join(src, 'mid__dot__x'), 'y');
    emitTree(src, {}, out);
    expect(existsSync(join(out, '.gitignore'))).toBe(true);
    expect(existsSync(join(out, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(join(out, 'mid__dot__x'))).toBe(true);
  });

  it('strips the tpl suffix', () => {
    writeFileSync(join(src, 'package.json.tpl'), '{}');
    writeFileSync(join(src, 'tpl'), 'plain');
    emitTree(src, {}, out);
    expect(existsSync(join(out, 'package.json'))).toBe(true);
    expect(existsSync(join(out, 'package.json.tpl'))).toBe(false);
    expect(existsSync(join(out, 'tpl'))).toBe(true);
  });

  it('creates nested directories', () => {
    mkdirSync(join(src, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(join(src, 'a', 'b', 'c', 'deep.txt'), 'd');
    emitTree(src, {}, join(out, 'not', 'yet', 'there'));
    expect(readFileSync(join(out, 'not', 'yet', 'there', 'a', 'b', 'c', 'deep.txt'), 'utf8')).toBe(
      'd',
    );
  });

  it('writes a hostile sanitized name only inside the target directory', () => {
    writeFileSync(join(src, 'p.json.tpl'), '{"name":"{{name}}"}');
    emitTree(src, buildVars(sanitizeName('../../escape'), {}), out);
    expect(readFileSync(join(out, 'p.json'), 'utf8')).toBe('{"name":"escape"}');
    expect(existsSync(join(root, 'escape'))).toBe(false);
  });
});

describe('buildVars', () => {
  it('carries the project name and the dependency versions', () => {
    const vars = buildVars('shop', { coreVersion: '^1.2.3', mcpVersion: '^4.5.6' });
    expect(vars['name']).toBe('shop');
    expect(vars['scope']).toBe('@shop');
    expect(vars['coreVersion']).toBe('^1.2.3');
    expect(vars['mcpVersion']).toBe('^4.5.6');
    expect(JSON.parse(vars['mcpArgsJson'] ?? '')).toEqual([
      'node_modules/@openora/mcp/dist/main.js',
    ]);
  });
});
