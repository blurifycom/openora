import { createInternalClient, parseServiceManifest } from '@openora/core/server';
import type { CoreTokenCatalog, InternalClient, Plugin } from '@openora/core/server';
import { CHAT_BLOCK_READER, CHAT_TRANSFER_CHECK } from '@openora/core/contracts';
import { RemoteChatBlockReader } from './service/remote-chat-block-reader.service.js';
import { RemoteChatTransferCheck } from './service/remote-chat-transfer-check.service.js';

// A chat call slower than this fails: a block read throws, a transfer check refuses.
const CHAT_CALL_TIMEOUT_MS = 500;

/**
 * A service that does not load chat reaches it through the chat service: set `CHAT_SERVICE_URL`.
 * Unset, nothing is bound, and a module that requires a chat port refuses to boot.
 */
function chatClient(): InternalClient | null {
  const url = process.env['CHAT_SERVICE_URL'];
  if (!url) {
    // Named in a manifest, this plugin is the only thing that can bind the ports, so an unset
    // URL is the mistake. Without a manifest it is the full install, where chat itself binds them.
    if (
      parseServiceManifest(process.env['SERVICE_MANIFEST'])?.some((m) => m.id === 'chat-remote')
    ) {
      throw new Error(
        'SERVICE_MANIFEST names chat-remote, but CHAT_SERVICE_URL is not set: set CHAT_SERVICE_URL ' +
          'to the chat service, or leave chat-remote out and load chat here.',
      );
    }
    return null;
  }
  if (
    process.env['NODE_ENV'] === 'production' &&
    new URL(url).protocol !== 'https:' &&
    process.env['CHAT_SERVICE_ALLOW_HTTP'] !== 'true'
  ) {
    throw new Error(
      'CHAT_SERVICE_URL is not https in production, so block reads and transfer checks would ' +
        'cross the network in clear text. Use https, or set CHAT_SERVICE_ALLOW_HTTP=true where a ' +
        'service mesh inside the private network encrypts the hop.',
    );
  }
  return createInternalClient({
    baseUrl: url,
    serviceName: process.env['SERVICE_NAME'] || 'monolith',
    audience: process.env['CHAT_SERVICE_NAME'] || 'chat',
    secrets: process.env['INTERNAL_API_SECRETS'],
    timeoutMs: CHAT_CALL_TIMEOUT_MS,
  });
}

/**
 * Binds `CHAT_BLOCK_READER` and `CHAT_TRANSFER_CHECK` to the chat service's internal API, for a
 * process that does not load the chat modules and so has no chat tables. Load it instead of
 * `chat`: the chat plugin refuses to boot while `CHAT_SERVICE_URL` is set, so the two never both
 * bind a port.
 */
export default {
  id: 'chat-remote',
  register(ctx) {
    const client = chatClient();
    if (!client) {
      return;
    }
    ctx.provide(CHAT_BLOCK_READER, () => new RemoteChatBlockReader(client));
    ctx.provide(CHAT_TRANSFER_CHECK, () => new RemoteChatTransferCheck(client));
  },
} as const satisfies Plugin<CoreTokenCatalog>;
