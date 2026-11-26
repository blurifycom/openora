import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { JOB_QUEUE, queue } from '@openora/core/contracts';
import { DRIZZLE } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { promoGrant } from '@openora/core/promo/schema/bonus';
import { promoRace, promoRacePayout } from '@openora/core/promo/schema/gamification';
import { flushAudit, newPlayer, type TestClient } from '../index.js';
import { bootWalletE2e, closeWalletE2e, type WalletE2e } from './support/wallet.js';
import {
  allLedgerRowsOf,
  bodyOf,
  fundedBettor,
  gameAdapterPlugin,
  geoIpPlugin,
  newGame,
  startedRound,
  type Bettor,
} from './support/casino.js';

let e2e: WalletE2e;

beforeAll(async () => {
  e2e = await bootWalletE2e([geoIpPlugin, gameAdapterPlugin]);
}, 120_000);

afterAll(() => closeWalletE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;

const ErrorSchema = z.object({ code: z.string(), status: z.number() });
const RaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  currency: z.string(),
  startAt: z.string(),
  endAt: z.string(),
  prizePool: z.string(),
  positions: z.array(z.object({ position: z.number(), prize: z.string() })),
  eligibleProducts: z.array(z.string()),
  closedAt: z.string().nullable(),
});
const EntrySchema = z.object({
  userId: z.string(),
  username: z.string(),
  wagered: z.string(),
  position: z.number(),
});
const RaceViewSchema = z.object({
  race: RaceSchema,
  podium: z.array(EntrySchema),
  leaderboard: z.array(EntrySchema),
  own: z.object({
    userId: z.string(),
    wagered: z.string(),
    position: z.number().nullable(),
    amountToNextPaidPosition: z.string().nullable(),
  }),
  participants: z.number(),
});

const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

type RaceOverrides = Record<string, unknown>;

const raceBody = (overrides: RaceOverrides = {}) => ({
  name: `Race ${randomUUID()}`,
  currency: 'USD',
  startAt: hoursFromNow(-2),
  endAt: hoursFromNow(2),
  prizePool: '100',
  positions: [{ position: 1, prize: '10' }],
  eligibleProducts: ['casino'],
  ...overrides,
});

async function newRace(overrides: RaceOverrides = {}) {
  const res = await e2e.admin.post('/backoffice/promo/races', raceBody(overrides));
  if (res.status !== 200) {
    throw new Error(`race create failed (${res.status}): ${await res.text()}`);
  }
  return RaceSchema.parse(await bodyOf(res));
}

async function raceView(client: TestClient, raceId: string) {
  const res = await client.get(`/promo/races/${raceId}`);
  expect(res.status).toBe(200);
  return RaceViewSchema.parse(await bodyOf(res));
}

async function wager(bettor: Bettor, amount: string) {
  const { gameId } = await newGame(e2e);
  await startedRound(bettor, gameId, amount);
}

async function closeNow(raceId: string) {
  const race = await e2e.admin.get(`/backoffice/promo/races/${raceId}`);
  const current = RaceSchema.parse(await bodyOf(race));
  const moved = await e2e.admin.put(`/backoffice/promo/races/${raceId}`, {
    raceId,
    name: current.name,
    currency: current.currency,
    startAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    endAt: new Date(Date.now() - 1_000).toISOString(),
    prizePool: current.prizePool,
    positions: current.positions,
    eligibleProducts: current.eligibleProducts,
  });
  expect(moved.status).toBe(200);
  await runPayoutJob(raceId);
}

async function runPayoutJob(raceId: string) {
  await e2e.app.container.get(JOB_QUEUE).enqueue(queue('promo-race-payout'), {});
  await vi.waitFor(
    async () => {
      const [row] = await db().select().from(promoRace).where(eq(promoRace.id, raceId));
      expect(row?.closedAt).not.toBeNull();
    },
    { timeout: 20_000, interval: 200 },
  );
}

const payoutRows = (raceId: string) =>
  db().select().from(promoRacePayout).where(eq(promoRacePayout.raceId, raceId));

const prizeRowsOf = async (userId: string) =>
  (await allLedgerRowsOf(e2e, userId)).filter((row) => row.type === 'cashback');

describe('player races', () => {
  it('the active race list returns only races inside their window', async () => {
    const player = await newPlayer(e2e.app, 'race-list');
    const active = await newRace();
    const upcoming = await newRace({ startAt: hoursFromNow(1), endAt: hoursFromNow(3) });
    const ended = await newRace({ startAt: hoursFromNow(-4), endAt: hoursFromNow(-3) });

    const res = await player.client.get('/promo/races');

    expect(res.status).toBe(200);
    const ids = z
      .array(RaceSchema)
      .parse(await bodyOf(res))
      .map((race) => race.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(upcoming.id);
    expect(ids).not.toContain(ended.id);
  });

  it('wagering during a race moves the player up the leaderboard', async () => {
    const small = await fundedBettor(e2e);
    const big = await fundedBettor(e2e);
    const race = await newRace({
      currency: small.currency,
      positions: [{ position: 1, prize: '5' }],
    });

    await wager(small, '2');
    const before = await raceView(big.client, race.id);
    await wager(big, '5');
    const after = await raceView(big.client, race.id);

    expect(before.own).toMatchObject({ wagered: '0', position: null });
    expect(after.own.position).toBe(1);
    expect(after.own.wagered).toBe('5.000000000000000000');
    const smallView = await raceView(small.client, race.id);
    expect(smallView.own.position).toBe(2);
    expect(smallView.own.wagered).toBe('2.000000000000000000');
    expect(smallView.own.amountToNextPaidPosition).toBe('3.000000000000000000');
    expect(after.participants).toBe(2);
  });

  it('reading a race that does not exist returns not found', async () => {
    const player = await newPlayer(e2e.app, 'race-missing');

    const res = await player.client.get(`/promo/races/${randomUUID()}`);

    expect(res.status).toBe(404);
    expect(ErrorSchema.parse(await bodyOf(res)).code).toBe('NOT_FOUND');
  });

  it('a race without a bonus reports positions and pays nothing in bonus funds', async () => {
    const bettor = await fundedBettor(e2e);
    const race = await newRace({
      currency: bettor.currency,
      prizePool: '30',
      positions: [
        { position: 1, prize: '20' },
        { position: 2, prize: '10' },
      ],
    });

    await wager(bettor, '2');
    const view = await raceView(bettor.client, race.id);

    expect(view.race.positions.map((entry) => entry.position)).toEqual([1, 2]);
    expect(view.own.position).toBe(1);
    expect(await payoutRows(race.id)).toEqual([]);
    await closeNow(race.id);
    await vi.waitFor(async () => expect(await payoutRows(race.id)).toHaveLength(1), {
      timeout: 10_000,
      interval: 100,
    });
    const [payout] = await payoutRows(race.id);
    expect(payout).toMatchObject({ outcome: 'granted', grantId: null });
    expect(
      await db().select().from(promoGrant).where(eq(promoGrant.userId, bettor.userId)),
    ).toEqual([]);
    const bonusRows = (await allLedgerRowsOf(e2e, bettor.userId)).filter((row) =>
      row.type.includes('bonus'),
    );
    expect(bonusRows).toEqual([]);
  });

  it('a closed race pays its prizes once and a second close pays nothing', async () => {
    const winner = await fundedBettor(e2e);
    const loser = await fundedBettor(e2e);
    const outsider = await newPlayer(e2e.app, 'race-outsider');
    const race = await newRace({
      currency: winner.currency,
      prizePool: '20',
      positions: [{ position: 1, prize: '20' }],
    });
    await wager(winner, '4');
    await wager(loser, '1');

    await closeNow(race.id);
    await vi.waitFor(async () => expect(await prizeRowsOf(winner.userId)).toHaveLength(1), {
      timeout: 10_000,
      interval: 100,
    });
    await e2e.app.container.get(JOB_QUEUE).enqueue(queue('promo-race-payout'), {});
    const sentinel = await newRace({ currency: winner.currency });
    await closeNow(sentinel.id);

    const payouts = await payoutRows(race.id);
    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({ userId: winner.userId, position: 1, outcome: 'granted' });
    const prizes = await prizeRowsOf(winner.userId);
    expect(prizes).toHaveLength(1);
    expect(prizes[0]).toMatchObject({
      direction: 'credit',
      providerRefId: `race-payout:${race.id}:${winner.userId}`,
    });
    expect(prizes[0]?.amount).toBe(payouts[0]?.amount);
    expect(await prizeRowsOf(loser.userId)).toEqual([]);
    expect(await prizeRowsOf(outsider.userId)).toEqual([]);
    expect(await allLedgerRowsOf(e2e, outsider.userId)).toEqual([]);
  });

  it('the leaderboard returns only public player fields', async () => {
    const bettor = await fundedBettor(e2e);
    const other = await fundedBettor(e2e);
    const race = await newRace({ currency: bettor.currency });
    await wager(bettor, '3');
    await wager(other, '1');

    const view = await raceView(bettor.client, race.id);

    const entries = [...view.podium, ...view.leaderboard];
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(['position', 'userId', 'username', 'wagered']);
    }
    const theirs = entries.find((entry) => entry.userId === other.userId);
    expect(theirs?.username).toMatch(/\*\*\*\*$/);
  });
});

describe('admin races', () => {
  it('an admin creates a race and the creation is audited', async () => {
    const body = raceBody({ name: `Audited ${randomUUID()}` });

    const res = await e2e.admin.post('/backoffice/promo/races', body);

    expect(res.status).toBe(200);
    const race = RaceSchema.parse(await bodyOf(res));
    expect(race).toMatchObject({ name: body.name, closedAt: null, eligibleProducts: ['casino'] });
    const fetched = await e2e.admin.get(`/backoffice/promo/races/${race.id}`);
    expect(RaceSchema.parse(await bodyOf(fetched)).id).toBe(race.id);
    await vi.waitFor(
      async () => {
        await flushAudit(e2e.app);
        const rows = await db().select().from(auditLog).where(eq(auditLog.resourceId, race.id));
        expect(rows.map((row) => row.action)).toContain('promo.race.created');
      },
      { timeout: 10_000, interval: 100 },
    );
  });

  it('creating a race with invalid prize positions is refused as bad request', async () => {
    const gap = await e2e.admin.post(
      '/backoffice/promo/races',
      raceBody({
        positions: [
          { position: 1, prize: '10' },
          { position: 3, prize: '5' },
        ],
      }),
    );
    const overPool = await e2e.admin.post(
      '/backoffice/promo/races',
      raceBody({ prizePool: '10', positions: [{ position: 1, prize: '11' }] }),
    );

    for (const res of [gap, overPool]) {
      expect(res.status).toBe(400);
      expect(ErrorSchema.parse(await bodyOf(res)).code).toBe('BAD_REQUEST');
    }
  });

  it('updating a closed race is refused with a conflict', async () => {
    const race = await newRace();
    await closeNow(race.id);

    const res = await e2e.admin.put(`/backoffice/promo/races/${race.id}`, {
      raceId: race.id,
      ...raceBody({ name: 'Renamed after close' }),
    });

    expect(res.status).toBe(409);
    expect(ErrorSchema.parse(await bodyOf(res)).code).toBe('CONFLICT');
    const [row] = await db().select().from(promoRace).where(eq(promoRace.id, race.id));
    expect(row?.name).toBe(race.name);
  });

  it('reading an unknown race as admin returns not found', async () => {
    const res = await e2e.admin.get(`/backoffice/promo/races/${randomUUID()}`);

    expect(res.status).toBe(404);
    expect(ErrorSchema.parse(await bodyOf(res)).code).toBe('NOT_FOUND');
  });

  it('a non-admin calling any admin race route is refused as forbidden', async () => {
    const player = await newPlayer(e2e.app, 'race-nonadmin');
    const race = await newRace();

    const responses = await Promise.all([
      player.client.get('/backoffice/promo/races'),
      player.client.get(`/backoffice/promo/races/${race.id}`),
      player.client.post('/backoffice/promo/races', raceBody()),
      player.client.put(`/backoffice/promo/races/${race.id}`, { raceId: race.id, ...raceBody() }),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(ErrorSchema.parse(await bodyOf(res)).code).toBe('FORBIDDEN');
    }
    const [row] = await db().select().from(promoRace).where(eq(promoRace.id, race.id));
    expect(row?.name).toBe(race.name);
  });
});
