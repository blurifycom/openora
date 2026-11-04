import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock } from '../../../testing/mock.js';
import type { WagerProduct, WalletCommands } from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import {
  promoPlayerRank,
  promoRankConfig,
  promoRankTier,
  promoStreakConfig,
} from '../schema/index.js';
import { DEFAULT_PAYOUT_ANCHORS } from '../contract/index.js';
import { RakebackService } from '../service/rakeback.service.js';

const MIGRATIONS = new URL('../drizzle/migrations/', import.meta.url);
const EVERY_PRODUCT = ['casino', 'live-casino', 'sportsbook', 'pvp'] satisfies WagerProduct[];

const BACKFILL_TAG = (
  JSON.parse(readFileSync(fileURLToPath(new URL('meta/_journal.json', MIGRATIONS)), 'utf8')) as {
    entries: { tag: string }[];
  }
).entries
  .map((e) => e.tag)
  .find((tag) => tag.endsWith('_rank_streak_products_required'));

const BACKFILL_SQL = readFileSync(
  fileURLToPath(new URL(`${BACKFILL_TAG}.sql`, MIGRATIONS)),
  'utf8',
).split('--> statement-breakpoint');

let db: TestDb;
const credit = vi.fn<WalletCommands['credit']>();
let rakeback: RakebackService;

beforeAll(async () => {
  db = await createTestDb([migrate]);
  rakeback = new RakebackService(() => mock<WalletCommands>({ credit }), { warn: vi.fn() });
});

afterAll(() => db.drop());

beforeEach(async () => {
  vi.clearAllMocks();
  credit.mockResolvedValue({ ok: true, moved: true, transactionId: randomUUID(), newBalance: '0' });
  await db.drizzle.db.delete(promoPlayerRank);
  await db.drizzle.db.delete(promoRankTier);
  await db.drizzle.db.delete(promoRankConfig);
  await db.drizzle.db.delete(promoStreakConfig);
});

async function asBeforeTheUpgrade() {
  await db.drizzle.db.execute(sql`ALTER TABLE "promo_rank_config"
    DROP CONSTRAINT "promo_rank_config_eligible_products_set",
    DROP CONSTRAINT "promo_rank_config_rakeback_eligible_products_set",
    DROP CONSTRAINT "promo_rank_config_rank_challenge_eligible_products_set",
    ALTER COLUMN "eligible_products" SET DEFAULT '{}'`);
  await db.drizzle.db.execute(sql`ALTER TABLE "promo_streak_config"
    DROP CONSTRAINT "promo_streak_config_eligible_products_set",
    ALTER COLUMN "eligible_products" SET DEFAULT '{}'`);
}

async function upgrade() {
  for (const statement of BACKFILL_SQL) {
    await db.drizzle.db.execute(sql.raw(statement));
  }
}

const saveRankConfig = (
  lists: Pick<
    typeof promoRankConfig.$inferInsert,
    'eligibleProducts' | 'rakebackEligibleProducts' | 'rankChallengeEligibleProducts'
  >,
) =>
  db.drizzle.db.insert(promoRankConfig).values({ ...lists, payoutAnchors: DEFAULT_PAYOUT_ANCHORS });

const saveStreakConfig = (eligibleProducts: string[]) =>
  db.drizzle.db
    .insert(promoStreakConfig)
    .values({ currency: 'USDT', dailyMinWager: '10', eligibleProducts });

async function playerOnTier() {
  const [tier] = await db.drizzle.db
    .insert(promoRankTier)
    .values({
      key: 'bronze',
      name: 'Bronze',
      position: 0,
      currency: 'USDT',
      wagerThreshold: '0',
      rakebackPercent: '1',
    })
    .returning({ id: promoRankTier.id });
  const userId = randomUUID();
  await db.drizzle.db
    .insert(promoPlayerRank)
    .values({ userId, currency: 'USDT', tierId: tier?.id });
  return userId;
}

describe('product lists on upgrade', () => {
  it('gives every empty list all products, so a sportsbook bet still earns rakeback', async () => {
    await asBeforeTheUpgrade();
    await saveRankConfig({
      eligibleProducts: [],
      rakebackEligibleProducts: [],
      rankChallengeEligibleProducts: [],
    });
    await saveStreakConfig([]);
    const userId = await playerOnTier();

    await upgrade();
    await db.drizzle.db.transaction((tx) =>
      rakeback.recordSettledWager(tx, {
        userId,
        currency: 'USDT',
        realAmount: '100',
        context: { provider: 'sportsbook', product: 'sportsbook' },
        round: { providerName: 'sportsbook:provider', externalRoundId: randomUUID() },
        qualifiedAt: new Date(),
      }),
    );

    const [rank] = await db.drizzle.db.select().from(promoRankConfig);
    const [streak] = await db.drizzle.db.select().from(promoStreakConfig);
    expect(rank).toMatchObject({
      eligibleProducts: EVERY_PRODUCT,
      rakebackEligibleProducts: EVERY_PRODUCT,
      rankChallengeEligibleProducts: EVERY_PRODUCT,
    });
    expect(streak?.eligibleProducts).toEqual(EVERY_PRODUCT);
    expect(credit).toHaveBeenCalledTimes(1);
  });

  it('keeps a list the operator named, even one naming no product the platform has', async () => {
    await asBeforeTheUpgrade();
    await saveRankConfig({
      eligibleProducts: ['slots'],
      rakebackEligibleProducts: ['casino'],
      rankChallengeEligibleProducts: ['pvp', 'sportsbook'],
    });
    await saveStreakConfig(['live-casino']);

    await upgrade();

    const [rank] = await db.drizzle.db.select().from(promoRankConfig);
    const [streak] = await db.drizzle.db.select().from(promoStreakConfig);
    expect(rank).toMatchObject({
      eligibleProducts: ['slots'],
      rakebackEligibleProducts: ['casino'],
      rankChallengeEligibleProducts: ['pvp', 'sportsbook'],
    });
    expect(streak?.eligibleProducts).toEqual(['live-casino']);
  });

  it('refuses an empty list once upgraded', async () => {
    const violation = (constraint: string) => ({
      cause: expect.objectContaining({ code: '23514', constraint }),
    });

    await expect(
      saveRankConfig({
        eligibleProducts: [],
        rakebackEligibleProducts: ['casino'],
        rankChallengeEligibleProducts: ['casino'],
      }),
    ).rejects.toMatchObject(violation('promo_rank_config_eligible_products_set'));
    await expect(saveStreakConfig([])).rejects.toMatchObject(
      violation('promo_streak_config_eligible_products_set'),
    );

    await saveRankConfig({
      eligibleProducts: ['casino'],
      rakebackEligibleProducts: ['casino'],
      rankChallengeEligibleProducts: ['casino'],
    });
    await expect(
      db.drizzle.db.update(promoRankConfig).set({ rakebackEligibleProducts: [] }),
    ).rejects.toMatchObject(violation('promo_rank_config_rakeback_eligible_products_set'));
    await expect(
      db.drizzle.db.update(promoRankConfig).set({ rankChallengeEligibleProducts: [] }),
    ).rejects.toMatchObject(violation('promo_rank_config_rank_challenge_eligible_products_set'));
  });
});
