import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RedisPubSubRealtimeTransport } from '../redis-pubsub-realtime-transport.js';
import { runRealtimeTransportConformanceSuite } from '../../../testing/realtime-transport-conformance.js';
import { createTestRedis, type TestRedis } from '@openora/core/testing';

let redis: TestRedis;
const transports: RedisPubSubRealtimeTransport[] = [];

function makeTransport(serviceName = 'svc'): RedisPubSubRealtimeTransport {
  const transport = new RedisPubSubRealtimeTransport(redis.client, serviceName);
  transports.push(transport);
  return transport;
}

async function settle(ms = 200): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  redis = await createTestRedis();
});

afterEach(async () => {
  await Promise.allSettled(transports.splice(0).map((t) => t.close()));
});

afterAll(async () => {
  await redis.quit();
});

runRealtimeTransportConformanceSuite({
  name: 'RedisPubSubRealtimeTransport',
  create: () => makeTransport(),
  supportsServerSideSubscribe: true,
  addPresence: (transport, channel, entries) => {
    for (const { userId, connectionId } of entries) {
      transport.presence?.join(channel, userId, connectionId);
    }
  },
});

describe('RedisPubSubRealtimeTransport', () => {
  it('fans a removal tombstone out through the same stream', async () => {
    const transport = makeTransport();
    const got: Array<{ id: string; isDeleted: boolean }> = [];
    transport.subscribe('c', (event: { id: string; isDeleted: boolean }) => got.push(event));
    await settle();

    await transport.remove('c', { id: 'message-1', isDeleted: true });
    await vi.waitFor(() => expect(got).toEqual([{ id: 'message-1', isDeleted: true }]));
  });

  it('isolates a throwing subscriber from the others', async () => {
    const transport = makeTransport();
    const got: number[] = [];
    transport.subscribe<number>('c', () => {
      throw new Error('bad subscriber');
    });
    transport.subscribe<number>('c', (e) => got.push(e));
    await settle();

    await expect(transport.publish('c', 7)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(got).toEqual([7]));
  });

  it('tracks presence counts per channel', async () => {
    const transport = makeTransport();
    const room = `room-${randomUUID()}`;
    transport.presence?.join(room, 'u1', 'tab-1');
    transport.presence?.join(room, 'u2', 'tab-1');
    transport.presence?.join(room, 'u2', 'tab-2');
    await vi.waitFor(async () => expect(await transport.presence?.count(room)).toBe(2));

    transport.presence?.leave(room, 'u2', 'tab-1');
    await settle();
    expect(await transport.presence?.count(room)).toBe(2);

    transport.presence?.leave(room, 'u1', 'tab-1');
    await vi.waitFor(async () => expect(await transport.presence?.count(room)).toBe(1));
  });

  it('revokeUserFromChannel drops only that user’s subscription', async () => {
    const transport = makeTransport();
    const kicked: unknown[] = [];
    const kept: unknown[] = [];
    transport.subscribe('c', () => kicked.push(true), 'user-a');
    transport.subscribe('c', () => kept.push(true), 'user-b');
    await settle();

    await transport.publish('c', 1);
    await vi.waitFor(() => {
      expect(kicked).toEqual([true]);
      expect(kept).toEqual([true]);
    });

    transport.revokeUserFromChannel('user-a', 'c');
    await settle();

    await transport.publish('c', 2);
    await settle();
    expect(kicked).toEqual([true]);
    expect(kept).toEqual([true, true]);
  });

  it('prefixes channels with serviceName, so two service names never cross-deliver', async () => {
    const a = makeTransport('svc-a');
    const b = makeTransport('svc-b');
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    a.subscribe('shared-channel', (e) => seenA.push(e));
    b.subscribe('shared-channel', (e) => seenB.push(e));
    await settle();

    await a.publish('shared-channel', 'from-a');
    await vi.waitFor(() => expect(seenA).toEqual(['from-a']));
    await settle();
    expect(seenB).toEqual([]);
  });

  it('cross-process proof: publishing on one instance is received on a separate instance', async () => {
    const redisA = await createTestRedis();
    const redisB = await createTestRedis();
    try {
      const instanceA = new RedisPubSubRealtimeTransport(redisA.client, 'wallet');
      const instanceB = new RedisPubSubRealtimeTransport(redisB.client, 'wallet');
      try {
        const channel = `wallet:balance:${randomUUID()}`;
        const received: unknown[] = [];
        instanceB.subscribe(channel, (event) => received.push(event));
        await settle();

        const signal = {
          eventId: randomUUID(),
          currency: 'USD',
          reason: 'deposit',
        };
        await instanceA.publish(channel, signal);

        await vi.waitFor(() => expect(received).toEqual([signal]), { timeout: 5000 });
      } finally {
        await Promise.allSettled([instanceA.close(), instanceB.close()]);
      }
    } finally {
      await Promise.allSettled([redisA.quit(), redisB.quit()]);
    }
  });

  describe('cross-process presence', () => {
    it('a member joining on instance A is visible to getOnlineUserIds on instance B', async () => {
      const redisA = await createTestRedis();
      const redisB = await createTestRedis();
      try {
        const instanceA = new RedisPubSubRealtimeTransport(redisA.client, 'presence-svc');
        const instanceB = new RedisPubSubRealtimeTransport(redisB.client, 'presence-svc');
        try {
          const channel = `room:${randomUUID()}`;
          instanceA.presence?.join(channel, 'player-1', 'tab-1');

          await vi.waitFor(
            async () => expect(await instanceB.getOnlineUserIds(channel)).toEqual(['player-1']),
            { timeout: 2000 },
          );
        } finally {
          await Promise.allSettled([instanceA.close(), instanceB.close()]);
        }
      } finally {
        await Promise.allSettled([redisA.quit(), redisB.quit()]);
      }
    });

    it('two connections for one member count once, and closing one leaves them online', async () => {
      const redisA = await createTestRedis();
      try {
        const instanceA = new RedisPubSubRealtimeTransport(redisA.client, 'presence-svc');
        try {
          const channel = `room:${randomUUID()}`;
          instanceA.presence?.join(channel, 'player-1', 'tab-1');
          instanceA.presence?.join(channel, 'player-1', 'tab-2');
          await vi.waitFor(async () =>
            expect(await instanceA.getOnlineUserIds(channel)).toEqual(['player-1']),
          );

          instanceA.presence?.leave(channel, 'player-1', 'tab-1');
          await settle();
          expect(await instanceA.getOnlineUserIds(channel)).toEqual(['player-1']);

          instanceA.presence?.leave(channel, 'player-1', 'tab-2');
          await vi.waitFor(async () =>
            expect(await instanceA.getOnlineUserIds(channel)).toEqual([]),
          );
        } finally {
          await instanceA.close();
        }
      } finally {
        await redisA.quit();
      }
    });

    it('excludes anonymous members across instances', async () => {
      const redisA = await createTestRedis();
      const redisB = await createTestRedis();
      try {
        const instanceA = new RedisPubSubRealtimeTransport(redisA.client, 'presence-svc');
        const instanceB = new RedisPubSubRealtimeTransport(redisB.client, 'presence-svc');
        try {
          const channel = `room:${randomUUID()}`;
          instanceA.presence?.join(channel, 'player-1', 'tab-1');
          instanceA.presence?.join(channel, `anonymous:${randomUUID()}`, 'tab-2');

          await vi.waitFor(
            async () => expect(await instanceB.getOnlineUserIds(channel)).toEqual(['player-1']),
            { timeout: 2000 },
          );
        } finally {
          await Promise.allSettled([instanceA.close(), instanceB.close()]);
        }
      } finally {
        await Promise.allSettled([redisA.quit(), redisB.quit()]);
      }
    });

    it('a crashed instance stops contributing members once its entries expire, with no cleanup call', async () => {
      const redisA = await createTestRedis();
      const redisB = await createTestRedis();
      try {
        const instanceA = new RedisPubSubRealtimeTransport(redisA.client, 'presence-svc');
        const instanceB = new RedisPubSubRealtimeTransport(redisB.client, 'presence-svc');
        try {
          const channel = `room:${randomUUID()}`;
          instanceA.presence?.join(channel, 'player-1', 'tab-1');
          await vi.waitFor(
            async () => expect(await instanceB.getOnlineUserIds(channel)).toEqual(['player-1']),
            { timeout: 2000 },
          );

          const PRESENCE_TTL_MS = 45_000;
          const staleScore = Date.now() - PRESENCE_TTL_MS - 1000;
          await redisA.client.zAdd(`oss:rt:presence:presence-svc:${channel}`, {
            score: staleScore,
            value: 'player-1',
          });

          expect(await instanceB.getOnlineUserIds(channel)).toEqual([]);
        } finally {
          await Promise.allSettled([instanceA.close(), instanceB.close()]);
        }
      } finally {
        await Promise.allSettled([redisA.quit(), redisB.quit()]);
      }
    });
  });
});
