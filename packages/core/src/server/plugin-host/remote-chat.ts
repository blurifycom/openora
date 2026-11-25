import type { TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from './define-plugin.js';
import type { PluginEntry } from './load-plugins.js';

/**
 * With `CHAT_SERVICE_URL` set, chat runs in another service: this process drops `chat` and every
 * entry that `dependsOn` it, directly or through another dropped entry, and `chat-remote` binds
 * the chat ports instead. Unset, the registry is returned as it came.
 */
export async function withoutChatModules<C extends TokenCatalog>(
  entries: PluginEntry[],
  readPlugin: (entry: PluginEntry) => Promise<Plugin<C>>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PluginEntry[]> {
  if (!env['CHAT_SERVICE_URL']) {
    return entries;
  }
  const plugins = await Promise.all(entries.map(readPlugin));
  const dropped = new Set(['chat']);
  let grew = true;
  while (grew) {
    grew = false;
    for (const plugin of plugins) {
      if (!dropped.has(plugin.id) && plugin.dependsOn?.some((id) => dropped.has(id))) {
        dropped.add(plugin.id);
        grew = true;
      }
    }
  }
  return entries.filter((entry) => !dropped.has(entry.id));
}
