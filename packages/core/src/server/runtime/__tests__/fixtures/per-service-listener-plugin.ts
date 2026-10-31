import type { TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from '../../../plugin-host/define-plugin.js';

export const PER_SERVICE_TOPIC = 'test.per-service';

/** Which services' handlers ran, on globalThis: the host imports this file by path, not the test. */
export function heardByService(): string[] {
  const holder = globalThis as { __heardByService?: string[] };
  holder.__heardByService ??= [];
  return holder.__heardByService;
}

export default {
  id: 'per-service-listener',
  register(ctx) {
    const service = process.env['SERVICE_NAME'] ?? '';
    ctx.events.on(PER_SERVICE_TOPIC, () => {
      heardByService().push(service);
    });
  },
} satisfies Plugin<TokenCatalog>;
