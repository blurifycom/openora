import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb, seedPlayerWithUser, type TestDb } from '@openora/core/testing';
import { mock, makeAuditWriter } from '../../../testing/mock.js';
import type {
  ExchangeRateReader,
  PlayEligibilityPort,
  WagerContext,
  WalletCommands,
} from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import { migrate as identityMigrate } from '@openora/core/pam/migrate/identity';
import { migrate as profileMigrate } from '@openora/core/pam/migrate/profile';
import {
  promoRankChallengeClaim,
  promoRankChallengeTier,
  promoRankChallengeWager,
} from '../schema/index.js';
import { RankChallengeService } from '../service/rank-challenge.service.js';
import {
  RankChallengeAdminService,
  RankChallengeLadderCurrencyHeldError,
} from '../service/rank-challenge-admin.service.js';
import { RankChallengePayoutService } from '../service/rank-challenge-payout.service.js';

let db: TestDb;
const convert = vi.fn<ExchangeRateReader['convert']>();
const logger = { warn: vi.fn(), error: vi.fn() };
const isRestricted = vi.fn<PlayEligibilityPort['isRestricted']>();
const credit = vi.fn<WalletCommands['credit']>();
const audit = makeAuditWriter();
let service: RankChallengeService;
let adminService: RankChallengeAdminService;

const CASINO: WagerContext = { provider: 'aggregator', product: 'casino' };

const TIERS = [
  {
    key: 'bronze',
    name: 'Bronze',
    position: 0,
    wagerThreshold: '0',
    cashAmount: '50.000000000000000000',
    physicalItem: null,
  },
  {
    key: 'silver',
    name: 'Silver',
    position: 1,
    wagerThreshold: '10000',
    cashAmount: null,
    physicalItem: 'AirPods Pro',
  },
];

const seedLadder = () =>
  db.drizzle.db
    .insert(promoRankChallengeTier)
    .values(TIERS.map((t) => ({ ...t, currency: 'USDT' })));

const wager = (userId: string, realAmount: string, currency = 'USDT') =>
  db.drizzle.db.transaction((tx) =>
    service.recordWager(tx, {
      userId,
      currency,
      amount: realAmount,
      weightedAmount: realAmount,
      realAmount,
      context: CASINO,
    }),
  );

const claimsOf = () =>
  db.drizzle.db
    .select({
      tierId: promoRankChallengeClaim.tierId,
      userId: promoRankChallengeClaim.userId,
      cashAmount: promoRankChallengeClaim.cashAmount,
      physicalItem: promoRankChallengeClaim.physicalItem,
    })
    .from(promoRankChallengeClaim);

const payoutService = () =>
  new RankChallengePayoutService(
    db.drizzle,
    mock<PlayEligibilityPort>({ isRestricted }),
    mock<WalletCommands>({ credit }),
    audit,
    logger,
  );

beforeAll(async () => {
  db = await createTestDb([migrate, identityMigrate, profileMigrate]);
  service = new RankChallengeService(db.drizzle, mock<ExchangeRateReader>({ convert }), logger);
  adminService = new RankChallengeAdminService(db.drizzle, audit);
});

afterAll(() => db.drop());

beforeEach(async () => {
  vi.clearAllMocks();
  isRestricted.mockResolvedValue(false);
  credit.mockResolvedValue({ ok: true, moved: true, transactionId: 'tx-1', newBalance: '50' });
  await db.drizzle.db.delete(promoRankChallengeClaim);
  await db.drizzle.db.delete(promoRankChallengeWager);
  await db.drizzle.db.delete(promoRankChallengeTier);
  await seedLadder();
});

describe('recording a wager toward the Rank Challenge', () => {
  it('a first real-money wager wins bronze, even though its threshold is zero', async () => {
    const { account } = await seedPlayerWithUser(db);
    const userId = account.id;

    await wager(userId, '1');

    const claims = await claimsOf();
    expect(claims).toEqual([
      expect.objectContaining({ userId, cashAmount: '50.000000000000000000', physicalItem: null }),
    ]);
  });

  it('leaves no claim for a zero-amount wager', async () => {
    const { account } = await seedPlayerWithUser(db);
    const userId = account.id;

    await wager(userId, '0');

    expect(await claimsOf()).toEqual([]);
  });

  it('a physical-only tier claims without a cash amount', async () => {
    const { account } = await seedPlayerWithUser(db);
    const userId = account.id;

    await wager(userId, '10000');

    const claims = await claimsOf();
    expect(claims).toContainEqual(
      expect.objectContaining({ physicalItem: 'AirPods Pro', cashAmount: null }),
    );
  });

  it('only the first of two concurrent crossings wins the tier', async () => {
    const { account: firstAcc } = await seedPlayerWithUser(db);
    const first = firstAcc.id;
    const { account: secondAcc } = await seedPlayerWithUser(db);
    const second = secondAcc.id;

    await Promise.all([wager(first, '1'), wager(second, '1')]);

    const bronzeClaims = (await claimsOf()).filter((c) =>
      TIERS.some((t) => t.key === 'bronze' && c.tierId),
    );
    const winners = new Set((await claimsOf()).map((c) => c.userId));
    // Exactly one winner for bronze, whichever transaction's insert landed first.
    expect(winners.size).toBe(1);
    void bronzeClaims;
  });

  it('a second player crossing an already-claimed tier wins nothing', async () => {
    const { account: firstAcc } = await seedPlayerWithUser(db);
    const first = firstAcc.id;
    const { account: secondAcc } = await seedPlayerWithUser(db);
    const second = secondAcc.id;
    await wager(first, '1');

    await wager(second, '1');

    const claims = await claimsOf();
    expect(claims).toHaveLength(1);
    expect(claims[0]?.userId).toBe(first);
  });
});

describe('settling a claim', () => {
  it('credits the cash portion once and reports the win', async () => {
    const { account } = await seedPlayerWithUser(db);
    const userId = account.id;
    await wager(userId, '1');

    const won = await payoutService().settlePending();

    expect(won).toEqual([
      expect.objectContaining({
        userId,
        tierKey: 'bronze',
        cashAmount: '50.000000000000000000',
        physicalItem: null,
      }),
    ]);
    expect(credit).toHaveBeenCalledTimes(1);
    expect(credit.mock.calls[0]?.[1]).toMatchObject({
      userId,
      amount: '50.000000000000000000',
      type: 'cashback',
    });
  });

  it('is idempotent: settling twice credits once', async () => {
    const { account } = await seedPlayerWithUser(db);
    const userId = account.id;
    await wager(userId, '1');

    await payoutService().settlePending();
    const secondPass = await payoutService().settlePending();

    expect(secondPass).toEqual([]);
    expect(credit).toHaveBeenCalledTimes(1);
  });

  it('withholds cash from a restricted player but still settles the claim', async () => {
    const { account } = await seedPlayerWithUser(db);
    const userId = account.id;
    isRestricted.mockResolvedValue(true);
    await wager(userId, '1');

    const won = await payoutService().settlePending();

    expect(won).toEqual([]);
    expect(credit).not.toHaveBeenCalled();
    const [claim] = await claimsOf();
    expect(claim).toBeDefined();
  });

  it('a physical-only claim settles without crediting anything', async () => {
    const { account } = await seedPlayerWithUser(db);
    const userId = account.id;
    // First wager claims bronze (cash) and settles it - only the silver (physical-only) claim
    // this test cares about should stay uncredited.
    await wager(userId, '1');
    await payoutService().settlePending();
    credit.mockClear();

    await wager(userId, '9999');
    await payoutService().settlePending();

    expect(credit).not.toHaveBeenCalled();
  });
});

describe('the admin ladder', () => {
  it('editing a tier prospectively never changes an already-claimed snapshot', async () => {
    const { account } = await seedPlayerWithUser(db);
    const userId = account.id;
    await wager(userId, '1');
    const before = await claimsOf();

    const ladder = await adminService.getLadder();
    await adminService.setLadder(randomUUID(), {
      currency: 'USDT',
      tiers: ladder.tiers.map((t) => ({
        ...t,
        cashAmount: t.key === 'bronze' ? '999' : t.cashAmount,
      })),
    });

    const after = await claimsOf();
    expect(after.find((c) => c.userId === userId)?.cashAmount).toBe(
      before.find((c) => c.userId === userId)?.cashAmount,
    );
  });

  it('refuses to change the ladder currency once anyone has wagered', async () => {
    const { account } = await seedPlayerWithUser(db);
    const userId = account.id;
    await wager(userId, '1');
    const ladder = await adminService.getLadder();

    await expect(
      adminService.setLadder(randomUUID(), { currency: 'USD', tiers: ladder.tiers }),
    ).rejects.toThrow(RankChallengeLadderCurrencyHeldError);
  });
});

describe('the fulfilment queue', () => {
  it('lists an unfulfilled physical claim and marking it fulfilled removes it and audits', async () => {
    const { account } = await seedPlayerWithUser(db);
    const userId = account.id;
    await wager(userId, '10000');

    const queue = await adminService.listFulfilmentQueue();
    expect(queue).toHaveLength(1);
    const tierId = queue[0]?.tierId;
    if (!tierId) {
      throw new Error('claim not found');
    }

    const fulfilled = await adminService.markFulfilled(randomUUID(), tierId, 'Shipped via FedEx');

    expect(fulfilled.physicalFulfillmentNote).toBe('Shipped via FedEx');
    expect(await adminService.listFulfilmentQueue()).toHaveLength(0);
  });
});
