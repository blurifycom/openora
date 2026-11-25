import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { EXCHANGE_RATE_READER, JOB_QUEUE, PLATFORM_CONFIG } from '@openora/core/contracts';
import { Container, loadPlugins } from '@openora/core/server';
import { mock } from '../../../testing/mock.js';

const path = fileURLToPath(new URL('../plugin.ts', import.meta.url));

// Runs the router factory the way createApp does, and reports the schedules it upserted.
async function schedulesUpserted(noRoutes: boolean) {
  const container = new Container();
  const registry = await loadPlugins([{ id: 'exchange-rate', path, noRoutes }], container);
  const schedule = vi.fn(async () => {});
  container.register(JOB_QUEUE, () => mock({ schedule }));
  container.register(PLATFORM_CONFIG, () => mock({}));
  container.register(EXCHANGE_RATE_READER, () => mock({}));
  registry.routers.getAll().get('exchangeRate')?.(container as never);
  return schedule.mock.calls.map((call: unknown[]) => call[1]);
}

describe('exchange-rate warm-up schedule', () => {
  it('is upserted by a process that selects the module', async () => {
    expect(await schedulesUpserted(false)).toEqual(['exchange-rate-warm.cron']);
  });

  it('is left to the selecting process by one that loads the module only as a dependency', async () => {
    expect(await schedulesUpserted(true)).toEqual([]);
  });
});
