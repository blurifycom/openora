import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock } from '../../../testing/mock.js';
import type {
  ExchangeRateReader,
  PlayEligibilityPort,
  WalletCommands,
} from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import { promoRace, promoRacePayout, promoRaceWager } from '../schema/index.js';
import { RacePayoutService } from '../service/race-payout.service.js';
import type { RacePosition } from '../contract/index.js';

let db: TestDb;
const isRestricted = vi.fn<PlayEligibilityPort['isRestricted']>();
const credit = vi.fn<WalletCommands['credit']>();
const convert = vi.fn<ExchangeRateReader['convert']>();
const logger = { warn: vi.fn(), error: vi.fn() };

const POSITIONS: RacePosition[] = [
  { position: 1, prize: '500' },
  { position: 2, prize: '250' },
];

// The race's own currency and the payout currency match by default, so most tests exercise the
// no-conversion path - the currency-conversion behaviour has its own describe block below.
const service = (payoutCurrency = 'USDT') =>
  new RacePayoutService(
    db.drizzle,
    mock<PlayEligibilityPort>({ isRestricted }),
    mock<WalletCommands>({ credit }),
    mock<ExchangeRateReader>({ convert }),
    payoutCurrency,
    logger,
  );

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
      eligibleProducts: [],
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
  db = await createTestDb([migrate]);
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

  it('ranks a tie by whoever reached the total first', async () => {
    const raceId = await insertRace();
    const early = randomUUID();
    const late = randomUUID();
    await insertWager(raceId, early, '200');
    // A distinct later `updatedAt` for the tie-break: insert then update so the row's own
    // timestamp actually moves forward of `early`'s.
    await insertWager(raceId, late, '100');
    await db.drizzle.db
      .update(promoRaceWager)
      .set({ wagered: '200' })
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

    expect(convert).toHaveBeenCalledWith('500', 'USDT', 'USD');
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
