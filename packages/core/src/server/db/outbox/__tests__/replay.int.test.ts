import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import { migrate } from '@openora/core/server/migrate';
import {
  createTestDb,
  createTestRedis,
  redisUrlForWorker,
  waitForConsumerGroup,
  type TestDb,
  type TestRedis,
} from '@openora/core/testing';
import { createEventBus, EVENT_RETENTION_MS } from '../../../kernel/event-bus.js';
import { RedisStreamsBroker } from '../../../kernel/redis-streams-broker.js';
import { DrizzleOutboxWriter } from '../../outbox/writer.js';
import { DrizzleProcessedEventLog } from '../../outbox/processed-events.js';
import { OutboxRelay } from '../relay.js';
import { main } from '../replay.js';
import { eventOutbox, processedEvents } from '../schema.js';

const DELIVERY = { timeout: 5000, interval: 20 };
const TOPIC = 'wallet.deposit.completed';

let db: TestDb;
let redis: TestRedis;
const brokers: RedisStreamsBroker[] = [];

const replay = (...argv: string[]) =>
  main(argv, { DATABASE_URL: db.url, REDIS_URL: redisUrlForWorker() });

const deposit = () => ({
  userId: randomUUID(),
  playerId: null,
  amount: '50',
  currency: 'USD',
  transactionId: randomUUID(),
});

async function service(serviceName = `svc-${randomUUID()}`) {
  const broker = new RedisStreamsBroker(redis.client, { serviceName });
  brokers.push(broker);
  const bus = createEventBus({
    broker,
    outbox: new DrizzleOutboxWriter(),
    processedEvents: new DrizzleProcessedEventLog(db.drizzle.db),
  });
  const applied: string[] = [];
  const delivered: string[] = [];
  bus.on(TOPIC, (_p, envelope) => void delivered.push(envelope?.eventId ?? ''));
  bus.on(TOPIC, (_p, envelope) => void applied.push(envelope?.eventId ?? ''), {
    consumer: `${serviceName}/deposits`,
  });
  await waitForConsumerGroup(redis.client, { stream: `oss:evt:${TOPIC}`, group: serviceName });
  return { bus, broker, applied, delivered, serviceName };
}

async function commitDeposits(bus: ReturnType<typeof createEventBus>, n: number) {
  for (let i = 0; i < n; i += 1) {
    await db.drizzle.db.transaction((tx) => bus.emitInTransaction(tx, TOPIC, deposit()));
  }
}

const outboxIds = async () =>
  (await db.drizzle.db.select({ id: eventOutbox.eventId }).from(eventOutbox)).map((r) => r.id);

beforeAll(async () => {
  [db, redis] = await Promise.all([createTestDb([migrate]), createTestRedis()]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(brokers.map((b) => b.close()));
  brokers.length = 0;
  await redis.flush();
  await db.drizzle.db.execute(sql`TRUNCATE ${eventOutbox}, ${processedEvents}`);
});

afterAll(async () => {
  await Promise.all([redis.quit(), db.drop()]);
});

describe('openora-outbox-replay (real PG + Redis)', () => {
  it('replayed twice, applies each event once', async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const { bus, broker, applied, delivered } = await service();
    await commitDeposits(bus, 2);
    expect(await new OutboxRelay(db.drizzle.db, broker).drainOnce()).toBe(2);
    await vi.waitFor(() => expect(applied).toHaveLength(2), DELIVERY);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    expect(await replay('--since', since)).toBe(0);
    expect(await replay('--since', since)).toBe(0);

    await vi.waitFor(() => expect(delivered).toHaveLength(6), DELIVERY);
    expect([...applied].sort()).toEqual((await outboxIds()).sort());
  });

  it('after Redis is flushed, delivers every event published since the cut and none before', async () => {
    const first = await service('replayed-svc');
    await commitDeposits(first.bus, 3);
    await first.broker.close();
    expect(await new OutboxRelay(db.drizzle.db, first.broker).drainOnce()).toBe(3);
    const [before, ...after] = await db.drizzle.db
      .select({ id: eventOutbox.eventId })
      .from(eventOutbox)
      .orderBy(eventOutbox.seq);
    await db.drizzle.db
      .update(eventOutbox)
      .set({ publishedAt: new Date(Date.now() - 60 * 60_000) })
      .where(inArray(eventOutbox.eventId, [before!.id]));
    await redis.flush();

    const back = await service('replayed-svc');
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await replay('--since', new Date(Date.now() - 30 * 60_000).toISOString())).toBe(0);

    await vi.waitFor(() => expect(back.applied).toHaveLength(2), DELIVERY);
    expect(back.applied).toEqual(after.map((r) => r.id));
    expect(out).toHaveBeenCalledWith(`${TOPIC}: 2\n`);
  });

  it('filters by topic and, on a dry run, counts without publishing', async () => {
    const { bus, broker, delivered } = await service();
    await commitDeposits(bus, 2);
    await db.drizzle.db.transaction((tx) =>
      bus.emitInTransaction(tx, 'gaming.round.ended', {
        roundId: randomUUID(),
        userId: randomUUID(),
        playerId: null,
      }),
    );
    await new OutboxRelay(db.drizzle.db, broker).drainOnce();
    await vi.waitFor(() => expect(delivered).toHaveLength(2), DELIVERY);
    const lengthBefore = await redis.client.xLen(`oss:evt:${TOPIC}`);

    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const since = new Date(Date.now() - 60_000).toISOString();
    expect(await replay('--since', since, '--dry-run')).toBe(0);
    expect(out.mock.calls.map(([line]) => line)).toEqual([
      'gaming.round.ended: 1\n',
      `${TOPIC}: 2\n`,
      'total: 3 (dry run, nothing published)\n',
    ]);
    expect(await redis.client.xLen(`oss:evt:${TOPIC}`)).toBe(lengthBefore);

    out.mockClear();
    expect(await replay('--since', since, '--topic', 'gaming.round.ended')).toBe(0);
    expect(out.mock.calls.map(([line]) => line)).toEqual([
      'gaming.round.ended: 1\n',
      'total: 1 (republished)\n',
    ]);
    expect(await redis.client.xLen(`oss:evt:${TOPIC}`)).toBe(lengthBefore);
  });

  it('refuses a --since older than the outbox retention, publishing nothing', async () => {
    const { bus, broker } = await service();
    await commitDeposits(bus, 1);
    await new OutboxRelay(db.drizzle.db, broker).drainOnce();
    const lengthBefore = await redis.client.xLen(`oss:evt:${TOPIC}`);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const tooOld = new Date(Date.now() - EVENT_RETENTION_MS - 60_000).toISOString();
    expect(await replay('--since', tooOld)).toBe(1);

    expect(String(err.mock.calls[0]?.[0])).toContain('older than the outbox retention');
    expect(await redis.client.xLen(`oss:evt:${TOPIC}`)).toBe(lengthBefore);
  });

  it('refuses a missing or malformed --since', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await replay()).toBe(1);
    expect(await replay('--since', 'yesterday')).toBe(1);
  });
});
