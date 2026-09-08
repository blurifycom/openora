import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { MessageBrokerAdapter, EventEnvelope } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '@openora/core/server/migrate';
import { OutboxRelay } from '../relay.js';
import { eventOutbox } from '../schema.js';

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
  await db.drizzle.db.execute(sql`TRUNCATE ${eventOutbox} RESTART IDENTITY CASCADE`);
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

  it('leaves the row pending when broker.publish throws', async () => {
    const row = await seedRow();
    const broker: MessageBrokerAdapter = {
      publish: vi.fn(async () => {
        throw new Error('broker unreachable');
      }),
      subscribe: () => () => {},
      close: async () => {},
    };
    const relay = new OutboxRelay(db.drizzle.db, broker);

    await expect(relay.drainOnce()).rejects.toThrow('broker unreachable');

    const [after] = await db.drizzle.db
      .select()
      .from(eventOutbox)
      .where(eq(eventOutbox.eventId, row.eventId));
    expect(after?.publishedAt).toBeNull();
  });

  it('keeps rows published before a mid-batch publish failure, retrying only the failing row', async () => {
    const a = await seedRow({ occurredAt: new Date('2026-01-01T00:00:00.000Z') });
    const b = await seedRow({ occurredAt: new Date('2026-01-01T00:00:01.000Z') });
    const c = await seedRow({ occurredAt: new Date('2026-01-01T00:00:02.000Z') });
    const broker = brokerThat((envelope) => {
      if (envelope.eventId === b.eventId) {
        throw new Error('broker unreachable');
      }
    });
    const relay = new OutboxRelay(db.drizzle.db, broker);

    await expect(relay.drainOnce()).rejects.toThrow('broker unreachable');

    const afterFailure = await rowsById();
    expect(afterFailure.get(a.eventId)?.publishedAt).not.toBeNull();
    expect(afterFailure.get(b.eventId)?.publishedAt).toBeNull();
    expect(afterFailure.get(c.eventId)?.publishedAt).toBeNull();

    const publishSpy = broker.publish as ReturnType<typeof vi.fn>;
    publishSpy.mockClear();
    publishSpy.mockImplementation(async () => undefined);
    const n = await relay.drainOnce();

    expect(n).toBe(2);
    expect(publishSpy).toHaveBeenCalledTimes(2);
    expect(publishSpy.mock.calls.map((call) => call[0].eventId)).toEqual([b.eventId, c.eventId]);
    const afterRetry = await rowsById();
    expect([...afterRetry.values()].every((r) => r.publishedAt !== null)).toBe(true);
  });
});

/** A promise plus the function that settles it, for coordinating with a blocked publish. */
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve: () => resolve() };
}

// The poll loop is what actually delivers events in production; drainOnce is only the
// unit of work it repeats. An error escaping the interval callback would kill the loop
// silently, and a stop() that returned while a publish was still in flight would let a
// shutting-down process tear the connection out from under it.
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
      // More than one: a loop that died on the first rejection would report exactly once.
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
