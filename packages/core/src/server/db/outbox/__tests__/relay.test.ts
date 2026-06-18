import { describe, it, expect, vi } from 'vitest';
import { OutboxRelay } from '../relay.js';
import type { DrizzleDb } from '../../drizzle.js';
import type { MessageBrokerAdapter } from '../../../../contracts/adapters/index.js';

type Row = {
  eventId: string;
  topic: string;
  payload: unknown;
  schemaVersion: number;
  traceId: string | null;
  orderingKey: string | null;
  occurredAt: Date;
  publishedAt: Date | null;
};

function row(id: string, topic: string): Row {
  return {
    eventId: id,
    topic,
    payload: { id },
    schemaVersion: 1,
    traceId: null,
    orderingKey: null,
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    publishedAt: null,
  };
}

// Fake drizzle chain: update().set().where() identifies the row via lastPublishedId
// captured by the broker spy, so select and update stay coordinated without real DB.
function harness(rows: Row[]) {
  let lastPublishedId: string | null = null;
  const broker: MessageBrokerAdapter = {
    publish: vi.fn(async (env) => {
      lastPublishedId = env.eventId;
    }),
    subscribe: () => () => {},
    close: async () => {},
  };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: async () => rows.filter((r) => r.publishedAt === null) }),
        }),
      }),
    }),
    update: () => ({
      set: (values: { publishedAt: Date }) => ({
        where: async () => {
          const r = rows.find((x) => x.eventId === lastPublishedId);
          if (r) r.publishedAt = values.publishedAt;
        },
      }),
    }),
  } as unknown as DrizzleDb;
  return { db, broker };
}

describe('OutboxRelay.drainOnce', () => {
  it('publishes pending rows in order and marks them published', async () => {
    const rows = [row('a', 'wallet.deposit.completed'), row('b', 'wallet.withdrawal.completed')];
    const { db, broker } = harness(rows);
    const relay = new OutboxRelay(db, broker);

    const n = await relay.drainOnce();

    expect(n).toBe(2);
    expect(broker.publish).toHaveBeenCalledTimes(2);
    expect((broker.publish as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      eventId: 'a',
      topic: 'wallet.deposit.completed',
    });
    expect(rows.every((r) => r.publishedAt !== null)).toBe(true);
  });

  it('is a no-op when nothing is pending', async () => {
    const rows = [{ ...row('a', 'x'), publishedAt: new Date() }];
    const { db, broker } = harness(rows);
    const relay = new OutboxRelay(db, broker);

    const n = await relay.drainOnce();

    expect(n).toBe(0);
    expect(broker.publish).not.toHaveBeenCalled();
  });
});
