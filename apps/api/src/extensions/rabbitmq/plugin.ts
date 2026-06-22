// Self-disabling overlay: if neither AMQP_URL nor RABBITMQ_URL is set it leaves
// the in-process default in place. Registered LATE so its MESSAGE_BROKER binding
// wins (last registration wins). See ADR-0016.

import { definePlugin } from '@blurifycom/core/server';
import { createLogger } from '@blurifycom/core/server';
import { MESSAGE_BROKER } from '@blurifycom/core/contracts';
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
