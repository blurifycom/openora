// Opt-in overlay: swap the in-process MESSAGE_BROKER for a durable RabbitMQ
// driver. SELF-DISABLING - if neither AMQP_URL nor RABBITMQ_URL is set it leaves
// the in-process default in place and logs a notice, so this entry is safe to
// keep registered in extensions.config.ts for `pnpm dev`, tests and CI (which
// have no broker). Set AMQP_URL (eg amqp://localhost:5672) to activate.
//
// Registered LATE in extensions.config.ts so its MESSAGE_BROKER binding wins
// over the default (last registration wins). Rebinds infra only - no
// routes/schemas. Modules never see the change; they emit/subscribe through the
// EventBus, which owns the envelope. See ADR-0016.

import { definePlugin } from '@oss/core/server';
import { createLogger } from '@oss/core/server';
import { MESSAGE_BROKER } from '@oss/core/contracts';
import { RabbitMqBroker } from './rabbitmq-broker.js';

const log = createLogger('rabbitmq-overlay');

export default definePlugin({
  id: 'rabbitmq',
  register(ctx) {
    const url = process.env['AMQP_URL'] ?? process.env['RABBITMQ_URL'];
    if (!url) {
      log.info(
        'AMQP_URL not set - rabbitmq overlay inactive; MESSAGE_BROKER stays in-process (fine for dev/test).',
      );
      return;
    }
    log.info({ url: url.replace(/:\/\/.*@/, '://***@') }, 'binding MESSAGE_BROKER to RabbitMQ');
    ctx.provide(MESSAGE_BROKER, (c) => {
      const broker = new RabbitMqBroker(url, log);
      c.onDispose(() => broker.close());
      return broker;
    });
  },
});
