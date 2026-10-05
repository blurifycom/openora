import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { createTestDb, seedPlayerWithUser, type TestDb } from '@openora/core/testing';
import { mock } from '../../../testing/mock.js';
import type { ExchangeRateReader, WagerContext } from '@openora/core/contracts';
import { moneyEquals } from '@openora/core/server';
import { migrate } from '../migrate.js';
import { migrate as identityMigrate } from '@openora/core/pam/migrate/identity';
import { migrate as profileMigrate } from '@openora/core/pam/migrate/profile';
import { promoRace, promoRaceWager } from '../schema/index.js';
import { RaceService } from '../service/race.service.js';
import type { RacePosition } from '../contract/index.js';

let db: TestDb;
const convert = vi.fn<ExchangeRateReader['convert']>();
const logger = { warn: vi.fn() };
let races: RaceService;

const CASINO: WagerContext = { provider: 'aggregator', product: 'casino' };
const POSITIONS: RacePosition[] = [
  { position: 1, prize: '500' },
  { position: 2, prize: '250' },
  { position: 3, prize: '100' },
];

const now = () => new Date();
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);

const insertRace = async (overrides: Partial<typeof promoRace.$inferInsert> = {}) => {
  const [row] = await db.drizzle.db
    .insert(promoRace)
    .values({
      name: 'Weekly Race',
      currency: 'USDT',
      startAt: hoursFromNow(-1),
      endAt: hoursFromNow(1),
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

const wager = (
  userId: string,
  amount: string,
  realAmount: string,
  currency = 'USDT',
  context: WagerContext = CASINO,
) =>
  db.drizzle.db.transaction((tx) =>
    races.recordWager(tx, {
      userId,
      currency,
      amount,
      weightedAmount: amount,
      realAmount,
      context,
    }),
  );

const wageredOf = async (raceId: string, userId: string) => {
  const [row] = await db.drizzle.db
    .select({ wagered: promoRaceWager.wagered })
    .from(promoRaceWager)
    .where(and(eq(promoRaceWager.raceId, raceId), eq(promoRaceWager.userId, userId)));
  return row?.wagered ?? null;
};

beforeAll(async () => {
  db = await createTestDb([migrate, identityMigrate, profileMigrate]);
  races = new RaceService(db.drizzle, mock<ExchangeRateReader>({ convert }), logger);
});

afterAll(() => db.drop());

beforeEach(async () => {
  vi.clearAllMocks();
  await db.drizzle.db.delete(promoRaceWager);
  await db.drizzle.db.delete(promoRace);
});

describe('recording a wager toward an open race', () => {
  it('accrues the real-money stake, not the full or bonus-weighted amount', async () => {
    const raceId = await insertRace();
    const userId = randomUUID();

    await wager(userId, '100', '60');

    const [row] = await db.drizzle.db
      .select({ wagered: promoRaceWager.wagered })
      .from(promoRaceWager)
      .where(eq(promoRaceWager.raceId, raceId));
    expect(moneyEquals(row?.wagered ?? '0', '60')).toBe(true);
    expect(convert).not.toHaveBeenCalled();
  });

  it('ignores a wager funded entirely by a bonus', async () => {
    await insertRace();
    const userId = randomUUID();

    await wager(userId, '100', '0');

    const rows = await db.drizzle.db.select().from(promoRaceWager);
    expect(rows).toHaveLength(0);
  });

  it('ignores a race that has not started yet', async () => {
    await insertRace({ startAt: hoursFromNow(1), endAt: hoursFromNow(2) });
    const userId = randomUUID();

    await wager(userId, '100', '100');

    const rows = await db.drizzle.db.select().from(promoRaceWager);
    expect(rows).toHaveLength(0);
  });

  it('ignores a race that has already ended', async () => {
    await insertRace({ startAt: hoursFromNow(-2), endAt: hoursFromNow(-1) });
    const userId = randomUUID();

    await wager(userId, '100', '100');

    const rows = await db.drizzle.db.select().from(promoRaceWager);
    expect(rows).toHaveLength(0);
  });

  it('ignores a closed race even inside its own window', async () => {
    await insertRace({ closedAt: now() });
    const userId = randomUUID();

    await wager(userId, '100', '100');

    const rows = await db.drizzle.db.select().from(promoRaceWager);
    expect(rows).toHaveLength(0);
  });

  it('skips a product the race does not count', async () => {
    await insertRace({ eligibleProducts: ['sportsbook'] });
    const userId = randomUUID();

    await wager(userId, '100', '100', 'USDT', CASINO);

    const rows = await db.drizzle.db.select().from(promoRaceWager);
    expect(rows).toHaveLength(0);
  });

  it('converts a wager placed in another currency into the race currency', async () => {
    const raceId = await insertRace({ currency: 'USDT' });
    const userId = randomUUID();
    convert.mockResolvedValue('50');

    await wager(userId, '100', '100', 'EUR');

    expect(convert).toHaveBeenCalledWith('100', 'EUR', 'USDT');
    expect(moneyEquals((await wageredOf(raceId, userId)) ?? '0', '50')).toBe(true);
  });

  it('accumulates across two bets for the same player', async () => {
    const raceId = await insertRace();
    const userId = randomUUID();

    await wager(userId, '40', '40');
    await wager(userId, '10', '10');

    expect(moneyEquals((await wageredOf(raceId, userId)) ?? '0', '50')).toBe(true);
  });
});

describe('reading a race for a player', () => {
  it('masks another player using the platform masking rule, never masks the caller themselves', async () => {
    const raceId = await insertRace();
    const { account: leader } = await seedPlayerWithUser(db, { username: 'YOLOKing' });
    const { account: caller } = await seedPlayerWithUser(db, { username: 'pvp_Slayer420' });
    await wager(leader.id, '500', '500');
    await wager(caller.id, '10', '10');

    const view = await races.getForPlayer(raceId, caller.id);

    const leaderRow = [...view.podium, ...view.leaderboard].find((r) => r.userId === leader.id);
    expect(leaderRow?.username).not.toBe('YOLOKing');
    expect(leaderRow?.username.startsWith('YO')).toBe(true);
    expect(leaderRow?.username).toContain('*');
    const ownRow = [...view.podium, ...view.leaderboard].find((r) => r.userId === caller.id);
    expect(ownRow?.username).toBe('pvp_Slayer420');
  });

  it('shows "Incognito" for a player who hid their username, without affecting their own entry', async () => {
    const raceId = await insertRace();
    const { account: ghost } = await seedPlayerWithUser(db, {
      username: 'GhostRider',
      hideUsernameOnLeaderboards: true,
    });
    const { account: caller } = await seedPlayerWithUser(db, { username: 'Onlooker' });
    await wager(ghost.id, '500', '500');
    await wager(caller.id, '10', '10');

    const view = await races.getForPlayer(raceId, caller.id);

    const ghostRow = [...view.podium, ...view.leaderboard].find((r) => r.userId === ghost.id);
    expect(ghostRow?.username).toBe('Incognito');

    const ownView = await races.getForPlayer(raceId, ghost.id);
    expect(moneyEquals(ownView.own.wagered, '500')).toBe(true);
    expect(ownView.own.position).toBe(1);
  });

  it('reports the amount still needed to reach the next paid position, and null once already paid', async () => {
    // 3 paid positions; a 4th player sits just outside them.
    const raceId = await insertRace();
    const { account: first } = await seedPlayerWithUser(db);
    const { account: second } = await seedPlayerWithUser(db);
    const { account: third } = await seedPlayerWithUser(db);
    const { account: fourth } = await seedPlayerWithUser(db);
    await wager(first.id, '500', '500');
    await wager(second.id, '400', '400');
    await wager(third.id, '300', '300');
    await wager(fourth.id, '250', '250');

    const chasing = await races.getForPlayer(raceId, fourth.id);
    expect(chasing.own.position).toBe(4);
    expect(moneyEquals(chasing.own.amountToNextPaidPosition ?? '0', '50')).toBe(true);

    const paid = await races.getForPlayer(raceId, third.id);
    expect(paid.own.position).toBe(3);
    expect(paid.own.amountToNextPaidPosition).toBeNull();
  });

  it('returns a null position and no gap for a player who has not wagered in the race', async () => {
    const raceId = await insertRace();
    const { account: bystander } = await seedPlayerWithUser(db);

    const view = await races.getForPlayer(raceId, bystander.id);

    expect(view.own.position).toBeNull();
    expect(view.own.amountToNextPaidPosition).toBeNull();
    expect(moneyEquals(view.own.wagered, '0')).toBe(true);
  });
});
