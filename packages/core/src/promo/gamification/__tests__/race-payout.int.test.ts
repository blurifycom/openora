import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  createTestDb,
  createTestRedis,
  seedPlayerWithUser,
  waitForConsumerGroup,
  type TestDb,
  type TestRedis,
} from '@openora/core/testing';
import {
  makeAuditWriter,
  makeIdentityReader,
  makeOutboxEventBus,
  mock,
} from '../../../testing/mock.js';
import {
  AUDIT_WRITER,
  IDENTITY_READER,
  PLAY_ELIGIBILITY,
  WALLET_COMMANDS,
  type EventEnvelope,
  type ExchangeRateReader,
  type PlayEligibilityPort,
  type WalletCommands,
} from '@openora/core/contracts';
import {
  Container,
  createEventBus,
  ModuleRegistryImpl,
  type CoreTokenCatalog,
  DrizzleOutboxWriter,
  DrizzleProcessedEventLog,
  eventOutbox,
  OutboxRelay,
  RedisStreamsBroker,
  type EventBus,
} from '@openora/core/server';
import { migrate as serverMigrate } from '@openora/core/server/migrate';
import { migrate as identityMigrate } from '@openora/core/pam/migrate/identity';
import { migrate as profileMigrate } from '@openora/core/pam/migrate/profile';
import { migrate as walletMigrate } from '@openora/core/wallet/migrate';
import { walletTransaction } from '@openora/core/wallet/schema';
import walletPlugin from '@openora/core/wallet/plugin';
import { migrate } from '../migrate.js';
import { promoRace, promoRacePayout, promoRaceWager } from '../schema/index.js';
import { RacePayoutService, STUCK_AFTER_FAILURES } from '../service/race-payout.service.js';
import type { RacePosition } from '../contract/index.js';

let db: TestDb;
const isRestricted = vi.fn<PlayEligibilityPort['isRestricted']>();
const credit = vi.fn<WalletCommands['credit']>();
const convert = vi.fn<ExchangeRateReader['convert']>();
const audit = makeAuditWriter();
const logger = { warn: vi.fn(), error: vi.fn() };

const POSITIONS: RacePosition[] = [
  { position: 1, prize: '500' },
  { position: 2, prize: '250' },
];

// The race's own currency and the payout currency match by default, so most tests exercise the
// no-conversion path - the currency-conversion behaviour has its own describe block below.
const service = (
  payoutCurrency = 'USDT',
  events: EventBus = makeOutboxEventBus(),
  wallet: WalletCommands = mock<WalletCommands>({ credit }),
) =>
  new RacePayoutService(
    db.drizzle,
    mock<PlayEligibilityPort>({ isRestricted }),
    wallet,
    mock<ExchangeRateReader>({ convert }),
    payoutCurrency,
    audit,
    events,
    logger,
  );

// The wallet plugin's own WALLET_COMMANDS binding, so a payout writes a real ledger row.
const realWallet = () => {
  const container = new Container<CoreTokenCatalog>();
  container.register(PLAY_ELIGIBILITY, () => mock<PlayEligibilityPort>({ isRestricted }));
  container.register(AUDIT_WRITER, () => audit);
  container.register(IDENTITY_READER, () => makeIdentityReader());
  walletPlugin.register(new ModuleRegistryImpl<CoreTokenCatalog>(container));
  return container.get(WALLET_COMMANDS);
};

const ledgerRowsFor = (providerRefId: string) =>
  db.drizzle.db
    .select({ id: walletTransaction.id })
    .from(walletTransaction)
    .where(eq(walletTransaction.providerRefId, providerRefId));

// One outbox row for the win, one for the balance credit it paid.
const RACE_WIN_AND_BALANCE_CREDIT = 2;

const outboxed = (topic: string) =>
  db.drizzle.db
    .select({ payload: eventOutbox.payload, publishedAt: eventOutbox.publishedAt })
    .from(eventOutbox)
    .where(eq(eventOutbox.topic, topic));

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);

const insertRace = async (overrides: Partial<typeof promoRace.$inferInsert> = {}) => {
  const [row] = await db.drizzle.db
    .insert(promoRace)
    .values({
      name: 'Weekly Race',
      currency: 'USDT',
      startAt: hoursFromNow(-2),
      endAt: hoursFromNow(-1),
      prizePool: '1000',
      positions: POSITIONS,
      eligibleProducts: ['casino'],
      ...overrides,
    })
    .returning({ id: promoRace.id });
  if (!row) {
    throw new Error('insertRace: insert returned no row');
  }
  return row.id;
};

const insertWager = (raceId: string, userId: string, wagered: string) =>
  db.drizzle.db.insert(promoRaceWager).values({ raceId, userId, currency: 'USDT', wagered });

const payoutsFor = (raceId: string) =>
  db.drizzle.db
    .select({
      userId: promoRacePayout.userId,
      position: promoRacePayout.position,
      amount: promoRacePayout.amount,
      outcome: promoRacePayout.outcome,
    })
    .from(promoRacePayout)
    .where(eq(promoRacePayout.raceId, raceId))
    .orderBy(promoRacePayout.position);

beforeAll(async () => {
  db = await createTestDb([serverMigrate, migrate, identityMigrate, profileMigrate, walletMigrate]);
});

afterAll(() => db.drop());

beforeEach(async () => {
  vi.clearAllMocks();
  isRestricted.mockResolvedValue(false);
  credit.mockResolvedValue({
    ok: true,
    moved: true,
    transactionId: randomUUID(),
    newBalance: '500',
  });
  await db.drizzle.db.delete(promoRacePayout);
  await db.drizzle.db.delete(promoRaceWager);
  await db.drizzle.db.delete(promoRace);
  await db.drizzle.db.delete(eventOutbox);
});

describe('settling a closed race', () => {
  it('pays every paid position, credits real cash, and closes the race once', async () => {
    const raceId = await insertRace();
    const first = randomUUID();
    const second = randomUUID();
    const third = randomUUID();
    await insertWager(raceId, first, '500');
    await insertWager(raceId, second, '300');
    await insertWager(raceId, third, '100');

    const won = await service().closeDue(new Date());

    expect(won).toEqual([
      expect.objectContaining({ userId: first, raceId, position: 1, amount: '500' }),
      expect.objectContaining({ userId: second, raceId, position: 2, amount: '250' }),
    ]);
    expect(credit).toHaveBeenCalledTimes(2);
    expect(credit.mock.calls[0]?.[1]).toMatchObject({
      userId: first,
      amount: '500',
      currency: 'USDT',
      type: 'cashback',
      allowNewWallet: true,
      providerRef: { providerName: 'promo-race', providerRefId: `race-payout:${raceId}:${first}` },
    });

    const payouts = await payoutsFor(raceId);
    expect(payouts).toHaveLength(2);
    expect(payouts.every((p) => p.outcome === 'granted')).toBe(true);

    const [race] = await db.drizzle.db
      .select({ closedAt: promoRace.closedAt })
      .from(promoRace)
      .where(eq(promoRace.id, raceId));
    expect(race?.closedAt).not.toBeNull();
  });

  it('records each prize in the settlement transaction, with the credit it describes', async () => {
    const raceId = await insertRace();
    const winner = randomUUID();
    const transactionId = randomUUID();
    credit.mockResolvedValue({ ok: true, moved: true, transactionId, newBalance: '500' });
    await insertWager(raceId, winner, '500');

    await service().closeDue(new Date());

    expect(audit.recordManyInTransaction).toHaveBeenCalledWith(expect.anything(), [
      {
        actorType: 'system',
        action: 'promo.race.payout.settled',
        resourceType: 'promo_race',
        resourceId: raceId,
        before: { settledAt: null },
        after: {
          userId: winner,
          position: 1,
          amount: '500',
          currency: 'USDT',
          outcome: 'granted',
          transactionId,
        },
      },
    ]);
  });

  it('rolls the settlement back, paying and closing nothing, when the audit write fails', async () => {
    const raceId = await insertRace();
    await insertWager(raceId, randomUUID(), '500');
    audit.recordManyInTransaction.mockRejectedValueOnce(new Error('audit unavailable'));

    const won = await service().closeDue(new Date());

    expect(won).toHaveLength(0);
    expect(await payoutsFor(raceId)).toHaveLength(0);
    const [race] = await db.drizzle.db
      .select({ closedAt: promoRace.closedAt })
      .from(promoRace)
      .where(eq(promoRace.id, raceId));
    expect(race?.closedAt).toBeNull();
  });

  it('ranks a tie by whoever reached the total first', async () => {
    const raceId = await insertRace();
    const early = randomUUID();
    const late = randomUUID();
    await insertWager(raceId, early, '200');
    // A distinct later `updatedAt` for the tie-break: insert then update so the row's own
    // timestamp actually moves forward of `early`'s. Stamped with the database clock like
    // the production upsert; the `$onUpdate` default is the app clock, which can trail the
    // database's by more than the gap between these statements.
    await insertWager(raceId, late, '100');
    await db.drizzle.db
      .update(promoRaceWager)
      .set({ wagered: '200', updatedAt: sql`now()` })
      .where(eq(promoRaceWager.userId, late));

    const won = await service().closeDue(new Date());

    expect(won[0]).toMatchObject({ userId: early, position: 1 });
    expect(won[1]).toMatchObject({ userId: late, position: 2 });
  });

  it('withholds cash from a player under a responsible-gambling restriction, but still ranks and records them', async () => {
    const raceId = await insertRace();
    const winner = randomUUID();
    isRestricted.mockResolvedValue(true);
    await insertWager(raceId, winner, '500');

    const won = await service().closeDue(new Date());

    expect(won).toHaveLength(0);
    expect(credit).not.toHaveBeenCalled();
    const payouts = await payoutsFor(raceId);
    expect(payouts).toEqual([expect.objectContaining({ userId: winner, outcome: 'restricted' })]);
    expect(audit.recordManyInTransaction.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({
        action: 'promo.race.payout.settled',
        after: expect.objectContaining({
          userId: winner,
          outcome: 'restricted',
          transactionId: null,
        }),
      }),
    ]);
  });

  it('is idempotent: a retried settle does not credit or re-rank twice', async () => {
    const raceId = await insertRace();
    const winner = randomUUID();
    await insertWager(raceId, winner, '500');

    await service().closeDue(new Date());
    // Re-open closedAt as a retry after a crash between payouts and the close flag would find it.
    await db.drizzle.db.update(promoRace).set({ closedAt: null }).where(eq(promoRace.id, raceId));
    const won = await service().closeDue(new Date());

    expect(won).toHaveLength(0);
    expect(credit).toHaveBeenCalledTimes(1);
    const payouts = await payoutsFor(raceId);
    expect(payouts).toHaveLength(1);
  });

  it('skips a race not yet past its end time', async () => {
    await insertRace({ startAt: hoursFromNow(-1), endAt: hoursFromNow(1) });

    const won = await service().closeDue(new Date());

    expect(won).toHaveLength(0);
    expect(credit).not.toHaveBeenCalled();
  });
});

describe('crediting a prize in a currency the player can actually hold', () => {
  it('converts a prize priced in the race currency into the payout currency before crediting', async () => {
    const raceId = await insertRace();
    const winner = randomUUID();
    await insertWager(raceId, winner, '500');
    convert.mockResolvedValue('480');

    const won = await service('USD').closeDue(new Date());

    expect(convert).toHaveBeenCalledWith('500', 'USDT', 'USD', expect.anything());
    expect(credit.mock.calls[0]?.[1]).toMatchObject({ amount: '480', currency: 'USD' });
    expect(won[0]).toMatchObject({ amount: '480', currency: 'USD' });
    const payouts = await payoutsFor(raceId);
    expect(Number(payouts[0]?.amount)).toBe(480);
  });

  it('refuses the credit and leaves the race open to retry when no rate is available', async () => {
    const raceId = await insertRace();
    const winner = randomUUID();
    await insertWager(raceId, winner, '500');
    convert.mockResolvedValue(null);

    const won = await service('USD').closeDue(new Date());

    expect(won).toHaveLength(0);
    expect(credit).not.toHaveBeenCalled();
    const payouts = await payoutsFor(raceId);
    expect(payouts).toHaveLength(0);
    const [race] = await db.drizzle.db
      .select({ closedAt: promoRace.closedAt })
      .from(promoRace)
      .where(eq(promoRace.id, raceId));
    expect(race?.closedAt).toBeNull();
  });

  it('rolls back the whole race, granting nothing, when the wallet credit fails', async () => {
    const raceId = await insertRace();
    const winner = randomUUID();
    const runnerUp = randomUUID();
    await insertWager(raceId, winner, '500');
    await insertWager(raceId, runnerUp, '300');
    credit.mockResolvedValueOnce({ ok: false, reason: 'wallet not found' });

    const won = await service().closeDue(new Date());

    expect(won).toHaveLength(0);
    const payouts = await payoutsFor(raceId);
    expect(payouts).toHaveLength(0);
    const [race] = await db.drizzle.db
      .select({ closedAt: promoRace.closedAt })
      .from(promoRace)
      .where(eq(promoRace.id, raceId));
    expect(race?.closedAt).toBeNull();
  });
});

describe('announcing a settled race through the outbox', () => {
  it('writes each win and its balance credit in the settlement transaction', async () => {
    const raceId = await insertRace();
    const { account, player } = await seedPlayerWithUser(db);
    const transactionId = randomUUID();
    credit.mockResolvedValue({ ok: true, moved: true, transactionId, newBalance: '500' });
    await insertWager(raceId, account.id, '500');

    await service().closeDue(new Date());

    expect(await outboxed('promo.race.won')).toEqual([
      {
        payload: expect.objectContaining({
          userId: account.id,
          raceId,
          position: 1,
          amount: '500',
        }),
        publishedAt: null,
      },
    ]);
    expect(await outboxed('wallet.balance.changed')).toEqual([
      {
        payload: {
          userId: account.id,
          playerId: player.id,
          amount: '500',
          currency: 'USDT',
          transactionId,
          type: 'cashback',
          direction: 'credit',
        },
        publishedAt: null,
      },
    ]);
  });

  it('leaves no event behind when the settlement rolls back after announcing', async () => {
    const raceId = await insertRace();
    await insertWager(raceId, randomUUID(), '500');
    const events = makeOutboxEventBus();
    const announce = events.emitInTransaction.bind(events);
    vi.spyOn(events, 'emitInTransaction').mockImplementation(async (tx, topic, payload) => {
      if (topic === 'wallet.balance.changed') {
        throw new Error('outbox unavailable');
      }
      await announce(tx, topic, payload);
    });

    const won = await service('USDT', events).closeDue(new Date());

    expect(won).toHaveLength(0);
    expect(await payoutsFor(raceId)).toHaveLength(0);
    expect(await db.drizzle.db.select().from(eventOutbox)).toHaveLength(0);
  });

  it('announces nothing for a restricted winner', async () => {
    const raceId = await insertRace();
    isRestricted.mockResolvedValue(true);
    await insertWager(raceId, randomUUID(), '500');

    await service().closeDue(new Date());

    expect(await db.drizzle.db.select().from(eventOutbox)).toHaveLength(0);
  });

  it('announces the win but no balance change for a replayed credit that moved nothing', async () => {
    const raceId = await insertRace();
    await insertWager(raceId, randomUUID(), '500');
    credit.mockResolvedValue({ ok: true, moved: false, newBalance: '500' });

    await service().closeDue(new Date());

    expect(await outboxed('promo.race.won')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ transactionId: null }) }),
    ]);
    expect(await outboxed('wallet.balance.changed')).toEqual([]);
  });

  it('pays the prize exactly once through the real wallet after an outbox failure is retried', async () => {
    const raceId = await insertRace();
    const winner = randomUUID();
    await insertWager(raceId, winner, '500');
    const events = makeOutboxEventBus();
    vi.spyOn(events, 'emitInTransaction').mockRejectedValueOnce(new Error('outbox unavailable'));
    const payouts = service('USDT', events, realWallet());
    const sourceRef = `race-payout:${raceId}:${winner}`;

    await payouts.closeDue(new Date());

    expect(await ledgerRowsFor(sourceRef)).toHaveLength(0);
    const [open] = await db.drizzle.db
      .select({ closedAt: promoRace.closedAt })
      .from(promoRace)
      .where(eq(promoRace.id, raceId));
    expect(open?.closedAt).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ raceId, failures: 1 }),
      'race settlement failed',
    );

    await payouts.closeDue(new Date());

    const ledger = await ledgerRowsFor(sourceRef);
    expect(ledger).toHaveLength(1);
    expect(await outboxed('wallet.balance.changed')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ userId: winner, transactionId: ledger[0]?.id }),
      }),
    ]);
  });

  it('logs a race as stuck once its settlement keeps failing', async () => {
    const raceId = await insertRace();
    await insertWager(raceId, randomUUID(), '500');
    const events = makeOutboxEventBus();
    vi.spyOn(events, 'emitInTransaction').mockRejectedValue(new Error('payload invalid'));
    const payouts = service('USDT', events);

    for (let tick = 0; tick < STUCK_AFTER_FAILURES; tick++) {
      await payouts.closeDue(new Date());
    }

    expect(logger.error).toHaveBeenCalledWith(
      { raceId, failures: STUCK_AFTER_FAILURES },
      'race settlement stuck',
    );
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ failures: STUCK_AFTER_FAILURES - 1 }),
      'race settlement stuck',
    );
  });
});

describe('delivering a committed race win', () => {
  const DELIVERY = { timeout: 5000, interval: 20 };
  let redis: TestRedis;
  let broker: RedisStreamsBroker;

  beforeAll(async () => {
    redis = await createTestRedis();
  });

  afterEach(async () => {
    await broker.close();
    await redis.flush();
  });

  afterAll(() => redis.quit());

  it('reaches the consumer once after a failed relay drain is retried', async () => {
    const serviceName = `race-${randomUUID()}`;
    broker = new RedisStreamsBroker(redis.client, {
      serviceName,
      reclaim: { intervalMs: 20, minIdleMs: 10 },
    });
    const events = createEventBus({
      broker,
      outbox: new DrizzleOutboxWriter(),
      processedEvents: new DrizzleProcessedEventLog(db.drizzle.db),
    });
    const notified = vi.fn();
    events.on('promo.race.won', notified, { consumer: 'notifications/promo.race.won' });
    await waitForConsumerGroup(redis.client, {
      stream: 'oss:evt:promo.race.won',
      group: serviceName,
    });
    const raceId = await insertRace();
    await insertWager(raceId, randomUUID(), '500');
    await service('USDT', events).closeDue(new Date());
    const relay = new OutboxRelay(db.drizzle.db, broker);
    const publish = broker.publish.bind(broker);
    let brokerDown = true;
    vi.spyOn(broker, 'publish').mockImplementation((envelope) =>
      brokerDown ? Promise.reject(new Error('broker unavailable')) : publish(envelope),
    );

    expect(await relay.drainOnce()).toBe(0);
    expect(await outboxed('promo.race.won')).toEqual([
      expect.objectContaining({ publishedAt: null }),
    ]);

    brokerDown = false;
    expect(await relay.drainOnce()).toBe(RACE_WIN_AND_BALANCE_CREDIT);
    await vi.waitFor(() => expect(notified).toHaveBeenCalledTimes(1), DELIVERY);
    expect(await outboxed('promo.race.won')).toEqual([
      expect.objectContaining({ publishedAt: expect.any(Date) }),
    ]);
    expect(await relay.drainOnce()).toBe(0);
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it('runs a consumer once when the same event is published twice', async () => {
    const serviceName = `race-${randomUUID()}`;
    broker = new RedisStreamsBroker(redis.client, {
      serviceName,
      reclaim: { intervalMs: 20, minIdleMs: 10 },
    });
    const events = createEventBus({
      broker,
      outbox: new DrizzleOutboxWriter(),
      processedEvents: new DrizzleProcessedEventLog(db.drizzle.db),
    });
    const deliveries: EventEnvelope[] = [];
    const notified = vi.fn();
    events.on('promo.race.won', (_payload, envelope) => {
      if (envelope) {
        deliveries.push(envelope);
      }
    });
    events.on('promo.race.won', notified, { consumer: 'notifications/promo.race.won' });
    await waitForConsumerGroup(redis.client, {
      stream: 'oss:evt:promo.race.won',
      group: serviceName,
    });
    const raceId = await insertRace();
    await insertWager(raceId, randomUUID(), '500');

    await service('USDT', events).closeDue(new Date());

    expect(await outboxed('promo.race.won')).toEqual([
      expect.objectContaining({ publishedAt: null }),
    ]);
    expect(notified).not.toHaveBeenCalled();

    expect(await new OutboxRelay(db.drizzle.db, broker).drainOnce()).toBe(
      RACE_WIN_AND_BALANCE_CREDIT,
    );
    await vi.waitFor(() => expect(notified).toHaveBeenCalledTimes(1), DELIVERY);

    const [delivered] = deliveries;
    if (!delivered) {
      throw new Error('the race win was never delivered');
    }
    await broker.publish(delivered);
    await vi.waitFor(() => expect(deliveries).toHaveLength(2), DELIVERY);
    expect(notified).toHaveBeenCalledTimes(1);
    expect(notified).toHaveBeenCalledWith(
      expect.objectContaining({ raceId, position: 1, amount: '500' }),
      expect.objectContaining({ eventId: delivered.eventId }),
    );
  });
});
