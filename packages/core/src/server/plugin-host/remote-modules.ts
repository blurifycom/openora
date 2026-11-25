import { MONEY_MODULE_IDS, MONEY_TX_BOUND_PORTS, type TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from './define-plugin.js';
import type { PluginEntry } from './load-plugins.js';

/** A group of modules another service runs, named by the env var that points at that service. */
const REMOTE_DOMAINS = [
  { env: 'CHAT_SERVICE_URL', roots: ['chat'] },
  { env: 'MONEY_SERVICE_URL', roots: MONEY_MODULE_IDS },
] as const;

export type RemoteDomainEnv = (typeof REMOTE_DOMAINS)[number]['env'];

export type RemoteModulesResult = {
  entries: PluginEntry[];
  /** The ids dropped per env var that is set, in registry order. */
  dropped: { env: RemoteDomainEnv; modules: string[] }[];
};

/**
 * With `CHAT_SERVICE_URL` set, chat runs in another service; with `MONEY_SERVICE_URL` set, the
 * money modules do. This process then drops those modules and every entry that `dependsOn` one,
 * directly or through another dropped entry, and `chat-remote` / `money-remote` bind their ports
 * instead. With neither set the registry is returned as it came.
 *
 * With `MONEY_SERVICE_URL` set, a kept module that requires a port taking the caller's
 * transaction (`MONEY_TX_BOUND_PORTS`) fails the boot: no remote binding can join that
 * transaction.
 */
export async function withoutRemoteModules<C extends TokenCatalog>(
  entries: PluginEntry[],
  readPlugin: (entry: PluginEntry) => Promise<Plugin<C>>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RemoteModulesResult> {
  const domains = REMOTE_DOMAINS.filter((domain) => env[domain.env]);
  if (domains.length === 0) {
    return { entries, dropped: [] };
  }
  const plugins = await Promise.all(entries.map(readPlugin));
  const dropped = new Map<string, RemoteDomainEnv>();
  for (const domain of domains) {
    for (const root of domain.roots) {
      dropped.set(root, domain.env);
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const plugin of plugins) {
      if (dropped.has(plugin.id)) {
        continue;
      }
      const cause = plugin.dependsOn?.map((id) => dropped.get(id)).find(Boolean);
      if (cause) {
        dropped.set(plugin.id, cause);
        grew = true;
      }
    }
  }
  if (env['MONEY_SERVICE_URL']) {
    refuseTxBoundMoneyPorts(plugins.filter((plugin) => !dropped.has(plugin.id)));
  }
  return {
    entries: entries.filter((entry) => !dropped.has(entry.id)),
    dropped: domains.map((domain) => ({
      env: domain.env,
      modules: entries.filter((e) => dropped.get(e.id) === domain.env).map((e) => e.id),
    })),
  };
}

function refuseTxBoundMoneyPorts<C extends TokenCatalog>(kept: readonly Plugin<C>[]): void {
  const offenders = kept.flatMap((plugin) =>
    (plugin.requiresPorts ?? [])
      .filter((token) => MONEY_TX_BOUND_PORTS.includes(token))
      .map((token) => `${plugin.id} requires ${token.description ?? 'a port'}`),
  );
  if (offenders.length > 0) {
    throw new Error(
      `MONEY_SERVICE_URL is set, but ${offenders.join('; ')}: that port takes the caller's ` +
        'transaction and cannot be reached over the network. Run the module in the money ' +
        'service, or move it to a port money-remote binds.',
    );
  }
}
