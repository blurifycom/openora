import { definePlugin, createLogger } from '@openora/core/server';
import { REALTIME_TRANSPORT, REALTIME_CLIENT_AUTHORIZER } from '@openora/core/contracts';
import { AblyClientAuthorizer } from './ably-client-authorizer.js';
import { AblyRealtimeTransport } from './ably-realtime-transport.js';

const log = createLogger('ably');

export function shouldEnableAbly(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env['ABLY_API_KEY']) && env['ABLY_BROWSER_REALTIME_ENABLED'] === 'true';
}

export default definePlugin({
  id: 'ably',
  dependsOn: ['chat'],
  async register(ctx) {
    if (!shouldEnableAbly(process.env)) {
      log.info(
        'Ably overlay disabled - set ABLY_API_KEY and ABLY_BROWSER_REALTIME_ENABLED=true to replace SSE.',
      );
      return;
    }

    const apiKey = process.env['ABLY_API_KEY'];
    if (!apiKey) {
      throw new Error('ABLY_API_KEY is required when ABLY_BROWSER_REALTIME_ENABLED=true.');
    }
    const { Rest } = await import('ably');
    const rest = new Rest({ key: apiKey });
    ctx.provide(REALTIME_TRANSPORT, () => new AblyRealtimeTransport(rest, log));
    ctx.provide(REALTIME_CLIENT_AUTHORIZER, () => new AblyClientAuthorizer(rest));
    log.info('Ably realtime overlay active.');
  },
});
