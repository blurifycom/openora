import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { WAGER_TRACKING } from '@openora/core/contracts';
import {
  promoPlayerRank,
  promoPlayerStreak,
  promoRankConfig,
  promoRankTier,
} from '@openora/core/promo/schema/gamification';
import {
  asAdmin,
  bootE2e,
  closeE2e,
  readJson,
  registerAndMaterializePlayer,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';

const CONFIG_PATH = '/backoffice/promo/streaks/config';
const DAY_MS = 86_400_000;

const CONFIG = {
  enabled: true,
  dailyMinWager: '10',
  eligibleProducts: ['casino'],
  rakebackMilestones: [
    { day: 2, unrankedRatePercent: '5', rankedUpliftPercent: '50' },
    { day: 3, unrankedRatePercent: '10', rankedUpliftPercent: '100' },
  ],
  fixedRewards: [],
};

let db: TestDb;
let app: TestApp;
let admin: TestClient;

const drizzle = () => app.container.get(DRIZZLE).db;

const bet = (userId: string, amount: string) =>
  drizzle().transaction((tx) =>
    app.container.get(WAGER_TRACKING).recordWager(tx, {
      userId,
      currency: 'USD',
      amount,
      weightedAmount: amount,
      realAmount: amount,
      context: { provider: 'aggregator', product: 'casino', rtp: '0.96', gameId: 'slot-1' },
      round: { providerName: 'aggregator', externalRoundId: randomUUID() },
    }),
  );

const accrualsOf = async (userId: string) => {
  const { items } = await readJson(
    await admin.get(`/backoffice/promo/rakeback/accruals?userId=${userId}`),
  );
  return items.toReversed();
};

const playerOnDay = async (current: number, tierKey?: string) => {
  const { client, userId } = await registerAndMaterializePlayer(app, {
    email: `streak-rakeback-${randomUUID()}@example.test`,
  });
  if (tierKey) {
    const [tier] = await drizzle()
      .select()
      .from(promoRankTier)
      .where(eq(promoRankTier.key, tierKey));
    await drizzle().insert(promoPlayerRank).values({ userId, currency: 'USDT', tierId: tier?.id });
  }
  await drizzle()
    .insert(promoPlayerStreak)
    .values({
      userId,
      current,
      best: current,
      lastQualifyingDay: new Date(Date.now() - DAY_MS).toISOString().slice(0, 10),
    });
  return { client, userId };
};

beforeAll(async () => {
  ({ db, app } = await bootE2e({
    plugins: [
      ...(await loadExtensions()),
      {
        id: 'testing-rakeback-claim-config',
        path: fileURLToPath(
          new URL('./fixtures/test-rakeback-claim-config-plugin.ts', import.meta.url),
        ),
      },
    ],
  }));
  admin = await asAdmin(app.app);
  expect((await admin.put(CONFIG_PATH, CONFIG)).status).toBe(200);
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('streak rakeback for a ranked player', () => {
  it('earns the previous rate on the bet that unlocks a milestone, the new one on the next, and the day advances once', async () => {
    const { userId } = await playerOnDay(1, 'bronze');

    await bet(userId, '100');
    await bet(userId, '100');
    await bet(userId, '100');

    expect(await accrualsOf(userId)).toEqual([
      expect.objectContaining({ amount: '0.040000000000000000', streakMode: null }),
      expect.objectContaining({
        amount: '0.060000000000000000',
        ratePercent: '1.00',
        boostPercent: '0.00',
        streakMode: 'ranked',
        streakPercent: '50.00',
      }),
      expect.objectContaining({
        amount: '0.060000000000000000',
        streakMode: 'ranked',
        streakPercent: '50.00',
      }),
    ]);
  });

  it('shows the player the uplift they are earning', async () => {
    const { client, userId } = await playerOnDay(1, 'bronze');
    await bet(userId, '100');
    await bet(userId, '100');

    expect(await readJson(await client.get('/promo/streaks'))).toMatchObject({
      enabled: true,
      current: 2,
      isRanked: true,
      activeRate: { mode: 'ranked', percent: '50' },
      nextMilestone: { day: 3, rakeback: { rankedUpliftPercent: '100' } },
    });
  });
});

describe('streak rakeback for a player with no rank', () => {
  beforeAll(async () => {
    await drizzle().delete(promoPlayerRank);
    await drizzle().delete(promoRankConfig);
    await drizzle().delete(promoRankTier);
  });

  it('pays the unranked rate on the theoretical GGR: 2,500 at 96% rtp with 5% is 5', async () => {
    const { client, userId } = await playerOnDay(2);

    await bet(userId, '2500');
    await bet(userId, '2500');

    expect(await accrualsOf(userId)).toEqual([
      expect.objectContaining({
        amount: '5.000000000000000000',
        stake: '2500.000000000000000000',
        ratePercent: '0.00',
        streakMode: 'unranked',
        streakPercent: '5.00',
      }),
      expect.objectContaining({
        amount: '10.000000000000000000',
        streakMode: 'unranked',
        streakPercent: '10.00',
      }),
    ]);
    expect(await readJson(await client.get('/promo/streaks'))).toMatchObject({
      isRanked: false,
      activeRate: { mode: 'unranked', percent: '10' },
    });
  });

  it('pays nothing once the operator switches the streak off', async () => {
    const { userId } = await playerOnDay(2);
    expect((await admin.put(CONFIG_PATH, { ...CONFIG, enabled: false })).status).toBe(200);

    await bet(userId, '2500');
    await admin.put(CONFIG_PATH, CONFIG);

    expect(await accrualsOf(userId)).toEqual([]);
  });
});
