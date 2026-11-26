import { vi } from 'vitest';
import { createRedisClient } from '@openora/core/server';

export async function scheduledIds(redisUrl: string, queueName: string): Promise<string[]> {
  const client = createRedisClient(redisUrl);
  try {
    return await client.zRange(`bull:${queueName}:repeat`, 0, -1);
  } finally {
    await client.close();
  }
}

export const waitForSchedule = (redisUrl: string, queueName: string, scheduleId: string) =>
  vi.waitFor(
    async () => {
      const ids = await scheduledIds(redisUrl, queueName);
      if (!ids.includes(scheduleId)) {
        throw new Error(`${scheduleId} is not scheduled on ${queueName} yet`);
      }
    },
    { timeout: 10_000, interval: 100 },
  );
