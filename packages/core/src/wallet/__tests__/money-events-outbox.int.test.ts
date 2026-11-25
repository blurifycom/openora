import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  AUDIT_WRITER,
  IDENTITY_READER,
  LEDGER_API_V1,
  PLAY_ELIGIBILITY,
  type LedgerApiV1,
  type PlayEligibilityPort,
} from '@openora/core/contracts';
import {
  Container,
  DRIZZLE,
  EVENT_BUS,
  DrizzleOutboxWriter,
  DrizzleProcessedEventLog,
  ModuleRegistryImpl,
  OutboxRelay,
  RedisStreamsBroker,
  createEventBus,
  eventOutbox,
  findOneOrThrow,
  moneyEquals,
  type CoreTokenCatalog,
  type EventBus,
} from '@openora/core/server';
import { migrate as migrateOutbox } from '@openora/core/server/migrate';
import {
  createTestDb,
  createTestRedis,
  waitForConsumerGroup,
  type TestDb,
  type TestRedis,
} from '@openora/core/testing';
import { migrate as migrateGaming } from '@openora/core/casino/migrate/gaming';
import { game, gameProvider } from '@openora/core/casino/schema/gaming';
import { backfillLedgerGames } from '@openora/core/casino/seed/gaming';
import gamingPlugin from '@openora/core/casino/plugins/gaming';
import { mock, makeAuditWriter, makeIdentityReader } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletBalance } from '../schema/index.js';
import walletPlugin from '../plugin.js';
import { ledgerPlayEligibilityProjection } from '../service/ledger-play-eligibility.service.js';

const SERVICE = `money-${randomUUID()}`;
const TOPIC = 'wallet.balance.changed';
const DELIVERY = { timeout: 5000, interval: 20 };

let db: TestDb;
let redis: TestRedis;
let broker: RedisStreamsBroker;
let bus: EventBus;
let api: LedgerApiV1;
let failNextCommit = false;
const applied: unknown[] = [];

beforeAll(async () => {
  [db, redis] = await Promise.all([
    createTestDb([migrateOutbox, migrate, migrateGaming]),
    createTestRedis(),
  ]);
  broker = new RedisStreamsBroker(redis.client, { serviceName: SERVICE });
  bus = createEventBus({
    broker,
    outbox: new DrizzleOutboxWriter(),
    processedEvents: new DrizzleProcessedEventLog(db.drizzle.db),
  });
  bus.tapTransactional(async () => {
    if (failNextCommit) {
      failNextCommit = false;
      throw new Error('crash before commit');
    }
  });
  bus.on(TOPIC, (payload) => void applied.push(payload), { consumer: `${SERVICE}/balance` });
  await waitForConsumerGroup(redis.client, { stream: `oss:evt:${TOPIC}`, group: SERVICE });

  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  container.register(EVENT_BUS, () => bus);
  container.register(AUDIT_WRITER, () => makeAuditWriter());
  container.register(IDENTITY_READER, () => makeIdentityReader());
  container.register(PLAY_ELIGIBILITY, () =>
    mock<Required<PlayEligibilityPort>>({
      isRestricted: vi.fn().mockResolvedValue(false),
      checkPlay: vi.fn().mockResolvedValue(null),
    }),
  );
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  walletPlugin.register(registry);
  gamingPlugin.register(registry);
  api = container.get(LEDGER_API_V1);
});

afterAll(async () => {
  await broker.close();
  await redis.flush();
  await Promise.all([redis.quit(), db.drop()]);
});

async function seedBet() {
  const provider = findOneOrThrow(
    await db.drizzle.db
      .insert(gameProvider)
      .values({ slug: `studio-${randomUUID()}`, name: 'Studio', isActive: true })
      .returning(),
    new Error('no provider'),
  );
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(game)
      .values({
        reviewStatus: 'approved',
        name: 'Game',
        slug: `game-${randomUUID()}`,
        providerId: provider.id,
        aggregator: 'direct',
        isActive: true,
        wagerProduct: 'casino',
        rtp: '0.96',
      })
      .returning(),
    new Error('no game'),
  );
  await backfillLedgerGames(db.drizzle.db);
  const userId = randomUUID();
  const w = findOneOrThrow(
    await db.drizzle.db.insert(wallet).values({ userId, currency: 'USD' }).returning(),
    new Error('no wallet'),
  );
  await db.drizzle.db
    .insert(walletBalance)
    .values({ walletId: w.id, currency: 'USD', amount: '100' });
  await ledgerPlayEligibilityProjection(db.drizzle.db).reconcile([
    {
      userId,
      rgBlocked: false,
      rgBlockedUntil: null,
      isActive: true,
      banned: false,
      banExpires: null,
      status: 'active',
      version: 0,
    },
  ]);
  const balance = async () =>
    findOneOrThrow(
      await db.drizzle.db
        .select({ amount: walletBalance.amount })
        .from(walletBalance)
        .where(eq(walletBalance.walletId, w.id)),
      new Error('no balance'),
    ).amount;
  const bet = () =>
    api.bet({
      providerName: 'acme-games',
      providerRefId: `tx-${randomUUID()}`,
      userId,
      gameId: row.id,
      externalRoundId: `round-${randomUUID()}`,
      currency: 'USD',
      amount: '10',
    });
  return { userId, balance, bet };
}

const balanceEvents = () =>
  db.drizzle.db.select().from(eventOutbox).where(eq(eventOutbox.topic, TOPIC));

describe('money events on the outbox (real PG + Redis)', () => {
  it('a stake that rolls back leaves no event; a committed one is delivered once', async () => {
    const { userId, balance, bet } = await seedBet();
    const relay = new OutboxRelay(db.drizzle.db, broker);

    failNextCommit = true;
    await expect(bet()).rejects.toThrow('crash before commit');
    expect(moneyEquals(await balance(), '100')).toBe(true);
    expect(await balanceEvents()).toHaveLength(0);
    expect(await relay.drainOnce()).toBe(0);

    await bet();
    expect(moneyEquals(await balance(), '90')).toBe(true);
    const [event] = await balanceEvents();
    expect(event).toBeDefined();
    await relay.drainOnce();
    await relay.drainOnce();
    await broker.publish({
      eventId: event!.eventId,
      topic: TOPIC,
      payload: event!.payload,
      occurredAt: event!.occurredAt.toISOString(),
      schemaVersion: event!.schemaVersion,
    });

    await vi.waitFor(() => expect(applied).toHaveLength(1), DELIVERY);
    await new Promise((r) => setTimeout(r, 200));
    expect(applied).toEqual([expect.objectContaining({ userId, direction: 'debit' })]);
  });
});
