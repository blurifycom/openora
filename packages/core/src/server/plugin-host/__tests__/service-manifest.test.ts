import { describe, it, expect, vi } from 'vitest';
import { createToken, type Token, type TokenCatalog } from '@openora/core/contracts';
import {
  applyServiceManifest,
  assertServiceComplete,
  parseServiceManifest,
  selectServiceEntries,
  type HostControl,
  type ServiceManifestCheck,
} from '../service-manifest.js';
import type { PluginEntry } from '../load-plugins.js';
import type { Plugin } from '../define-plugin.js';

const entries: PluginEntry[] = [
  { id: 'identity', path: 'a' },
  { id: 'wallet', path: 'b' },
  { id: 'gaming', path: 'c' },
  { id: 'rabbitmq', path: 'd', kind: 'infra' },
  { id: 'bullmq', path: 'e', kind: 'infra' },
];

describe('parseServiceManifest', () => {
  it('returns null (monolith) when unset or empty', () => {
    expect(parseServiceManifest(undefined)).toBeNull();
    expect(parseServiceManifest('')).toBeNull();
    expect(parseServiceManifest('   ')).toBeNull();
  });

  it('splits on commas and whitespace, trimming blanks', () => {
    expect(parseServiceManifest('identity, wallet')).toEqual(['identity', 'wallet']);
    expect(parseServiceManifest('identity  wallet')).toEqual(['identity', 'wallet']);
    expect(parseServiceManifest('wallet,')).toEqual(['wallet']);
  });
});

describe('applyServiceManifest', () => {
  it('returns every entry for the monolith (null manifest)', () => {
    expect(applyServiceManifest(entries, null)).toHaveLength(entries.length);
  });

  it('keeps the named modules plus all infra overlays', () => {
    const selected = applyServiceManifest(entries, ['wallet']);
    expect(selected.map((e) => e.id).sort()).toEqual(['bullmq', 'rabbitmq', 'wallet']);
  });

  it('throws on an unknown id', () => {
    expect(() => applyServiceManifest(entries, ['nope'])).toThrow(/unknown module id/);
  });
});

const MAIL = createToken<object>('MAIL');
const RG_LIMITS = createToken<object>('RG_LIMITS');
const PERMISSIONS = createToken<object>('PERMISSIONS');
const catalog = { MAIL, RG_LIMITS, PERMISSIONS } satisfies TokenCatalog;
type Catalog = typeof catalog;

const plugin = (id: string, shape: Partial<Plugin<Catalog>> = {}): Plugin<Catalog> => ({
  id,
  register: () => {},
  ...shape,
});
const binds =
  (...ports: Token<object>[]): Plugin<Catalog>['register'] =>
  (ctx) => {
    for (const port of ports) {
      ctx.provide(port, () => ({}));
    }
  };

const ADMIN_GUARD_CONTROL: HostControl<Catalog> = {
  owner: 'AdminGuard',
  port: PERMISSIONS,
  without: 'grants come from the static role table',
  boundBy: 'iam',
};

/** A plugin list of `plugins` (those named in `infra` as overlays), checked against `manifest`. */
function checkOf(
  plugins: Plugin<Catalog>[],
  manifest: string[],
  {
    infra = [],
    bound = [],
    hostControls = [],
  }: { infra?: string[]; bound?: symbol[]; hostControls?: HostControl<Catalog>[] } = {},
) {
  const byId = new Map(plugins.map((p) => [p.id, p]));
  const readPlugin = vi.fn(async (entry: PluginEntry) => {
    const found = byId.get(entry.id);
    if (!found) {
      throw new Error(`no fixture plugin ${entry.id}`);
    }
    return found;
  });
  const check: ServiceManifestCheck<Catalog> = {
    entries: plugins.map((p) => ({
      id: p.id,
      path: p.id,
      ...(infra.includes(p.id) ? { kind: 'infra' as const } : {}),
    })),
    manifest,
    readPlugin,
    hostControls,
    isBound: (port) => bound.includes(port),
  };
  return { check, readPlugin };
}

describe('selectServiceEntries', () => {
  const graph = [
    plugin('audit'),
    plugin('identity', { dependsOn: ['audit'] }),
    plugin('wallet', { dependsOn: ['identity', 'audit'] }),
    plugin('gaming', { dependsOn: ['wallet'] }),
    plugin('bullmq'),
  ];

  it('boots a manifest that lists its dependencies, reading only what it selects', async () => {
    const { check, readPlugin } = checkOf(graph, ['audit', 'identity', 'wallet'], {
      infra: ['bullmq'],
    });

    const selected = await selectServiceEntries(check);

    expect(selected.map((e) => e.id)).toEqual(['audit', 'identity', 'wallet', 'bullmq']);
    expect(readPlugin.mock.calls.map(([e]) => e.id).sort()).toEqual(
      ['audit', 'bullmq', 'identity', 'wallet'].sort(),
    );
  });

  it('names every left-out dependency, transitive ones included, in one error', async () => {
    const { check } = checkOf(graph, ['gaming']);

    await expect(selectServiceEntries(check)).rejects.toThrow(
      /SERVICE_MANIFEST=gaming leaves out[\s\S]*- wallet \(required by gaming\)[\s\S]*- identity \(required by wallet\)[\s\S]*- audit \(required by wallet, identity\)[\s\S]*Add them: SERVICE_MANIFEST=gaming,wallet,identity,audit$/m,
    );
  });

  it("counts an infra overlay's dependencies", async () => {
    const overlay = graph.map((p) => (p.id === 'bullmq' ? { ...p, dependsOn: ['identity'] } : p));
    const { check } = checkOf(overlay, ['audit'], { infra: ['bullmq'] });

    await expect(selectServiceEntries(check)).rejects.toThrow(/- identity \(required by bullmq\)/);
  });

  it('flags a dependency the plugin list does not have at all', async () => {
    const { check } = checkOf([plugin('audit', { dependsOn: ['ghost'] })], ['audit']);
    const run = selectServiceEntries(check);

    await expect(run).rejects.toThrow(/- ghost \(required by audit\) - not in the plugin list/);
    await expect(run).rejects.not.toThrow(/Add them/);
  });

  it('stops on a cycle among left-out modules', async () => {
    const cyclic = [
      plugin('gaming', { dependsOn: ['wallet'] }),
      plugin('wallet', { dependsOn: ['identity'] }),
      plugin('identity', { dependsOn: ['wallet'] }),
    ];

    await expect(selectServiceEntries(checkOf(cyclic, ['gaming']).check)).rejects.toThrow(
      /Add them: SERVICE_MANIFEST=gaming,wallet,identity$/m,
    );
  });

  it('still refuses an unknown id before reading anything', async () => {
    const { check, readPlugin } = checkOf(graph, ['nope']);

    await expect(selectServiceEntries(check)).rejects.toThrow(/unknown module id/);
    expect(readPlugin).not.toHaveBeenCalled();
  });
});

describe('the one error a manifest boot fails with', () => {
  const install = [
    plugin('audit'),
    plugin('identity', { requiresPorts: [MAIL] }),
    plugin('mail', { dependsOn: ['audit'], register: binds(MAIL) }),
    plugin('wallet', {
      dependsOn: ['identity'],
      controlPorts: [{ port: RG_LIMITS, without: 'limits go unenforced', boundBy: 'compliance' }],
    }),
    plugin('compliance', { dependsOn: ['wallet', 'gaming'], register: binds(RG_LIMITS) }),
    plugin('gaming', { dependsOn: ['wallet'] }),
    plugin('iam', { dependsOn: ['identity'], register: binds(PERMISSIONS) }),
  ];
  const withoutModules = (...ids: string[]) => install.filter((p) => !ids.includes(p.id));

  it('adds every module a left-out dependency, a required port and a control need', async () => {
    const { check } = checkOf(install, ['wallet'], { hostControls: [ADMIN_GUARD_CONTROL] });

    await expect(selectServiceEntries(check)).rejects.toThrow(
      'SERVICE_MANIFEST=wallet leaves out what this service needs:\n' +
        '  - identity (required by wallet, iam)\n' +
        '  - wallet runs without RG_LIMITS (bound by compliance): limits go unenforced\n' +
        '  - identity requires MAIL (bound by mail)\n' +
        '  - AdminGuard runs without PERMISSIONS (bound by iam): grants come from the static role table\n' +
        '  - gaming (required by compliance)\n' +
        '  - audit (required by mail)\n' +
        'Add them: SERVICE_MANIFEST=wallet,identity,compliance,mail,iam,gaming,audit\n' +
        'A split service may not skip a control the rest of its install enforces',
    );
  });

  it('refuses an unbound required port, naming the module that binds it', async () => {
    const { check } = checkOf(install, ['identity']);

    await expect(assertServiceComplete(check)).rejects.toThrow(
      /- identity requires MAIL \(bound by mail\)\n {2}- audit \(required by mail\)\nAdd them: SERVICE_MANIFEST=identity,mail,audit\nA split service loads every module/,
    );
  });

  it('refuses an unbound control the plugin list has, adding its module and what it needs', async () => {
    const { check } = checkOf(install, ['wallet', 'identity', 'mail', 'audit'], { bound: [MAIL] });

    await expect(assertServiceComplete(check)).rejects.toThrow(
      /- wallet runs without RG_LIMITS \(bound by compliance\): limits go unenforced\n {2}- gaming \(required by compliance\)\nAdd them: SERVICE_MANIFEST=wallet,identity,mail,audit,compliance,gaming\n/,
    );
  });

  it("refuses the host's controls on a split that needs nothing else", async () => {
    const { check } = checkOf(install, ['audit'], { hostControls: [ADMIN_GUARD_CONTROL] });

    await expect(assertServiceComplete(check)).rejects.toThrow(
      /- AdminGuard runs without PERMISSIONS \(bound by iam\)[\s\S]*Add them: SERVICE_MANIFEST=audit,iam,identity,mail\n/,
    );
  });

  it('boots, reading only what it selects, once every port is bound', async () => {
    const { check, readPlugin } = checkOf(install, ['wallet', 'identity', 'mail', 'audit'], {
      bound: [MAIL, RG_LIMITS, PERMISSIONS],
      hostControls: [ADMIN_GUARD_CONTROL],
    });

    await expect(assertServiceComplete(check)).resolves.toBeUndefined();
    expect(readPlugin.mock.calls.map(([e]) => e.id)).toEqual([
      'audit',
      'identity',
      'mail',
      'wallet',
    ]);
  });

  it('boots a control whose module the plugin list does not have', async () => {
    const { check } = checkOf(
      withoutModules('compliance', 'iam'),
      ['wallet', 'identity', 'mail', 'audit'],
      { bound: [MAIL], hostControls: [ADMIN_GUARD_CONTROL] },
    );

    await expect(assertServiceComplete(check)).resolves.toBeUndefined();
  });

  it('still refuses, offering nothing to add, when the selected module does not bind it', async () => {
    const unbinding = install.map((p) => (p.id === 'compliance' ? { ...p, register: binds() } : p));
    const { check } = checkOf(
      unbinding,
      ['wallet', 'identity', 'mail', 'audit', 'compliance', 'gaming'],
      { bound: [MAIL] },
    );
    const run = assertServiceComplete(check);

    await expect(run).rejects.toThrow(/- wallet runs without RG_LIMITS \(bound by compliance\)/);
    await expect(run).rejects.not.toThrow(/Add them/);
  });

  it('names the module that failed to register when no binder of a required port is known', async () => {
    const unconfigured = install.map((p) =>
      p.id === 'mail'
        ? {
            ...p,
            register: () => {
              throw new Error('mail: AUTH_SECRET is too short');
            },
          }
        : p,
    );
    const { check } = checkOf(unconfigured, ['identity']);

    await expect(assertServiceComplete(check)).rejects.toThrow(
      /- identity requires MAIL, which no module in the plugin list binds[\s\S]*failed to register, so the ports they bind are unknown:\n {2}- mail: mail: AUTH_SECRET is too short$/,
    );
  });

  it('names a required port no module in the plugin list binds', async () => {
    const { check } = checkOf(withoutModules('mail'), ['identity']);
    const run = assertServiceComplete(check);

    await expect(run).rejects.toThrow(
      /- identity requires MAIL, which no module in the plugin list binds/,
    );
    await expect(run).rejects.not.toThrow(/Add them/);
  });
});
