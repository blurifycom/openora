import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenCatalog } from '@openora/core/contracts';
import { importPlugin } from '../load-plugins.js';
import { selectServiceEntries } from '../service-manifest.js';

const CORE_SRC = fileURLToPath(new URL('../../../', import.meta.url));
const CONFIGURED_SECRET = 'register-side-effects-secret-0000000000000000';
const TIMERS = ['setTimeout', 'setInterval', 'setImmediate'] as const;

async function loadCorePlugins() {
  const paths = readdirSync(CORE_SRC, { recursive: true, encoding: 'utf8' })
    .filter((path) => basename(path) === 'plugin.ts')
    .map((path) => join(CORE_SRC, path));
  return Promise.all(
    paths.map(async (path) => {
      const { default: plugin } = (await import(path)) as { default: { id: string } };
      const entry = { id: plugin.id, path };
      return { entry, plugin: await importPlugin<TokenCatalog>(entry) };
    }),
  );
}

function processState() {
  return {
    env: { ...process.env },
    listeners: Object.fromEntries(
      process.eventNames().map((event) => [String(event), process.listenerCount(event)]),
    ),
    globals: Reflect.ownKeys(globalThis).map(String).sort(),
  };
}

function activeResources() {
  return process
    .getActiveResourcesInfo()
    .reduce<Record<string, number>>(
      (counts, type) => ({ ...counts, [type]: (counts[type] ?? 0) + 1 }),
      {},
    );
}

function grown(before: Record<string, number>, after: Record<string, number>) {
  return Object.entries(after)
    .filter(([type, count]) => count > (before[type] ?? 0))
    .map(([type]) => type);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('the registration pass of a failed SERVICE_MANIFEST boot', () => {
  it('registers every core plugin once, leaving no timer, handle, listener, global or env change behind', async () => {
    vi.stubEnv('AUTH_SECRET', CONFIGURED_SECRET);
    vi.stubEnv('WITHDRAWAL_PIN_HMAC_SECRET', CONFIGURED_SECRET);
    const loaded = await loadCorePlugins();
    const registers = loaded.map(({ plugin }) => vi.spyOn(plugin, 'register'));
    const state = processState();
    const resources = activeResources();
    const timers = TIMERS.map((name) => vi.spyOn(globalThis, name));

    await expect(
      selectServiceEntries<TokenCatalog>({
        entries: loaded.map(({ entry }) => entry),
        manifest: ['wallet'],
        readPlugin: (entry) => importPlugin<TokenCatalog>(entry),
        hostControls: [],
        isBound: () => false,
      }),
    ).rejects.toThrow(/^SERVICE_MANIFEST=wallet leaves out/);

    expect(loaded.map(({ plugin }) => plugin.id)).toEqual(
      expect.arrayContaining([
        'audit',
        'identity',
        'mail',
        'notifications',
        'wallet',
        'compliance',
      ]),
    );
    expect(
      Object.fromEntries(
        loaded.map(({ plugin }, i) => [plugin.id, registers[i]?.mock.results.map((r) => r.type)]),
      ),
    ).toEqual(Object.fromEntries(loaded.map(({ plugin }) => [plugin.id, ['return']])));
    for (const timer of timers) {
      expect(timer).not.toHaveBeenCalled();
    }
    expect(grown(resources, activeResources())).toEqual([]);
    expect(processState()).toEqual(state);
  }, 60_000);
});
