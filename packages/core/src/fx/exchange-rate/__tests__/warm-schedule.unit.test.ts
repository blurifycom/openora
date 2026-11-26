import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  definePlatformConfig,
  EXCHANGE_RATE_READER,
  JOB_QUEUE,
  PLATFORM_CONFIG,
  type JobQueueAdapter,
} from '@openora/core/contracts';
import { Container, loadPlugins } from '@openora/core/server';

const path = fileURLToPath(new URL('../plugin.ts', import.meta.url));

async function schedulesUpserted(noRoutes: boolean) {
  const container = new Container();
  const registry = await loadPlugins([{ id: 'exchange-rate', path, noRoutes }], container);
  const scheduled: string[] = [];
  const jobQueue: JobQueueAdapter = {
    enqueue: async () => ({ id: 'job' }),
    schedule: async (_queue, scheduleId) => {
      scheduled.push(scheduleId);
    },
    unschedule: async () => {},
    registerWorker: () => {},
    close: async () => {},
  };
  container.register(JOB_QUEUE, () => jobQueue);
  container.register(PLATFORM_CONFIG, () => definePlatformConfig({}));
  container.register(EXCHANGE_RATE_READER, () => ({
    getRate: async () => null,
    convert: async () => null,
  }));
  registry.routers.getAll().get('exchangeRate')?.(container as never);
  return scheduled;
}

describe('exchange-rate warm-up schedule', () => {
  it('is upserted by a process that selects the module', async () => {
    expect(await schedulesUpserted(false)).toEqual(['exchange-rate-warm.cron']);
  });

  it('is left to the selecting process by one that loads the module only as a dependency', async () => {
    expect(await schedulesUpserted(true)).toEqual([]);
  });
});
