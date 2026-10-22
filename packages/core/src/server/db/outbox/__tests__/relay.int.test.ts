import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { MessageBrokerAdapter, EventEnvelope } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '@openora/core/server/migrate';
import { OutboxRelay } from '../relay.js';
import { eventOutbox, processedEvents } from '../schema.js';
import { EVENT_RETENTION_MS } from '../../../kernel/event-bus.js';

let db: TestDb;

async function seedRow(overrides: Partial<typeof eventOutbox.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(eventOutbox)
    .values({
      eventId: randomUUID(),
      topic: 'wallet.deposit.completed',
      payload: { id: randomUUID() },
      occurredAt: new Date(),
      ...overrides,
    })
    .returning();
  return row!;
}

function brokerThat(onPublish?: (envelope: EventEnvelope) => void): MessageBrokerAdapter {
  return {
    publish: vi.fn(async (envelope: EventEnvelope) => {
      onPublish?.(envelope);
    }),
    subscribe: () => () => {},
    close: async () => {},
  };
}

async function rowsById() {
  const rows = await db.drizzle.db.select().from(eventOutbox);
  return new Map(rows.map((r) => [r.eventId, r]));
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${eventOutbox}, ${processedEvents} RESTART IDENTITY CASCADE`,
  );
});

describe('OutboxRelay.drainOnce (real PG)', () => {
  it('publishes pending rows in order and marks them published', async () => {
    const a = await seedRow({
      topic: 'wallet.deposit.completed',
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await seedRow({
      topic: 'wallet.withdrawal.completed',
      occurredAt: new Date('2026-01-01T00:00:01.000Z'),
    });
    const broker = brokerThat();
    const relay = new OutboxRelay(db.drizzle.db, broker);

    const n = await relay.drainOnce();

    expect(n).toBe(2);
    expect(broker.publish).toHaveBeenCalledTimes(2);
    expect((broker.publish as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      eventId: a.eventId,
      topic: a.topic,
    });
    const rows = await db.drizzle.db.select().from(eventOutbox);
    expect(rows.every((r) => r.publishedAt !== null)).toBe(true);
  });

  it('is a no-op when nothing is pending', async () => {
    await seedRow({ publishedAt: new Date() });
    const broker = brokerThat();
    const relay = new OutboxRelay(db.drizzle.db, broker);

    const n = await relay.drainOnce();

    expect(n).toBe(0);
    expect(broker.publish).not.toHaveBeenCalled();
  });

  it('leaves the row pending and its lease released when broker.publish throws', async () => {
    const row = await seedRow();
    const broker: MessageBrokerAdapter = {
      publish: vi.fn(async () => {
        throw new Error('broker unreachable');
      }),
      subscribe: () => () => {},
      close: async () => {},
    };
    const errors: unknown[] = [];
    const relay = new OutboxRelay(db.drizzle.db, broker, { onError: (err) => errors.push(err) });

    await expect(relay.drainOnce()).resolves.toBe(0);

    const [after] = await db.drizzle.db
      .select()
      .from(eventOutbox)
      .where(eq(eventOutbox.eventId, row.eventId));
    expect(after?.publishedAt).toBeNull();
    expect(after?.claimedAt).toBeNull();
    expect(after?.attempts).toBe(1);
    expect(errors[0]).toMatchObject({ message: 'broker unreachable' });
  });

  it('does not let a failing row block the rest of the batch', async () => {
    const a = await seedRow({ occurredAt: new Date('2026-01-01T00:00:00.000Z') });
    const b = await seedRow({ occurredAt: new Date('2026-01-01T00:00:01.000Z') });
    const c = await seedRow({ occurredAt: new Date('2026-01-01T00:00:02.000Z') });
    const broker = brokerThat((envelope) => {
      if (envelope.eventId === b.eventId) {
        throw new Error('broker unreachable');
      }
    });
    const relay = new OutboxRelay(db.drizzle.db, broker, { onError: () => undefined });

    await expect(relay.drainOnce()).resolves.toBe(2);

    const afterFailure = await rowsById();
    expect(afterFailure.get(a.eventId)?.publishedAt).not.toBeNull();
    expect(afterFailure.get(b.eventId)?.publishedAt).toBeNull();
    expect(afterFailure.get(c.eventId)?.publishedAt).not.toBeNull();

    const publishSpy = broker.publish as ReturnType<typeof vi.fn>;
    publishSpy.mockClear();
    publishSpy.mockImplementation(async () => undefined);
    const n = await relay.drainOnce();

    expect(n).toBe(1);
    expect(publishSpy.mock.calls.map((call) => call[0].eventId)).toEqual([b.eventId]);
    const afterRetry = await rowsById();
    expect([...afterRetry.values()].every((r) => r.publishedAt !== null)).toBe(true);
  });

  it('skips a row claimed by another relay until its lease expires', async () => {
    const fresh = await seedRow({ claimedAt: new Date() });
    const stale = await seedRow({ claimedAt: new Date(Date.now() - 60_000) });
    const broker = brokerThat();
    const relay = new OutboxRelay(db.drizzle.db, broker);

    const n = await relay.drainOnce();

    expect(n).toBe(1);
    expect((broker.publish as ReturnType<typeof vi.fn>).mock.calls[0][0].eventId).toBe(
      stale.eventId,
    );
    expect((await rowsById()).get(fresh.eventId)?.publishedAt).toBeNull();
  });

  it('hands back the rest of a batch once half its lease is spent publishing', async () => {
    const first = await seedRow({ occurredAt: new Date('2026-01-01T00:00:00.000Z') });
    const second = await seedRow({ occurredAt: new Date('2026-01-01T00:00:01.000Z') });
    let clock = Date.now();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    // The first publish takes 20s, past the 15s budget of a 30s lease.
    const broker = brokerThat(() => {
      clock += 20_000;
    });
    const relay = new OutboxRelay(db.drizzle.db, broker);

    try {
      await expect(relay.drainOnce()).resolves.toBe(1);
    } finally {
      now.mockRestore();
    }

    expect(broker.publish).toHaveBeenCalledTimes(1);
    const rows = await rowsById();
    expect(rows.get(first.eventId)?.publishedAt).not.toBeNull();
    expect(rows.get(second.eventId)?.publishedAt).toBeNull();
    expect(rows.get(second.eventId)?.claimedAt).toBeNull();
  });

  it('publishes each row exactly once across two concurrent relays', async () => {
    const seeded = await Promise.all(Array.from({ length: 50 }, () => seedRow()));
    const published: string[] = [];
    // A slow publish holds each relay's claim open so the two drains overlap.
    const slowBroker: MessageBrokerAdapter = {
      publish: async (envelope) => {
        await new Promise((r) => setTimeout(r, 2));
        published.push(envelope.eventId);
      },
      subscribe: () => () => {},
      close: async () => {},
    };
    const relayA = new OutboxRelay(db.drizzle.db, slowBroker, { batchSize: 30 });
    const relayB = new OutboxRelay(db.drizzle.db, slowBroker, { batchSize: 30 });

    const counts: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      counts.push(...(await Promise.all([relayA.drainOnce(), relayB.drainOnce()])));
    }

    expect(counts.reduce((sum, n) => sum + n, 0)).toBe(seeded.length);
    expect(new Set(published).size).toBe(published.length);
    expect(new Set(published)).toEqual(new Set(seeded.map((r) => r.eventId)));
  });

  it('prunes published rows and processed_events past retention, keeping the rest', async () => {
    const longAgo = new Date(Date.now() - EVENT_RETENTION_MS - 60_000);
    const oldPublished = await seedRow({ publishedAt: longAgo });
    const recentPublished = await seedRow({ publishedAt: new Date() });
    const oldPending = await seedRow({ occurredAt: longAgo });
    await db.drizzle.db.insert(processedEvents).values([
      {
        eventId: randomUUID(),
        consumer: 'old',
        processedAt: new Date(Date.now() - EVENT_RETENTION_MS - 25 * 60 * 60_000),
      },
      // Kept a day past the stream retention: its entry may still be pending and redelivered.
      { eventId: randomUUID(), consumer: 'just-past-retention', processedAt: longAgo },
      { eventId: randomUUID(), consumer: 'recent' },
    ]);
    const relay = new OutboxRelay(db.drizzle.db, brokerThat());

    await relay.drainOnce();

    const remaining = await rowsById();
    expect(remaining.has(oldPublished.eventId)).toBe(false);
    expect(remaining.has(recentPublished.eventId)).toBe(true);
    expect(remaining.get(oldPending.eventId)?.publishedAt).not.toBeNull();
    const consumers = await db.drizzle.db.select().from(processedEvents);
    expect(consumers.map((r) => r.consumer).sort()).toEqual(['just-past-retention', 'recent']);
  });
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve: () => resolve() };
}

describe('OutboxRelay poll loop (real PG)', () => {
  it('publishes on its own, with nobody calling drainOnce', async () => {
    const row = await seedRow();
    const relay = new OutboxRelay(db.drizzle.db, brokerThat(), { intervalMs: 10 });

    relay.start();
    try {
      await vi.waitFor(async () => {
        expect((await rowsById()).get(row.eventId)?.publishedAt).not.toBeNull();
      });
    } finally {
      await relay.stop();
    }
  });

  it('drains a backlog larger than one batch within a single tick', async () => {
    const rows = await Promise.all(Array.from({ length: 5 }, () => seedRow()));
    const relay = new OutboxRelay(db.drizzle.db, brokerThat(), { intervalMs: 1000, batchSize: 2 });

    relay.start();
    try {
      // One tick fires at ~1s; the next would be ~2s. One batch per tick would leave rows pending.
      await vi.waitFor(
        async () => {
          const byId = await rowsById();
          expect(rows.every((r) => byId.get(r.eventId)?.publishedAt)).toBe(true);
        },
        { timeout: 1800 },
      );
    } finally {
      await relay.stop();
    }
  });

  it('reports a failing drain to onError and keeps polling', async () => {
    await seedRow();
    const errors: unknown[] = [];
    const broker = brokerThat(() => {
      throw new Error('broker unreachable');
    });
    const relay = new OutboxRelay(db.drizzle.db, broker, {
      intervalMs: 10,
      onError: (err) => errors.push(err),
    });

    relay.start();
    try {
      await vi.waitFor(() => expect(errors.length).toBeGreaterThan(1));
    } finally {
      await relay.stop();
    }
    expect(errors[0]).toMatchObject({ message: 'broker unreachable' });
  });

  it('stops the timer but waits for the drain already in flight', async () => {
    await seedRow();
    const publishStarted = deferred();
    const releasePublish = deferred();
    const broker: MessageBrokerAdapter = {
      publish: vi.fn(async () => {
        publishStarted.resolve();
        await releasePublish.promise;
      }),
      subscribe: () => () => {},
      close: async () => {},
    };
    const relay = new OutboxRelay(db.drizzle.db, broker, { intervalMs: 10 });

    relay.start();
    await publishStarted.promise;

    let stopped = false;
    const stopping = relay.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(stopped).toBe(false);

    releasePublish.resolve();
    await stopping;
    expect(stopped).toBe(true);
  });
});
