import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { RedisStreamsBroker } from '../redis-streams-broker.js';
import type { RedisClient } from '../redis-client.js';
import { mock } from '../../../testing/mock.js';
import type { EventEnvelope } from '@openora/core/contracts';

type Entry = { id: string; message: Record<string, string> };

type RawStreamsClient = {
  isReady: boolean;
  on: Mock;
  connect: Mock;
  destroy: Mock;
  duplicate: Mock;
  xAdd: Mock;
  xGroupCreate: Mock;
  xReadGroup: Mock;
  xAck: Mock;
  xAutoClaim: Mock;
};

// In-memory Redis Streams double: one Map<streamKey, entries[]> shared by the root
// client and every client.duplicate() (mirrors duplicate() opening a second
// connection to the SAME server/data), plus a per-(streamKey, group) read cursor.
// A blocked xReadGroup call parks on a per-stream waiter list, woken by the next
// xAdd (new data) or destroy() (reader torn down) - no timers, fully deterministic.
//
// ponytail: xGroupCreate always seeds the cursor at 0 (delivers full stream
// history) rather than real Redis '$' semantics (new-entries-only from creation
// time) - every test here subscribes before publishing, so the two are
// indistinguishable; upgrade if a test ever needs pre-existing-history semantics.
function fakeStreamsClient() {
  const streams = new Map<string, Entry[]>();
  const cursors = new Map<string, number>();
  const waiters = new Map<string, Array<() => void>>();
  const duplicates: RawStreamsClient[] = [];
  let seq = 0;

  function wake(key: string): void {
    const pending = waiters.get(key) ?? [];
    waiters.set(key, []);
    for (const resolve of pending) {
      resolve();
    }
  }

  function makeRaw(): RawStreamsClient {
    let destroyed = false;
    const raw: RawStreamsClient = {
      isReady: true,
      on: vi.fn(),
      connect: vi.fn(async () => raw),
      destroy: vi.fn(() => {
        destroyed = true;
        for (const key of streams.keys()) {
          wake(key);
        }
      }),
      duplicate: vi.fn(() => {
        const dup = makeRaw();
        duplicates.push(dup);
        return mock<RedisClient>(dup);
      }),
      xAdd: vi.fn(async (key: string, _id: string, message: Record<string, string>) => {
        const entries = streams.get(key) ?? [];
        const entryId = `${++seq}-0`;
        entries.push({ id: entryId, message });
        streams.set(key, entries);
        wake(key);
        return entryId;
      }),
      xGroupCreate: vi.fn(async (key: string, group: string) => {
        const cursorKey = `${key}::${group}`;
        if (!cursors.has(cursorKey)) {
          cursors.set(cursorKey, 0);
        }
        return 'OK';
      }),
      xReadGroup: vi.fn(
        async (
          group: string,
          _consumer: string,
          stream: { key: string; id: string },
          opts?: { COUNT?: number },
        ) => {
          const { key } = stream;
          const cursorKey = `${key}::${group}`;
          for (;;) {
            if (destroyed) {
              throw new Error('reader destroyed');
            }
            const entries = streams.get(key) ?? [];
            const cursor = cursors.get(cursorKey) ?? 0;
            if (cursor < entries.length) {
              const slice = entries.slice(cursor, cursor + (opts?.COUNT ?? entries.length));
              cursors.set(cursorKey, cursor + slice.length);
              return [{ name: key, messages: slice }];
            }
            await new Promise<void>((resolve) => {
              const pending = waiters.get(key) ?? [];
              pending.push(resolve);
              waiters.set(key, pending);
            });
          }
        },
      ),
      xAck: vi.fn(async () => 1),
      xAutoClaim: vi.fn(async () => ({ nextId: '0-0', messages: [], deletedMessages: [] })),
    };
    return raw;
  }

  const root = makeRaw();
  return { client: mock<RedisClient>(root), root, duplicates };
}

function makeEnvelope(topic: string, overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    eventId: 'evt-1',
    topic,
    payload: { ok: true },
    occurredAt: '2026-01-01T00:00:00.000Z',
    schemaVersion: 1,
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('RedisStreamsBroker', () => {
  it('publish XADDs the serialized envelope with a MAXLEN trim, on the shared client', async () => {
    const fake = fakeStreamsClient();
    const broker = new RedisStreamsBroker(fake.client, { serviceName: 'svc' });
    const envelope = makeEnvelope('wallet.deposit.completed');

    await broker.publish(envelope);

    expect(fake.root.xAdd).toHaveBeenCalledWith(
      'oss:evt:wallet.deposit.completed',
      '*',
      { data: JSON.stringify(envelope) },
      { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: expect.any(Number) } },
    );
    // publish never touches a duplicated (blocking-read) connection.
    expect(fake.duplicates).toHaveLength(0);
  });

  it('coalesces two subscribers on the same topic into one loop: both receive, default group is the service name, one XACK', async () => {
    const fake = fakeStreamsClient();
    const broker = new RedisStreamsBroker(fake.client, { serviceName: 'wallet-svc' });

    const seen1 = deferred<EventEnvelope>();
    const seen2 = deferred<EventEnvelope>();
    broker.subscribe('wallet.deposit.completed', (env) => seen1.resolve(env));
    broker.subscribe('wallet.deposit.completed', (env) => seen2.resolve(env));

    expect(fake.duplicates).toHaveLength(1);

    const envelope = makeEnvelope('wallet.deposit.completed');
    await broker.publish(envelope);

    expect(await seen1.promise).toEqual(envelope);
    expect(await seen2.promise).toEqual(envelope);

    await vi.waitFor(() => {
      expect(fake.duplicates[0]?.xAck).toHaveBeenCalledTimes(1);
    });
    expect(fake.duplicates[0]?.xGroupCreate).toHaveBeenCalledWith(
      'oss:evt:wallet.deposit.completed',
      'wallet-svc',
      '$',
      { MKSTREAM: true },
    );

    await broker.close();
  });

  it('opts.consumerGroup overrides the default group and starts its own loop', async () => {
    const fake = fakeStreamsClient();
    const broker = new RedisStreamsBroker(fake.client, { serviceName: 'wallet-svc' });

    const seenDefault = deferred<EventEnvelope>();
    const seenCustom = deferred<EventEnvelope>();
    broker.subscribe('wallet.deposit.completed', (env) => seenDefault.resolve(env));
    broker.subscribe('wallet.deposit.completed', (env) => seenCustom.resolve(env), {
      consumerGroup: 'analytics',
    });

    // distinct (topic, group) pairs -> distinct loops/connections.
    expect(fake.duplicates).toHaveLength(2);

    const envelope = makeEnvelope('wallet.deposit.completed');
    await broker.publish(envelope);

    expect(await seenDefault.promise).toEqual(envelope);
    expect(await seenCustom.promise).toEqual(envelope);

    expect(fake.duplicates.map((d) => d.xGroupCreate.mock.calls[0]?.[1])).toEqual(
      expect.arrayContaining(['wallet-svc', 'analytics']),
    );

    await broker.close();
  });

  it('unsubscribe stops delivery to that handler and tears down the loop once the last handler leaves', async () => {
    const fake = fakeStreamsClient();
    const broker = new RedisStreamsBroker(fake.client, { serviceName: 'svc' });

    const handler1 = vi.fn();
    const seen2 = deferred<EventEnvelope>();
    const unsubscribe1 = broker.subscribe('wallet.deposit.completed', handler1);
    const unsubscribe2 = broker.subscribe('wallet.deposit.completed', (env) => seen2.resolve(env));

    unsubscribe1();

    const envelope = makeEnvelope('wallet.deposit.completed');
    await broker.publish(envelope);
    expect(await seen2.promise).toEqual(envelope);
    expect(handler1).not.toHaveBeenCalled();

    const reader = fake.duplicates[0];
    expect(reader?.destroy).not.toHaveBeenCalled();

    unsubscribe2();
    expect(reader?.destroy).toHaveBeenCalledTimes(1);
  });

  it('close stops every loop by destroying its duplicated reader connection, not the shared client', async () => {
    const fake = fakeStreamsClient();
    const broker = new RedisStreamsBroker(fake.client, { serviceName: 'svc' });

    broker.subscribe('wallet.deposit.completed', vi.fn());
    broker.subscribe('kyc.verification.completed', vi.fn());
    expect(fake.duplicates).toHaveLength(2);

    await broker.close();

    for (const reader of fake.duplicates) {
      expect(reader.destroy).toHaveBeenCalledTimes(1);
    }
    expect(fake.root.destroy).not.toHaveBeenCalled();
  });
});
