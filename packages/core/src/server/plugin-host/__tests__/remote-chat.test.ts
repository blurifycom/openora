import { describe, it, expect } from 'vitest';
import type { TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from '../define-plugin.js';
import type { PluginEntry } from '../load-plugins.js';
import { withoutChatModules } from '../remote-chat.js';

const graph: Record<string, string[]> = {
  identity: [],
  chat: ['identity'],
  social: ['chat', 'identity'],
  'chat-commands': ['chat', 'identity'],
  'chat-mentions': ['chat-commands'],
  'chat-remote': [],
  wallet: ['identity'],
};
const entries: PluginEntry[] = Object.keys(graph).map((id) => ({ id, path: id }));
const readPlugin = async (entry: PluginEntry) =>
  ({ id: entry.id, dependsOn: graph[entry.id] }) as unknown as Plugin<TokenCatalog>;

describe('withoutChatModules', () => {
  it('returns the registry whole while CHAT_SERVICE_URL is unset or empty', async () => {
    expect(await withoutChatModules(entries, readPlugin, {})).toBe(entries);
    expect(await withoutChatModules(entries, readPlugin, { CHAT_SERVICE_URL: '' })).toBe(entries);
  });

  it('drops chat and everything that depends on it, transitively, once the URL is set', async () => {
    const kept = await withoutChatModules(entries, readPlugin, { CHAT_SERVICE_URL: 'http://chat' });
    expect(kept.map((entry) => entry.id)).toEqual(['identity', 'chat-remote', 'wallet']);
  });
});
