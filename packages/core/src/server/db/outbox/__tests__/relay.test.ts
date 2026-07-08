import { describe, it, expect, vi } from 'vitest';
import { mock } from '../../../../testing/mock.js';
import { OutboxRelay } from '../relay.js';
import type { DrizzleDb } from '../../drizzle.js';
import type { MessageBrokerAdapter } from '@openora/core/contracts';

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

// Fake drizzle: transaction() answers the SKIP LOCKED claim select; each row is then
// marked via a top-level update(). trackPublish links that update() to the row the
// broker just published, so a mid-batch throw leaves already-marked rows published.
function harness(rows: Row[]) {
  let lastPublishedId: string | null = null;

  const db = mock<DrizzleDb>({
    transaction: async (callback: (t: unknown) => Promise<Row[]>) =>
      callback({
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => ({
                  for: async () =>
                    rows.filter((r) => r.publishedAt === null).map((r) => ({ ...r })),
                }),
              }),
            }),
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
  });

  return { db, trackPublish: (eventId: string) => (lastPublishedId = eventId) };
}

function brokerThat(
  trackPublish: (eventId: string) => void,
  onPublish?: (eventId: string) => void,
): MessageBrokerAdapter {
  return {
    publish: vi.fn(async (env) => {
      trackPublish(env.eventId);
      onPublish?.(env.eventId);
    }),
    subscribe: () => () => {},
    close: async () => {},
  };
}

describe('OutboxRelay.drainOnce', () => {
  it('publishes pending rows in order and marks them published', async () => {
    const rows = [row('a', 'wallet.deposit.completed'), row('b', 'wallet.withdrawal.completed')];
    const { db, trackPublish } = harness(rows);
    const broker = brokerThat(trackPublish);
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
    const { db, trackPublish } = harness(rows);
    const broker = brokerThat(trackPublish);
    const relay = new OutboxRelay(db, broker);

    const n = await relay.drainOnce();

    expect(n).toBe(0);
    expect(broker.publish).not.toHaveBeenCalled();
  });

  it('leaves the row pending when broker.publish throws', async () => {
    const rows = [row('a', 'wallet.deposit.completed')];
    const { db, trackPublish } = harness(rows);
    const broker: MessageBrokerAdapter = {
      publish: vi.fn(async (env) => {
        trackPublish(env.eventId);
        throw new Error('broker unreachable');
      }),
      subscribe: () => () => {},
      close: async () => {},
    };
    const relay = new OutboxRelay(db, broker);

    await expect(relay.drainOnce()).rejects.toThrow('broker unreachable');

    expect(rows[0]?.publishedAt).toBeNull();
  });

  it('keeps rows published before a mid-batch publish failure, retrying only the failing row', async () => {
    const rows = [
      row('a', 'wallet.deposit.completed'),
      row('b', 'wallet.withdrawal.completed'),
      row('c', 'wallet.deposit.completed'),
    ];
    const { db, trackPublish } = harness(rows);
    const broker = brokerThat(trackPublish, (eventId) => {
      if (eventId === 'b') throw new Error('broker unreachable');
    });
    const relay = new OutboxRelay(db, broker);

    await expect(relay.drainOnce()).rejects.toThrow('broker unreachable');

    expect(rows[0]?.publishedAt).not.toBeNull(); // a - published before the failure
    expect(rows[1]?.publishedAt).toBeNull(); // b - failed
    expect(rows[2]?.publishedAt).toBeNull(); // c - never reached

    const publishSpy = broker.publish as ReturnType<typeof vi.fn>;
    publishSpy.mockClear();
    publishSpy.mockImplementation(async (env) => trackPublish(env.eventId));
    const n = await relay.drainOnce();

    expect(n).toBe(2);
    expect(publishSpy).toHaveBeenCalledTimes(2);
    expect(publishSpy.mock.calls.map((c) => c[0].eventId)).toEqual(['b', 'c']);
    expect(rows.every((r) => r.publishedAt !== null)).toBe(true);
  });
});
