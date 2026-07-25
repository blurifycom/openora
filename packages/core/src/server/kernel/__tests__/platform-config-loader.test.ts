import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPlatformConfig } from '@openora/core/contracts';
import { loadPlatformConfig, resolvePlatformConfigPath } from '../platform-config-loader.js';

let dir: string;
const originalCwd = process.cwd();

const write = (name: string, contents: string) => {
  const path = join(dir, name);
  writeFileSync(path, contents, 'utf8');
  return path;
};

const loadYaml = (contents: string) => loadPlatformConfig(write('platform-config.yaml', contents));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'platform-config-'));
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe('loadPlatformConfig', () => {
  it('returns the default config when no path is given', () => {
    expect(loadPlatformConfig()).toEqual(defaultPlatformConfig);
  });

  it('returns the default config when the file does not exist', () => {
    expect(loadPlatformConfig(join(dir, 'absent.yaml'))).toEqual(defaultPlatformConfig);
  });

  it('rejects an extension it cannot parse instead of guessing', () => {
    expect(() => loadPlatformConfig(write('platform-config.toml', 'features = {}'))).toThrow(
      /unsupported extension/,
    );
  });

  it('reads a JSON config', () => {
    const path = write('platform-config.json', JSON.stringify({ features: { chat: true } }));

    expect(loadPlatformConfig(path).features).toEqual({ chat: true });
  });

  it('surfaces the offending path when the config fails validation', () => {
    const path = write('platform-config.json', JSON.stringify({ features: { chat: 'yes' } }));

    expect(() => loadPlatformConfig(path)).toThrow(/features\.chat/);
  });

  it('rejects an unknown top-level key rather than silently dropping it', () => {
    const path = write('platform-config.json', JSON.stringify({ featurez: {} }));

    expect(() => loadPlatformConfig(path)).toThrow(/Invalid platform config/);
  });

  it('enforces the activeBrand cross-field rule', () => {
    const path = write('platform-config.json', JSON.stringify({ activeBrand: 'ghost' }));

    expect(() => loadPlatformConfig(path)).toThrow(/activeBrand/);
  });
});

describe('loadPlatformConfig yaml parsing', () => {
  it('parses booleans rather than leaving them as strings', () => {
    expect(loadYaml('features:\n  chat: true\n  bonuses: false\n').features).toEqual({
      chat: true,
      bonuses: false,
    });
  });

  it('parses integers', () => {
    const cfg = loadYaml('autoWithdrawal:\n  enabled: true\n  dailyCapCount: 3\n');

    expect(cfg.autoWithdrawal?.dailyCapCount).toBe(3);
  });

  it('strips surrounding quotes from a scalar', () => {
    const cfg = loadYaml('kyc:\n  provider: "didit"\n');

    expect(cfg.kyc?.provider).toBe('didit');
  });

  it('parses a list of scalars', () => {
    const cfg = loadYaml('supportedLanguages:\n  - en\n  - uk\n');

    expect(cfg.supportedLanguages).toEqual(['en', 'uk']);
  });

  it('parses a list of objects', () => {
    const cfg = loadYaml(
      'brands:\n  - id: main\n    name: Main\n  - id: vip\n    name: VIP\nactiveBrand: vip\n',
    );

    expect(cfg.brands).toEqual([
      { id: 'main', name: 'Main' },
      { id: 'vip', name: 'VIP' },
    ]);
    expect(cfg.activeBrand).toBe('vip');
  });

  it('parses nested maps', () => {
    const cfg = loadYaml('rgLimits:\n  DE:\n    maxDepositPerDay: 500\n');

    expect(cfg.rgLimits['DE']).toEqual({ maxDepositPerDay: 500 });
  });

  it('ignores comments and blank lines', () => {
    const cfg = loadYaml('# operator flags\n\nfeatures:\n  chat: true # inline\n\n');

    expect(cfg.features).toEqual({ chat: true });
  });

  it('rejects a comment-only document instead of falling back to the defaults', () => {
    expect(() => loadYaml('\n# nothing here\n')).toThrow(/expected object, received undefined/);
  });

  it('accepts a .yml extension too', () => {
    const path = write('platform-config.yml', 'features:\n  chat: true\n');

    expect(loadPlatformConfig(path).features).toEqual({ chat: true });
  });
});

describe('resolvePlatformConfigPath', () => {
  it('prefers an explicit PLATFORM_CONFIG_PATH', () => {
    expect(resolvePlatformConfigPath({ PLATFORM_CONFIG_PATH: '/etc/openora/cfg.yaml' })).toBe(
      '/etc/openora/cfg.yaml',
    );
  });

  it('returns undefined when nothing is configured and nothing is on disk', () => {
    process.chdir(dir);

    expect(resolvePlatformConfigPath({})).toBeUndefined();
  });

  it('falls back to a config file sitting in the working directory', () => {
    write('platform-config.json', '{}');
    process.chdir(dir);

    expect(resolvePlatformConfigPath({})).toBe(join(process.cwd(), 'platform-config.json'));
  });

  it('prefers yaml over json when both are present', () => {
    write('platform-config.yaml', '');
    write('platform-config.json', '{}');
    process.chdir(dir);

    expect(resolvePlatformConfigPath({})).toBe(join(process.cwd(), 'platform-config.yaml'));
  });
});
