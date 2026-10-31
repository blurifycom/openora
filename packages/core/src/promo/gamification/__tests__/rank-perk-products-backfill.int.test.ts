import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock } from '../../../testing/mock.js';
import type { WalletCommands } from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import { promoPlayerRank, promoRankConfig, promoRankTier } from '../schema/index.js';
import { DEFAULT_PAYOUT_ANCHORS, DEFAULT_RANK_PERK_PRODUCTS } from '../contract/index.js';
import { seedRankLadder } from '../seed/index.js';
import { RakebackService } from '../service/rakeback.service.js';

const MIGRATIONS = new URL('../drizzle/migrations/', import.meta.url);
const ADDED_IN = '0018_aberrant_killer_shrike';

const JOURNAL_TAGS = (
  JSON.parse(readFileSync(fileURLToPath(new URL('meta/_journal.json', MIGRATIONS)), 'utf8')) as {
    entries: { tag: string }[];
  }
).entries.map((e) => e.tag);

const sqlOf = (tag: string) =>
  readFileSync(fileURLToPath(new URL(`${tag}.sql`, MIGRATIONS)), 'utf8').split(
    '--> statement-breakpoint',
  );

const UPGRADE_SQL = JOURNAL_TAGS.slice(JOURNAL_TAGS.indexOf(ADDED_IN)).flatMap(sqlOf);

const LADDER = {
  currency: 'USDT',
  tiers: [{ key: 'bronze', name: 'Bronze', wagerThreshold: '0', rakebackPercent: '1' }],
  config: {
    eligibleProducts: [],
    rewards: {},
    payoutAnchors: DEFAULT_PAYOUT_ANCHORS,
    payInPlayerCurrency: false,
    periodicRequiresActivity: true,
  },
};

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
});

async function upgradeFromBeforeProductLists() {
  await db.drizzle.db.execute(sql`ALTER TABLE "promo_rank_config"
    DROP COLUMN "rakeback_eligible_products", DROP COLUMN "rank_challenge_eligible_products"`);
  for (const statement of UPGRADE_SQL) {
    await db.drizzle.db.execute(sql.raw(statement));
  }
}

describe('rank perk product lists on upgrade', () => {
  it('keeps every product on a ladder configured before the lists existed', async () => {
    await seedRankLadder(db.drizzle.db, LADDER);
    await upgradeFromBeforeProductLists();
    const userId = randomUUID();
    const [tier] = await db.drizzle.db
      .select({ id: promoRankTier.id })
      .from(promoRankTier)
      .where(eq(promoRankTier.key, 'bronze'));
    await db.drizzle.db
      .insert(promoPlayerRank)
      .values({ userId, currency: 'USDT', tierId: tier?.id });

    await db.drizzle.db.transaction((tx) =>
      rakeback.recordWager(tx, {
        userId,
        currency: 'USDT',
        amount: '100',
        weightedAmount: '100',
        realAmount: '100',
        context: { provider: 'sportsbook', product: 'sportsbook' },
      }),
    );

    const [config] = await db.drizzle.db.select().from(promoRankConfig);
    expect(config).toMatchObject({
      rakebackEligibleProducts: [],
      rankChallengeEligibleProducts: [],
    });
    expect(credit).toHaveBeenCalledTimes(1);
  });

  it('keeps a list the operator saved when the backfill runs after it', async () => {
    await upgradeFromBeforeProductLists();
    await seedRankLadder(db.drizzle.db, LADDER);
    await db.drizzle.db
      .update(promoRankConfig)
      .set({ rakebackEligibleProducts: ['casino', 'sportsbook'] });

    for (const statement of sqlOf('0019_rank_perk_products_backfill')) {
      await db.drizzle.db.execute(sql.raw(statement));
    }

    const [config] = await db.drizzle.db.select().from(promoRankConfig);
    expect(config).toMatchObject({
      rakebackEligibleProducts: ['casino', 'sportsbook'],
      rankChallengeEligibleProducts: [],
    });
  });

  it('gives a ladder configured after the upgrade the narrow default', async () => {
    await upgradeFromBeforeProductLists();
    await seedRankLadder(db.drizzle.db, LADDER);

    const [config] = await db.drizzle.db.select().from(promoRankConfig);
    expect(config).toMatchObject({
      rakebackEligibleProducts: [...DEFAULT_RANK_PERK_PRODUCTS],
      rankChallengeEligibleProducts: [...DEFAULT_RANK_PERK_PRODUCTS],
    });
  });
});
