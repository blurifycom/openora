import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { RedisStreamsBroker } from '../redis-streams-broker.js';
import type { RedisClient } from '../redis-client.js';
import { mock } from '../../../testing/mock.js';
import type { EventEnvelope } from '@openora/core/contracts';

type Entry = { id: string; message: Record<string, string> };

// Mirrors the un-exported STREAM_PREFIX in redis-streams-broker.ts.
const STREAM_PREFIX = 'oss:evt:';

type RawStreamsClient = {
  isReady: boolean;
  isOpen: boolean;
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
// Models the two node-redis behaviours the broker's reconnect path depends on:
// `connect()` throws 'Socket already opened' once `isOpen` (so a loop that
// re-connects blindly wedges here exactly as it would in production), and
// xGroupCreate honours the start id - '$' seeds the cursor at the current stream
// end (new entries only), '0' at the start (replays retained history).
function fakeStreamsClient() {
  const streams = new Map<string, Entry[]>();
  const cursors = new Map<string, number>();
  const waiters = new Map<string, Array<() => void>>();
  const duplicates: RawStreamsClient[] = [];
  let seq = 0;
  // Armed before subscribe(), since the reader connection this would target does not
  // exist until the loop calls duplicate().
  let nextGroupCreateError: Error | null = null;

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
      isOpen: false,
      on: vi.fn(),
      connect: vi.fn(async () => {
        // node-redis (socket.ts): connect() rejects once the socket is open, and
        // isOpen stays true across reconnectStrategy retries.
        if (raw.isOpen) {
          throw new Error('Socket already opened');
        }
        raw.isOpen = true;
        return raw;
      }),
      destroy: vi.fn(() => {
        destroyed = true;
        raw.isOpen = false;
        // Every parked reader, not just those whose stream already has entries - a
        // loop torn down before anything was ever published is parked on a key that
        // `streams` has never seen, and would otherwise never wake to observe
        // `destroyed` (hanging the `close()` that awaits it). Loops belonging to
        // other connections re-check their own flag and re-park.
        for (const key of waiters.keys()) {
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
      xGroupCreate: vi.fn(async (key: string, group: string, startId: string) => {
        if (nextGroupCreateError) {
          const err = nextGroupCreateError;
          nextGroupCreateError = null;
          throw err;
        }
        const cursorKey = `${key}::${group}`;
        if (cursors.has(cursorKey)) {
          throw new Error('BUSYGROUP Consumer Group name already exists');
        }
        cursors.set(cursorKey, startId === '0' ? 0 : (streams.get(key) ?? []).length);
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
  const hasGroup = (topic: string, group: string): boolean =>
    cursors.has(`${STREAM_PREFIX}${topic}::${group}`);
  const failNextGroupCreate = (err: Error): void => {
    nextGroupCreateError = err;
  };
  return { client: mock<RedisClient>(root), root, duplicates, hasGroup, failNextGroupCreate };
}

type FakeStreamsClient = ReturnType<typeof fakeStreamsClient>;

// `subscribe()` returns before its consumer group exists - the loop creates the group
// asynchronously, after `await reader.connect()`. Publishing into that window is the
// one case a '$' group genuinely drops (see the class docstring), so a test that
// means to exercise steady-state delivery must wait the group out first, the way a
// real deployment finishes booting before it serves traffic.
async function awaitGroup(
  fake: FakeStreamsClient,
  topic: string,
  group: string,
  // Default 1s is under the loop's 2s retry backoff, so a test exercising a failed
  // first attempt must allow for at least one of those.
  timeout = 4_000,
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(fake.hasGroup(topic, group)).toBe(true);
    },
    { timeout },
  );
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
    await awaitGroup(fake, 'wallet.deposit.completed', 'wallet-svc');

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
    await awaitGroup(fake, 'wallet.deposit.completed', 'wallet-svc');
    await awaitGroup(fake, 'wallet.deposit.completed', 'analytics');

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
    await awaitGroup(fake, 'wallet.deposit.completed', 'svc');

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

  it('tolerates BUSYGROUP - a group a previous replica already created is not an error', async () => {
    const fake = fakeStreamsClient();
    const first = new RedisStreamsBroker(fake.client, { serviceName: 'svc' });
    first.subscribe('wallet.deposit.completed', vi.fn());
    await awaitGroup(fake, 'wallet.deposit.completed', 'svc');
    await first.close();

    // Same (topic, group) against the same Redis: xGroupCreate comes back BUSYGROUP,
    // which must not stop this loop from consuming.
    const second = new RedisStreamsBroker(fake.client, { serviceName: 'svc' });
    const seen = deferred<EventEnvelope>();
    second.subscribe('wallet.deposit.completed', (env) => seen.resolve(env));

    const envelope = makeEnvelope('wallet.deposit.completed');
    await second.publish(envelope);

    // Delivery is the proof: the second loop got past a BUSYGROUP rejection.
    expect(await seen.promise).toEqual(envelope);
    await expect(fake.duplicates[1]?.xGroupCreate.mock.results[0]?.value).rejects.toThrow(
      /BUSYGROUP/,
    );

    await second.close();
  });

  it('recovers from a failed group creation without re-opening the already-open socket', async () => {
    const fake = fakeStreamsClient();
    const broker = new RedisStreamsBroker(fake.client, { serviceName: 'svc' });

    // Fail the first group creation - it runs after connect() has already opened the
    // socket. A loop that reset its readiness and re-called connect() here would take
    // 'Socket already opened' on every retry and never consume again.
    fake.failNextGroupCreate(new Error('READONLY You cannot write against a replica'));

    const seen = deferred<EventEnvelope>();
    broker.subscribe('wallet.deposit.completed', (env) => seen.resolve(env));
    await awaitGroup(fake, 'wallet.deposit.completed', 'svc');

    const envelope = makeEnvelope('wallet.deposit.completed');
    await broker.publish(envelope);

    expect(await seen.promise).toEqual(envelope);
    const reader = fake.duplicates[0];
    expect(reader?.xGroupCreate.mock.calls.length).toBeGreaterThan(1);
    expect(reader?.connect).toHaveBeenCalledTimes(1);

    await broker.close();
  });

  it('defaults the group to $ - a backlog published before it existed is not replayed', async () => {
    const fake = fakeStreamsClient();
    const broker = new RedisStreamsBroker(fake.client, { serviceName: 'svc' });

    const before = makeEnvelope('wallet.deposit.completed', { eventId: 'before' });
    await broker.publish(before);

    const handler = vi.fn();
    broker.subscribe('wallet.deposit.completed', handler);
    await awaitGroup(fake, 'wallet.deposit.completed', 'svc');

    const after = makeEnvelope('wallet.deposit.completed', { eventId: 'after' });
    await broker.publish(after);

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith(after);
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalledWith(before);

    await broker.close();
  });

  it("startId '0' replays the retained backlog into a group created after the fact", async () => {
    const fake = fakeStreamsClient();
    const broker = new RedisStreamsBroker(fake.client, { serviceName: 'svc', startId: '0' });

    const before = makeEnvelope('wallet.deposit.completed', { eventId: 'before' });
    await broker.publish(before);

    const seen = deferred<EventEnvelope>();
    broker.subscribe('wallet.deposit.completed', (env) => seen.resolve(env));

    expect(await seen.promise).toEqual(before);
    expect(fake.duplicates[0]?.xGroupCreate).toHaveBeenCalledWith(
      `${STREAM_PREFIX}wallet.deposit.completed`,
      'svc',
      '0',
      { MKSTREAM: true },
    );

    await broker.close();
  });
});
