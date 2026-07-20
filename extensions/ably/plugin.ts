import * as Ably from 'ably';
import { definePlugin, createLogger } from '@openora/core/server';
import { REALTIME_TRANSPORT, REALTIME_CLIENT_AUTHORIZER } from '@openora/core/contracts';
import { AblyClientAuthorizer } from './ably-client-authorizer.js';
import { AblyRealtimeTransport } from './ably-realtime-transport.js';

const log = createLogger('ably');

export default definePlugin({
  id: 'ably',
  dependsOn: ['chat'],
  register(ctx) {
    const apiKey = process.env['ABLY_API_KEY'];
    if (!apiKey) {
      log.info('ABLY_API_KEY not set - realtime remains first-party SSE.');
      return;
    }

    const rest = new Ably.Rest({ key: apiKey });
    ctx.provide(REALTIME_TRANSPORT, () => new AblyRealtimeTransport(rest, log));
    ctx.provide(REALTIME_CLIENT_AUTHORIZER, () => new AblyClientAuthorizer(rest));
    log.info('Ably realtime overlay active.');
  },
});
