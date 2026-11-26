import { describe, expect, it } from 'vitest';
import type { TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from '../define-plugin.js';
import type { PluginEntry } from '../load-plugins.js';
import {
  applyServiceManifest,
  assertServiceComplete,
  parseServiceManifest,
  selectServiceEntries,
  type ServiceManifestEntry,
} from '../service-manifest.js';

describe('parseServiceManifest', () => {
  it('returns null when the manifest is unset', () => {
    expect(parseServiceManifest(undefined)).toBeNull();
  });

  it('returns null when the manifest is blank', () => {
    expect(parseServiceManifest('')).toBeNull();
    expect(parseServiceManifest('  \n\t ')).toBeNull();
    expect(parseServiceManifest(' , ,, ')).toBeNull();
  });

  it('parses ids separated by commas or whitespace', () => {
    const expected = [
      { id: 'wallet', noRoutes: false },
      { id: 'kyc', noRoutes: false },
      { id: 'bonus', noRoutes: false },
    ];
    expect(parseServiceManifest('wallet,kyc,bonus')).toEqual(expected);
    expect(parseServiceManifest('wallet kyc bonus')).toEqual(expected);
    expect(parseServiceManifest(' wallet ,\n kyc,  bonus ')).toEqual(expected);
  });

  it('parses the no-routes flag', () => {
    expect(parseServiceManifest('wallet:no-routes,kyc')).toEqual([
      { id: 'wallet', noRoutes: true },
      { id: 'kyc', noRoutes: false },
    ]);
  });

  it('rejects an unknown flag or extra segments', () => {
    expect(() => parseServiceManifest('wallet:routes')).toThrow(/unknown flag/);
    expect(() => parseServiceManifest('wallet:no-routes:x')).toThrow(/unknown flag/);
    expect(() => parseServiceManifest('wallet:')).toThrow(/unknown flag/);
    expect(() => parseServiceManifest('wallet:No-Routes')).toThrow(/unknown flag/);
  });

  it('rejects an id named both with and without no-routes', () => {
    expect(() => parseServiceManifest('wallet,wallet:no-routes')).toThrow(
      /names "wallet" both with and without ":no-routes"/,
    );
    expect(() => parseServiceManifest('wallet:no-routes,wallet')).toThrow(/both with and without/);
  });

  it('collapses a repeated id', () => {
    expect(parseServiceManifest('wallet,wallet,kyc,wallet')).toEqual([
      { id: 'wallet', noRoutes: false },
      { id: 'kyc', noRoutes: false },
    ]);
    expect(parseServiceManifest('wallet:no-routes,wallet:no-routes')).toEqual([
      { id: 'wallet', noRoutes: true },
    ]);
  });
});

const entries: PluginEntry[] = [
  { id: 'wallet', path: '/wallet' },
  { id: 'kyc', path: '/kyc' },
  { id: 'bonus', path: '/bonus' },
  { id: 'queue', path: '/queue', kind: 'infra' },
];

const manifest = (...items: ServiceManifestEntry[]) => items;
const ids = (list: PluginEntry[]) => list.map((e) => e.id);

describe('applyServiceManifest', () => {
  it('returns every entry when there is no manifest', () => {
    expect(applyServiceManifest(entries, null)).toBe(entries);
  });

  it('keeps only the listed modules', () => {
    const kept = applyServiceManifest(entries, manifest({ id: 'kyc', noRoutes: false }));
    expect(ids(kept)).toEqual(['kyc', 'queue']);
  });

  it('keeps every infra overlay even when not listed', () => {
    const kept = applyServiceManifest(entries, manifest({ id: 'wallet', noRoutes: false }));
    expect(ids(kept)).toContain('queue');
  });

  it('fails on an unknown module id and lists the known ids', () => {
    expect(() => applyServiceManifest(entries, manifest({ id: 'ghost', noRoutes: false }))).toThrow(
      /unknown module id\(s\): ghost\. Known ids: wallet, kyc, bonus, queue\./,
    );
  });

  it('refuses no-routes on an infra overlay', () => {
    expect(() => applyServiceManifest(entries, manifest({ id: 'queue', noRoutes: true }))).toThrow(
      /marks infra overlay\(s\) ":no-routes": queue/,
    );
  });

  it('keeps a module the listed modules depend on only when it is listed', () => {
    const kept = applyServiceManifest(entries, manifest({ id: 'bonus', noRoutes: false }));
    expect(ids(kept)).not.toContain('wallet');
    const withWallet = applyServiceManifest(
      entries,
      manifest({ id: 'bonus', noRoutes: false }, { id: 'wallet', noRoutes: false }),
    );
    expect(ids(withWallet)).toEqual(['wallet', 'bonus', 'queue']);
  });

  it('a module marked no-routes loads without mounting its routers', () => {
    const kept = applyServiceManifest(
      entries,
      manifest({ id: 'wallet', noRoutes: true }, { id: 'kyc', noRoutes: false }),
    );
    expect(kept.find((e) => e.id === 'wallet')?.noRoutes).toBe(true);
    expect(kept.find((e) => e.id === 'kyc')?.noRoutes).toBeUndefined();
    expect(entries.find((e) => e.id === 'wallet')?.noRoutes).toBeUndefined();
  });
});

describe('service completeness', () => {
  const WALLET_PORT = Symbol('WALLET_COMMANDS');
  const AUDIT_PORT = Symbol('AUDIT_LOG');

  type Spec = {
    dependsOn?: string[];
    requires?: symbol[];
    controls?: { port: symbol; boundBy: string; routesOnly?: boolean }[];
    provides?: symbol[];
  };

  function build(specs: Record<string, Spec>) {
    const plugins = new Map<string, Plugin<TokenCatalog>>();
    const list: PluginEntry[] = Object.keys(specs).map((id) => ({ id, path: `/${id}` }));
    for (const [id, spec] of Object.entries(specs)) {
      plugins.set(id, {
        id,
        dependsOn: spec.dependsOn ?? [],
        requiresPorts: spec.requires ?? [],
        controlPorts: (spec.controls ?? []).map((c) => ({ ...c, without: `${id} skips a check` })),
        register(ctx) {
          for (const port of spec.provides ?? []) {
            ctx.provide(port, () => id);
          }
        },
      });
    }
    const readPlugin = async (entry: PluginEntry) => {
      const plugin = plugins.get(entry.id);
      if (!plugin) {
        throw new Error(`no plugin ${entry.id}`);
      }
      return plugin;
    };
    return { list, readPlugin };
  }

  const check = (
    specs: Record<string, Spec>,
    selected: ServiceManifestEntry[],
    bound: symbol[] = [],
  ) => {
    const { list, readPlugin } = build(specs);
    return {
      entries: list,
      manifest: selected,
      readPlugin,
      hostControls: [],
      isBound: (port: symbol) => bound.includes(port),
    };
  };

  const specs: Record<string, Spec> = {
    wallet: { provides: [WALLET_PORT] },
    bonus: { requires: [WALLET_PORT] },
    kyc: {},
  };

  it('a service missing a port its kept modules require fails the boot with a clear error', async () => {
    const failing = check(specs, [{ id: 'bonus', noRoutes: false }]);
    await expect(assertServiceComplete(failing)).rejects.toThrow(
      /SERVICE_MANIFEST=bonus leaves out what this service needs:[\s\S]*bonus requires WALLET_COMMANDS \(bound by wallet\)[\s\S]*Add them: SERVICE_MANIFEST=bonus,wallet/,
    );
  });

  it('a service missing a module its kept modules depend on fails before anything registers', async () => {
    const dependent = check({ wallet: {}, bonus: { dependsOn: ['wallet'] } }, [
      { id: 'bonus', noRoutes: false },
    ]);
    await expect(selectServiceEntries(dependent)).rejects.toThrow(/wallet \(required by bonus\)/);
  });

  it('a service missing a control port whose module is in the plugin list fails the boot', async () => {
    const withControl = check(
      {
        wallet: { provides: [AUDIT_PORT] },
        bonus: { controls: [{ port: AUDIT_PORT, boundBy: 'wallet' }] },
      },
      [{ id: 'bonus', noRoutes: false }],
    );
    await expect(assertServiceComplete(withControl)).rejects.toThrow(
      /bonus runs without AUDIT_LOG \(bound by wallet\)/,
    );
  });

  it('a control port enforced only on routes is skipped for a no-routes module', async () => {
    const routesOnly = check(
      {
        wallet: { provides: [AUDIT_PORT] },
        bonus: { controls: [{ port: AUDIT_PORT, boundBy: 'wallet', routesOnly: true }] },
      },
      [{ id: 'bonus', noRoutes: true }],
    );
    await expect(assertServiceComplete(routesOnly)).resolves.toBeUndefined();
  });

  it('a complete service passes the check', async () => {
    const complete = check(
      specs,
      [
        { id: 'bonus', noRoutes: false },
        { id: 'wallet', noRoutes: false },
      ],
      [WALLET_PORT],
    );
    await expect(assertServiceComplete(complete)).resolves.toBeUndefined();
  });

  it('passes when the required port is already bound by the host', async () => {
    const hostBound = check(specs, [{ id: 'bonus', noRoutes: false }], [WALLET_PORT]);
    await expect(assertServiceComplete(hostBound)).resolves.toBeUndefined();
  });
});
