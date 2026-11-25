import { describe, it, expect } from 'vitest';
import {
  CHAT_BLOCK_READER,
  WALLET_COMMANDS,
  WALLET_READER,
  type TokenCatalog,
} from '@openora/core/contracts';
import type { Plugin } from '../define-plugin.js';
import type { PluginEntry } from '../load-plugins.js';
import { withoutRemoteModules } from '../remote-modules.js';

type Node = { dependsOn: string[]; requiresPorts?: symbol[] };

function registry(graph: Record<string, Node>) {
  const entries: PluginEntry[] = Object.keys(graph).map((id) => ({ id, path: id }));
  const readPlugin = async (entry: PluginEntry) =>
    ({ id: entry.id, ...graph[entry.id] }) as unknown as Plugin<TokenCatalog>;
  return { entries, readPlugin };
}

const ids = (entries: PluginEntry[]) => entries.map((entry) => entry.id);

const chatGraph = registry({
  identity: { dependsOn: [] },
  chat: { dependsOn: ['identity'] },
  social: { dependsOn: ['chat', 'identity'] },
  'chat-commands': { dependsOn: ['chat', 'identity'] },
  'chat-mentions': { dependsOn: ['chat-commands'] },
  'chat-remote': { dependsOn: [] },
  wallet: { dependsOn: ['identity'] },
});

// After A5 a platform module requires money ports instead of depending on a money module.
const moneyGraph = registry({
  identity: { dependsOn: [] },
  'exchange-rate': { dependsOn: [] },
  wallet: { dependsOn: ['identity', 'exchange-rate'] },
  gaming: { dependsOn: ['wallet'] },
  bonus: { dependsOn: ['wallet'] },
  gamification: { dependsOn: ['bonus'] },
  betting: { dependsOn: ['wallet'] },
  'bf-provider-bridge': { dependsOn: ['gaming'] },
  profile: { dependsOn: ['identity'], requiresPorts: [WALLET_READER] },
  'player-management': {
    dependsOn: ['identity'],
    requiresPorts: [WALLET_READER, CHAT_BLOCK_READER],
  },
  'money-remote': { dependsOn: [] },
  chat: { dependsOn: ['identity'] },
});

describe('withoutRemoteModules: chat', () => {
  it('returns the registry whole while CHAT_SERVICE_URL is unset or empty', async () => {
    const { entries, readPlugin } = chatGraph;
    expect((await withoutRemoteModules(entries, readPlugin, {})).entries).toBe(entries);
    expect(
      (await withoutRemoteModules(entries, readPlugin, { CHAT_SERVICE_URL: '' })).entries,
    ).toBe(entries);
  });

  it('drops chat and everything that depends on it, transitively, once the URL is set', async () => {
    const { entries, readPlugin } = chatGraph;
    const result = await withoutRemoteModules(entries, readPlugin, {
      CHAT_SERVICE_URL: 'http://chat',
    });
    expect(ids(result.entries)).toEqual(['identity', 'chat-remote', 'wallet']);
    expect(result.dropped).toEqual([
      { env: 'CHAT_SERVICE_URL', modules: ['chat', 'social', 'chat-commands', 'chat-mentions'] },
    ]);
  });
});

describe('withoutRemoteModules: money', () => {
  it('drops the money modules and their dependents, keeping modules that only require ports', async () => {
    const { entries, readPlugin } = moneyGraph;
    const result = await withoutRemoteModules(entries, readPlugin, {
      MONEY_SERVICE_URL: 'http://money',
    });
    expect(ids(result.entries)).toEqual([
      'identity',
      'profile',
      'player-management',
      'money-remote',
      'chat',
    ]);
    expect(result.dropped).toEqual([
      {
        env: 'MONEY_SERVICE_URL',
        modules: [
          'exchange-rate',
          'wallet',
          'gaming',
          'bonus',
          'gamification',
          'betting',
          'bf-provider-bridge',
        ],
      },
    ]);
  });

  it('drops chat and money together when both URLs are set, attributing each module', async () => {
    const { entries, readPlugin } = moneyGraph;
    const result = await withoutRemoteModules(entries, readPlugin, {
      CHAT_SERVICE_URL: 'http://chat',
      MONEY_SERVICE_URL: 'http://money',
    });
    expect(ids(result.entries)).toEqual([
      'identity',
      'profile',
      'player-management',
      'money-remote',
    ]);
    expect(result.dropped.map((d) => [d.env, d.modules.length])).toEqual([
      ['CHAT_SERVICE_URL', 1],
      ['MONEY_SERVICE_URL', 7],
    ]);
  });

  it('refuses to boot when a kept module requires a port that takes the caller transaction', async () => {
    const { entries, readPlugin } = registry({
      wallet: { dependsOn: [] },
      tag: { dependsOn: [], requiresPorts: [WALLET_READER, WALLET_COMMANDS] },
    });
    await expect(
      withoutRemoteModules(entries, readPlugin, { MONEY_SERVICE_URL: 'http://money' }),
    ).rejects.toThrow(/MONEY_SERVICE_URL is set, but tag requires WALLET_COMMANDS/);
  });

  it('does not check transaction-bound ports while MONEY_SERVICE_URL is unset', async () => {
    const { entries, readPlugin } = registry({
      wallet: { dependsOn: [] },
      tag: { dependsOn: [], requiresPorts: [WALLET_COMMANDS] },
    });
    expect((await withoutRemoteModules(entries, readPlugin, {})).entries).toBe(entries);
  });
});
