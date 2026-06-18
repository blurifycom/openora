// Opt-in BullMQ + Redis JOB_QUEUE overlay. SELF-DISABLING when REDIS_URL is absent - safe to keep
// registered in extensions.config.ts for dev/test. Registered LATE so its binding wins (last wins).
// Set REDIS_URL to activate. See ADR-0014.

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
