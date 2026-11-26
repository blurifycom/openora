import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import type { BrokerHandler, EventEnvelope, MessageBrokerAdapter } from '@openora/core/contracts';
import { migrate as migrateEngine } from '@openora/core/server/migrate';
import { createTestDb, type TestDb } from '../../../../testing/real-infra.js';
import { createEventBus } from '../../../kernel/event-bus.js';
import { DrizzleOutboxWriter } from '../writer.js';
import { DrizzleProcessedEventLog } from '../processed-events.js';
import { eventOutbox, processedEvents } from '../schema.js';
import { OutboxRelay, eventOutboxBacklog, oldestUnrelayedEvent } from '../relay.js';

const loggerCalls = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));

vi.mock('../../../kernel/logger.js', () => ({
  createLogger: () => ({ ...loggerCalls, info: vi.fn(), debug: vi.fn() }),
}));

const DAY_MS = 24 * 60 * 60_000;

const opened: TestDb[] = [];

afterEach(async () => {
  loggerCalls.warn.mockClear();
  loggerCalls.error.mockClear();
  for (const testDb of opened.splice(0)) {
    await testDb.drop();
  }
});

async function freshDb() {
  const testDb = await createTestDb([migrateEngine]);
  opened.push(testDb);
  return testDb.drizzle.db;
}

type Db = Awaited<ReturnType<typeof freshDb>>;

type RecordingBroker = MessageBrokerAdapter & { published: EventEnvelope[] };

function recordingBroker(
  publish: (envelope: EventEnvelope) => Promise<void> = () => Promise.resolve(),
): RecordingBroker {
  const published: EventEnvelope[] = [];
  const handlers = new Map<string, Set<BrokerHandler>>();
  return {
    published,
    async publish(item) {
      await publish(item);
      published.push(item);
      for (const handler of handlers.get(item.topic) ?? []) {
        await handler(item);
      }
    },
    subscribe(topic, handler) {
      const set = handlers.get(topic) ?? new Set<BrokerHandler>();
      set.add(handler);
      handlers.set(topic, set);
      return () => set.delete(handler);
    },
    async close() {},
  };
}

const failingBroker = () => recordingBroker(() => Promise.reject(new Error('broker down')));

const envelope = (overrides: Partial<EventEnvelope> = {}): EventEnvelope => ({
  eventId: randomUUID(),
  topic: `relay.test.${randomUUID()}`,
  payload: { note: randomUUID() },
  occurredAt: new Date().toISOString(),
  schemaVersion: 1,
  ...overrides,
});

async function enqueue(db: Db, ...envelopes: EventEnvelope[]) {
  await db.transaction(async (tx) => {
    for (const item of envelopes) {
      await new DrizzleOutboxWriter().write(tx, item);
    }
  });
}

const outboxRow = async (db: Db, eventId: string) => {
  const [row] = await db.select().from(eventOutbox).where(eq(eventOutbox.eventId, eventId));
  return row;
};

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe('relay', () => {
  it('a row committed with the business write is published to the broker after commit', async () => {
    const db = await freshDb();
    const broker = recordingBroker();
    const relay = new OutboxRelay(db, broker);
    const item = envelope();
    let drainedBeforeCommit = -1;
    await db.transaction(async (tx) => {
      await new DrizzleOutboxWriter().write(tx, item);
      drainedBeforeCommit = await relay.drainOnce();
    });
    expect(drainedBeforeCommit).toBe(0);
    expect(broker.published).toEqual([]);
    expect(await relay.drainOnce()).toBe(1);
    expect(broker.published).toEqual([item]);
    expect((await outboxRow(db, item.eventId))?.publishedAt).toBeInstanceOf(Date);
  });

  it('a rolled back transaction publishes nothing', async () => {
    const db = await freshDb();
    const broker = recordingBroker();
    const item = envelope();
    await expect(
      db.transaction(async (tx) => {
        await new DrizzleOutboxWriter().write(tx, item);
        throw new Error('business write failed');
      }),
    ).rejects.toThrow('business write failed');
    expect(await new OutboxRelay(db, broker).drainOnce()).toBe(0);
    expect(broker.published).toEqual([]);
    expect(await outboxRow(db, item.eventId)).toBeUndefined();
  });

  it('a row is marked published only after the broker publish resolves', async () => {
    const db = await freshDb();
    const item = envelope();
    await enqueue(db, item);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const publishStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const broker = recordingBroker(async () => {
      started();
      await gate;
    });
    const draining = new OutboxRelay(db, broker).drainOnce();
    await publishStarted;
    const inFlight = await outboxRow(db, item.eventId);
    expect(inFlight?.publishedAt).toBeNull();
    expect(inFlight?.claimedAt).toBeInstanceOf(Date);
    release();
    expect(await draining).toBe(1);
    expect((await outboxRow(db, item.eventId))?.publishedAt).toBeInstanceOf(Date);
  });

  it('a failing row is reported and released while the rest of the batch is published', async () => {
    const db = await freshDb();
    const base = Date.now() - 10_000;
    const [first, poison, last] = [0, 1, 2].map((offset) =>
      envelope({ occurredAt: new Date(base + offset).toISOString() }),
    );
    if (!first || !poison || !last) {
      throw new Error('fixture');
    }
    await enqueue(db, first, poison, last);
    const errors: unknown[] = [];
    const broker = recordingBroker(async (item) => {
      if (item.eventId === poison.eventId) {
        throw new Error('broker rejected the poison row');
      }
    });
    const relay = new OutboxRelay(db, broker, { onError: (err) => errors.push(err) });
    expect(await relay.drainOnce()).toBe(2);
    expect(broker.published.map((item) => item.eventId)).toEqual([first.eventId, last.eventId]);
    expect(errors).toEqual([new Error('broker rejected the poison row')]);
    const poisoned = await outboxRow(db, poison.eventId);
    expect(poisoned?.publishedAt).toBeNull();
    expect(poisoned?.claimedAt).toBeNull();
    expect(poisoned?.attempts).toBe(1);
    expect((await outboxRow(db, first.eventId))?.publishedAt).toBeInstanceOf(Date);
    expect((await outboxRow(db, last.eventId))?.publishedAt).toBeInstanceOf(Date);
    expect(await new OutboxRelay(db, recordingBroker()).drainOnce()).toBe(1);
  });

  it('two concurrent relays never claim the same row inside its lease', async () => {
    const db = await freshDb();
    const items = Array.from({ length: 24 }, (_, index) =>
      envelope({ occurredAt: new Date(Date.now() - 60_000 + index).toISOString() }),
    );
    await enqueue(db, ...items);
    const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
    const brokerA = recordingBroker(pause);
    const brokerB = recordingBroker(pause);
    const relayA = new OutboxRelay(db, brokerA, { batchSize: 5 });
    const relayB = new OutboxRelay(db, brokerB, { batchSize: 5 });
    const drainAll = async (relay: OutboxRelay) => {
      while ((await relay.drainOnce()) > 0) {
        await pause();
      }
    };
    await Promise.all([drainAll(relayA), drainAll(relayB)]);
    const ids = [...brokerA.published, ...brokerB.published].map((item) => item.eventId);
    expect(ids).toHaveLength(items.length);
    expect(new Set(ids)).toEqual(new Set(items.map((item) => item.eventId)));
    const rows = await db.select().from(eventOutbox);
    expect(rows.every((row) => row.attempts === 1 && row.publishedAt !== null)).toBe(true);
  });

  it('a row claimed by a dead relay is republished after the lease expires', async () => {
    const db = await freshDb();
    const item = envelope();
    await enqueue(db, item);
    const dying = new OutboxRelay(
      db,
      recordingBroker(() => new Promise<void>(() => {})),
    );
    void dying.drainOnce();
    await vi.waitFor(async () => {
      expect((await outboxRow(db, item.eventId))?.claimedAt).toBeInstanceOf(Date);
    });
    const survivorBroker = recordingBroker();
    const survivor = new OutboxRelay(db, survivorBroker);
    expect(await survivor.drainOnce()).toBe(0);
    expect(survivorBroker.published).toEqual([]);
    await db
      .update(eventOutbox)
      .set({ claimedAt: sql`now() - interval '31 seconds'` })
      .where(eq(eventOutbox.eventId, item.eventId));
    expect(await survivor.drainOnce()).toBe(1);
    expect(survivorBroker.published).toEqual([item]);
    const row = await outboxRow(db, item.eventId);
    expect(row?.attempts).toBe(2);
    expect(row?.publishedAt).toBeInstanceOf(Date);
  });

  it('the same event delivered twice is processed once through the dedupe record', async () => {
    const db = await freshDb();
    const broker = recordingBroker();
    const bus = createEventBus({
      broker,
      outbox: new DrizzleOutboxWriter(),
      processedEvents: new DrizzleProcessedEventLog(db),
    });
    const topic = `relay.test.${randomUUID()}`;
    const handled: unknown[] = [];
    bus.on(topic, (payload) => void handled.push(payload), { consumer: 'svc/plugin/dedupe' });
    const item = envelope({ topic, payload: { amount: '10.00' } });
    await enqueue(db, item);
    const relay = new OutboxRelay(db, broker);
    expect(await relay.drainOnce()).toBe(1);
    await db
      .update(eventOutbox)
      .set({ publishedAt: null, claimedAt: null })
      .where(eq(eventOutbox.eventId, item.eventId));
    expect(await relay.drainOnce()).toBe(1);
    expect(broker.published.map((published) => published.eventId)).toEqual([
      item.eventId,
      item.eventId,
    ]);
    expect(handled).toEqual([{ amount: '10.00' }]);
    const records = await db
      .select()
      .from(processedEvents)
      .where(eq(processedEvents.eventId, item.eventId));
    expect(records).toHaveLength(1);
    expect(records[0]?.consumer).toBe('svc/plugin/dedupe');
  });

  it('published rows and dedupe records are pruned after their retention', async () => {
    const db = await freshDb();
    const stale = envelope();
    const recent = envelope();
    const pending = envelope({ occurredAt: ago(30 * DAY_MS) });
    await enqueue(db, stale, recent, pending);
    await db
      .update(eventOutbox)
      .set({ publishedAt: new Date(Date.now() - 8 * DAY_MS) })
      .where(eq(eventOutbox.eventId, stale.eventId));
    await db
      .update(eventOutbox)
      .set({ publishedAt: new Date(Date.now() - 6 * DAY_MS) })
      .where(eq(eventOutbox.eventId, recent.eventId));
    await db.insert(processedEvents).values([
      { eventId: 'old', consumer: 'c', processedAt: new Date(Date.now() - 9 * DAY_MS) },
      { eventId: 'inside-margin', consumer: 'c', processedAt: new Date(Date.now() - 7.5 * DAY_MS) },
      { eventId: 'fresh', consumer: 'c', processedAt: new Date() },
    ]);
    await new OutboxRelay(db, failingBroker(), { onError: () => undefined }).drainOnce();
    const remaining = await db
      .select({ eventId: eventOutbox.eventId })
      .from(eventOutbox)
      .where(inArray(eventOutbox.eventId, [stale.eventId, recent.eventId, pending.eventId]));
    expect(remaining.map((row) => row.eventId).sort()).toEqual(
      [recent.eventId, pending.eventId].sort(),
    );
    const records = await db.select().from(processedEvents);
    expect(records.map((row) => row.eventId).sort()).toEqual(['fresh', 'inside-margin']);
  });
});

describe('backlog', () => {
  it('the backlog reports pending rows and the age of the oldest on the database clock', async () => {
    const db = await freshDb();
    expect(await eventOutboxBacklog(db)).toEqual({ pending: 0, oldestPendingAgeMs: 0 });
    await db.insert(eventOutbox).values([
      {
        eventId: randomUUID(),
        topic: 't',
        payload: {},
        occurredAt: sql`now() - interval '5 minutes'`,
      },
      {
        eventId: randomUUID(),
        topic: 't',
        payload: {},
        occurredAt: sql`now() - interval '1 minute'`,
        claimedAt: sql`now()`,
      },
      {
        eventId: randomUUID(),
        topic: 't',
        payload: {},
        occurredAt: sql`now() - interval '1 hour'`,
        claimedAt: sql`now()`,
        publishedAt: sql`now()`,
      },
    ]);
    const backlog = await eventOutboxBacklog(db);
    expect(backlog.pending).toBe(2);
    expect(backlog.oldestPendingAgeMs).toBeGreaterThanOrEqual(300_000);
    expect(backlog.oldestPendingAgeMs).toBeLessThan(310_000);
  });

  it('lag is reported only when the oldest unpublished row is older than the threshold', async () => {
    const lagging = await freshDb();
    await enqueue(lagging, envelope({ occurredAt: ago(5 * 60_000) }));
    await new OutboxRelay(lagging, failingBroker(), { onError: () => undefined }).drainOnce();
    expect(loggerCalls.warn).toHaveBeenCalledTimes(1);
    expect(loggerCalls.warn.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ pending: 1, oldestPendingAgeMs: expect.any(Number) }),
    );
    loggerCalls.warn.mockClear();
    const healthy = await freshDb();
    await enqueue(healthy, envelope({ occurredAt: ago(10_000) }));
    await new OutboxRelay(healthy, failingBroker(), { onError: () => undefined }).drainOnce();
    expect(loggerCalls.warn).not.toHaveBeenCalled();
  });

  it('lag is reported at most once per check interval', async () => {
    const db = await freshDb();
    await enqueue(db, envelope({ occurredAt: ago(5 * 60_000) }));
    const relay = new OutboxRelay(db, failingBroker(), { onError: () => undefined });
    await relay.drainOnce();
    await relay.drainOnce();
    await relay.drainOnce();
    expect(loggerCalls.warn).toHaveBeenCalledTimes(1);
  });

  it('oldestUnrelayedEvent returns nothing when everything is published', async () => {
    const db = await freshDb();
    const older = envelope({ occurredAt: ago(60_000) });
    const newer = envelope({ occurredAt: ago(1_000) });
    await enqueue(db, older, newer);
    expect((await oldestUnrelayedEvent(db))?.eventId).toBe(older.eventId);
    await new OutboxRelay(db, recordingBroker()).drainOnce();
    expect(await oldestUnrelayedEvent(db)).toBeUndefined();
  });
});
