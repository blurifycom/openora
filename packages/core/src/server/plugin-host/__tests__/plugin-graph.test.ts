import { describe, expect, it } from 'vitest';
import type { TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from '../define-plugin.js';
import { assertEntryMatchesPlugin, type PluginEntry } from '../load-plugins.js';
import { corePlugins } from '../core-plugins.js';

function entry(id: string): PluginEntry {
  return { id, path: `./${id}.js` };
}

function plugin(id: string): Plugin<TokenCatalog> {
  return { id, register: () => {} };
}

describe('assertEntryMatchesPlugin', () => {
  it('accepts a registry entry that resolves the same plugin id', () => {
    expect(() => assertEntryMatchesPlugin(entry('wallet'), plugin('wallet'))).not.toThrow();
  });

  it('throws when the loaded plugin has a different id', () => {
    expect(() => assertEntryMatchesPlugin(entry('wallet'), plugin('tag'))).toThrow(
      /does not match the plugin's own id "tag"/,
    );
  });
});

describe('corePlugins', () => {
  it('leaves dependency metadata with each plugin declaration', () => {
    const entries = corePlugins();
    expect(entries.every((entry) => entry.dependsOn === undefined)).toBe(false);
  });
});
