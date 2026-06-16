// Opt-in overlay: swap the in-process JOB_QUEUE for the durable BullMQ + Redis
// driver. SELF-DISABLING - if REDIS_URL is not set it leaves the in-process
// default in place and logs a notice, so this entry is safe to keep registered
// in extensions.config.ts for `pnpm dev`, tests and CI (which have no Redis).
// Set REDIS_URL (eg redis://localhost:6379) to activate. See ADR-0014.
//
// Registered LATE in extensions.config.ts so its JOB_QUEUE binding wins over the
// default (last registration wins). It rebinds infra only - no routes/schemas.

import { definePlugin } from '@oss/core/server';
import { createLogger } from '@oss/core/server';
import { JOB_QUEUE } from '@oss/core/contracts';
import { BullMqJobQueue } from './bullmq-job-queue.js';

const log = createLogger('bullmq-overlay');

export default definePlugin({
  id: 'bullmq',
  register(ctx) {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      log.info(
        'REDIS_URL not set - bullmq overlay inactive; JOB_QUEUE stays in-process (fine for dev/test).',
      );
      return;
    }
    log.info({ redisUrl: redisUrl.replace(/:\/\/.*@/, '://***@') }, 'binding JOB_QUEUE to BullMQ');
    ctx.provide(JOB_QUEUE, (c) => {
      const queueImpl = new BullMqJobQueue(redisUrl, log);
      c.onDispose(() => queueImpl.close());
      return queueImpl;
    });
  },
});
