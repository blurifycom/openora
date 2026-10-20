import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildVars,
  emitTree,
  isTelemetryEnabled,
  outputPath,
  parseArgs,
  sanitizeName,
  substitute,
  undotSegment,
} from '../render.js';

const here = dirname(fileURLToPath(import.meta.url));
const consumerTemplates = resolve(here, '../../../../tools/templates/consumer');

const tmpDirs: string[] = [];
const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'create-openora-'));
  tmpDirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

describe('sanitizeName', () => {
  it('lowercases and dashes invalid characters', () => {
    expect(sanitizeName('My App!')).toBe('my-app');
  });

  it('falls back when nothing usable is left', () => {
    expect(sanitizeName('***')).toBe('igaming-app');
  });
});

describe('parseArgs', () => {
  const argv = (...args: string[]) => ['node', 'create-openora', ...args];

  it('reads --name=value', () => {
    expect(parseArgs(argv('dir', '--name=x'))).toEqual({
      target: 'dir',
      name: 'x',
      telemetry: true,
    });
  });

  it('reads --name value', () => {
    expect(parseArgs(argv('dir', '--name', 'x'))).toEqual({
      target: 'dir',
      name: 'x',
      telemetry: true,
    });
  });

  it('omits name when not given', () => {
    expect(parseArgs(argv('dir'))).toEqual({ target: 'dir', telemetry: true });
  });

  it('turns telemetry off with --no-telemetry', () => {
    expect(parseArgs(argv('dir', '--no-telemetry'))).toEqual({ target: 'dir', telemetry: false });
  });

  it('throws without a target', () => {
    expect(() => parseArgs(argv('--name', 'x'))).toThrow('missing target directory');
  });
});

describe('isTelemetryEnabled', () => {
  it('is on by default', () => {
    expect(isTelemetryEnabled(true, {})).toBe(true);
  });

  it('is off with --no-telemetry', () => {
    expect(isTelemetryEnabled(false, {})).toBe(false);
  });

  it.each([
    { OPENORA_TELEMETRY_DISABLED: ' yes ' },
    { DO_NOT_TRACK: '1' },
    { CI: '' },
    { NODE_ENV: 'test' },
  ])('is off under %o', (env) => {
    expect(isTelemetryEnabled(true, env)).toBe(false);
  });

  it('stays on when OPENORA_TELEMETRY_DISABLED=0', () => {
    expect(isTelemetryEnabled(true, { OPENORA_TELEMETRY_DISABLED: '0' })).toBe(true);
  });
});

describe('substitute', () => {
  it('replaces known keys and leaves unknown ones', () => {
    expect(substitute('{{a}}-{{unknown}}-{{a}}', { a: '1' })).toBe('1-{{unknown}}-1');
  });
});

describe('path mapping', () => {
  it('undots a single segment', () => {
    expect(undotSegment('__dot__env')).toBe('.env');
    expect(undotSegment('plain')).toBe('plain');
  });

  it('undots every segment and strips .tpl', () => {
    expect(outputPath(join('__dot__rulesync', 'x.md.tpl'))).toBe(join('.rulesync', 'x.md'));
    expect(outputPath(join('a', '__dot__b', 'c.json'))).toBe(join('a', '.b', 'c.json'));
  });
});

describe('emitTree', () => {
  it('substitutes .tpl files and copies the rest verbatim', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const src = makeTmp();
    const out = makeTmp();
    mkdirSync(join(src, '__dot__cfg'));
    writeFileSync(join(src, '__dot__cfg', 'a.txt.tpl'), 'hi {{name}} {{nope}}');
    writeFileSync(join(src, 'b.txt'), 'keep {{name}}');

    emitTree(src, { name: 'app' }, out);

    expect(readFileSync(join(out, '.cfg', 'a.txt'), 'utf8')).toBe('hi app {{nope}}');
    expect(readFileSync(join(out, 'b.txt'), 'utf8')).toBe('keep {{name}}');
  });
});

describe('consumer templates', () => {
  it('only reference keys that buildVars provides', () => {
    const provided = new Set(Object.keys(buildVars('app', '^1.0.0')));
    const used = new Set<string>();
    for (const file of listFiles(consumerTemplates).filter((f) => f.endsWith('.tpl'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(/\{\{(\w+)\}\}/g)) {
        used.add(match[1] ?? '');
      }
    }
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((key) => !provided.has(key))).toEqual([]);
  });
});
