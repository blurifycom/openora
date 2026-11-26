import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as z from 'zod';
import { LEDGER_API_V1, LedgerV1MoveOutcomeSchema } from '@openora/core/contracts';
import { DRIZZLE } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { user } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import {
  promoRakebackAccrual,
  promoRakebackClaim,
  promoRakebackClaimPayout,
} from '@openora/core/promo/schema/gamification';
import { flushAudit, newPlayer, newStaff, type TestClient } from '../index.js';
import { balanceOf, bootWalletE2e, closeWalletE2e, type WalletE2e } from './support/wallet.js';
import {
  allLedgerRowsOf,
  bodyOf,
  fundedBettor,
  newGame,
  scaled,
  type Bettor,
} from './support/casino.js';

const claimModePlugin = {
  id: 'testing-rakeback-claim',
  path: fileURLToPath(new URL('./support/test-rakeback-claim-plugin.ts', import.meta.url)),
};

const BRONZE_PERCENT = '5';
const SILVER_PERCENT = '8';
const SILVER_THRESHOLD_USD = '60';
const CURRENCY_RATE_TO_USD = 1.5;

const ErrorSchema = z.object({ code: z.string(), status: z.number() });
const CurrencyAmountSchema = z.object({ currency: z.string(), amount: z.string() });
const SummarySchema = z.object({
  unclaimed: z.array(CurrencyAmountSchema.extend({ referenceAmount: z.string().nullable() })),
  referenceCurrency: z.string(),
  referenceTotal: z.string(),
  claimMinimum: z.string(),
  claimBlockedBy: z.string().nullable(),
  lifetimeClaimed: z.array(CurrencyAmountSchema),
});
const ClaimSchema = z.object({ claimId: z.string(), paid: z.array(CurrencyAmountSchema) });
const AccrualSchema = z.object({
  id: z.string(),
  userId: z.string(),
  currency: z.string(),
  amount: z.string(),
  stake: z.string(),
  status: z.string(),
  claimId: z.string().nullable(),
  voidedBy: z.string().nullable(),
  voidReason: z.string().nullable(),
});
const AccrualPageSchema = z.object({ items: z.array(AccrualSchema), total: z.number() });
const PlayerSummarySchema = SummarySchema.pick({ unclaimed: true, lifetimeClaimed: true }).extend({
  userId: z.string(),
});
const LiabilitySchema = SummarySchema.pick({
  unclaimed: true,
  referenceCurrency: true,
  referenceTotal: true,
});

const dbOf = (e2e: WalletE2e) => e2e.app.container.get(DRIZZLE).db;

async function configureLadder(e2e: WalletE2e) {
  const config = await e2e.admin.put('/backoffice/promo/ranks/config', {
    eligibleProducts: ['casino'],
    rakebackEligibleProducts: ['casino'],
    rewards: {},
  });
  if (config.status !== 200) {
    throw new Error(`rank config failed (${config.status}): ${await config.text()}`);
  }
  const tier = (key: string, wagerThreshold: string, rakebackPercent: string) => ({
    key,
    name: key,
    wagerThreshold,
    rakebackPercent,
    dailyBonus: null,
    weeklyBonus: null,
    monthlyBonus: null,
    levelUpBonus: null,
  });
  const ladder = await e2e.admin.put('/backoffice/promo/ranks', {
    currency: 'USD',
    tiers: [
      tier('bronze', '0', BRONZE_PERCENT),
      tier('silver', SILVER_THRESHOLD_USD, SILVER_PERCENT),
    ],
  });
  if (ladder.status !== 200) {
    throw new Error(`rank ladder failed (${ladder.status}): ${await ladder.text()}`);
  }
}

async function wager(e2e: WalletE2e, bettor: Bettor, amount: string, gameId?: string) {
  const game = gameId ?? (await newGame(e2e)).gameId;
  const vendor = `vendor-${randomUUID().slice(0, 8)}`;
  const betRef = `bet-${randomUUID()}`;
  const outcome = LedgerV1MoveOutcomeSchema.parse(
    await e2e.app.container.get(LEDGER_API_V1).bet({
      userId: bettor.userId,
      gameId: game,
      currency: bettor.currency,
      providerName: vendor,
      providerRefId: betRef,
      externalRoundId: `round-${randomUUID()}`,
      amount,
      wager: { product: 'casino' },
    }),
  );
  expect(outcome.status).toBe('applied');
  return { gameId: game, vendor, betRef };
}

const accrualsOf = (e2e: WalletE2e, userId: string) =>
  dbOf(e2e).select().from(promoRakebackAccrual).where(eq(promoRakebackAccrual.userId, userId));

const cashbackRows = async (e2e: WalletE2e, userId: string) =>
  (await allLedgerRowsOf(e2e, userId)).filter((row) => row.type === 'cashback');

const claimWith = (client: TestClient, idempotencyKey = randomUUID()) =>
  client.post('/promo/rakeback/claim', { idempotencyKey });

async function summaryOf(client: TestClient) {
  const res = await client.get('/promo/rakeback');
  expect(res.status).toBe(200);
  return SummarySchema.parse(await bodyOf(res));
}

async function bettorWithAccrual(e2e: WalletE2e, bet: string, funds = '50') {
  const bettor = await fundedBettor(e2e, funds);
  await wager(e2e, bettor, bet);
  return bettor;
}

const errorOf = async (res: Response) => ErrorSchema.parse(await bodyOf(res));

describe('player rakeback', () => {
  let e2e: WalletE2e;

  beforeAll(async () => {
    e2e = await bootWalletE2e([claimModePlugin]);
    await configureLadder(e2e);
  }, 120_000);

  afterAll(() => closeWalletE2e(e2e));

  it("a ranked player's bets accrue rakeback at the tier rate and the summary shows the unclaimed amount", async () => {
    const bronze = await fundedBettor(e2e, '50');
    const silver = await fundedBettor(e2e, '100');
    const silverStake = (Number(SILVER_THRESHOLD_USD) / CURRENCY_RATE_TO_USD).toString();

    await wager(e2e, bronze, '10');
    await wager(e2e, silver, silverStake);

    const [bronzeAccrual] = await accrualsOf(e2e, bronze.userId);
    expect(bronzeAccrual).toMatchObject({
      currency: bronze.currency,
      amount: '0.500000000000000000',
      stake: scaled('10'),
      status: 'accrued',
      claimId: null,
    });
    const [silverAccrual] = await accrualsOf(e2e, silver.userId);
    expect(silverAccrual).toMatchObject({
      amount: '3.200000000000000000',
      stake: scaled(silverStake),
      status: 'accrued',
    });
    const summary = await summaryOf(bronze.client);
    expect(summary.unclaimed).toEqual([
      expect.objectContaining({ currency: bronze.currency, amount: '0.500000000000000000' }),
    ]);
    expect(summary.claimBlockedBy).toBeNull();
    expect(summary.lifetimeClaimed).toEqual([]);
    expect(await balanceOf(e2e, bronze.userId, bronze.currency)).toBe(scaled('40'));
    expect(await cashbackRows(e2e, bronze.userId)).toEqual([]);
  });

  it.todo("an unranked player's bets accrue rakeback at the base rate");

  it('claiming accrued rakeback credits the wallet once and marks the accruals claimed', async () => {
    const bettor = await bettorWithAccrual(e2e, '10');
    await wager(e2e, bettor, '20');
    const before = await balanceOf(e2e, bettor.userId, bettor.currency);

    const res = await claimWith(bettor.client);

    expect(res.status).toBe(200);
    const claim = ClaimSchema.parse(await bodyOf(res));
    expect(claim.paid).toEqual([{ currency: bettor.currency, amount: '1.500000000000000000' }]);
    expect(before).toBe(scaled('20'));
    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe('21.500000000000000000');
    const rows = await cashbackRows(e2e, bettor.userId);
    expect(rows).toEqual([
      expect.objectContaining({
        direction: 'credit',
        amount: '1.500000000000000000',
        providerRefId: `${claim.claimId}:${bettor.currency}`,
      }),
    ]);
    const accruals = await accrualsOf(e2e, bettor.userId);
    expect(accruals).toHaveLength(2);
    for (const accrual of accruals) {
      expect(accrual).toMatchObject({ status: 'claimed', claimId: claim.claimId });
    }
    const payouts = await dbOf(e2e)
      .select()
      .from(promoRakebackClaimPayout)
      .where(eq(promoRakebackClaimPayout.claimId, claim.claimId));
    expect(payouts).toEqual([
      expect.objectContaining({
        userId: bettor.userId,
        currency: bettor.currency,
        amount: '1.500000000000000000',
      }),
    ]);
    const summary = await summaryOf(bettor.client);
    expect(summary.unclaimed).toEqual([]);
    expect(summary.lifetimeClaimed).toEqual([
      { currency: bettor.currency, amount: '1.500000000000000000' },
    ]);
    await flushAudit(e2e.app);
    const audits = await dbOf(e2e)
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'promo.rakeback.claimed'), eq(auditLog.resourceId, claim.claimId)),
      );
    expect(audits).toHaveLength(1);
  });

  it('claiming twice returns nothing the second time and the wallet moves only once', async () => {
    const bettor = await bettorWithAccrual(e2e, '10');
    const first = await claimWith(bettor.client);
    expect(first.status).toBe(200);

    const second = await claimWith(bettor.client);

    expect(second.status).toBe(409);
    expect((await errorOf(second)).code).toBe('CONFLICT');
    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe('40.500000000000000000');
    expect(await cashbackRows(e2e, bettor.userId)).toHaveLength(1);
  });

  it('two claims sent at once pay the rakeback once, with or without a shared key', async () => {
    const distinct = await bettorWithAccrual(e2e, '10');
    const shared = await bettorWithAccrual(e2e, '10');
    const key = randomUUID();

    const distinctResults = await Promise.all([
      claimWith(distinct.client),
      claimWith(distinct.client),
    ]);
    const sharedResults = await Promise.all([
      claimWith(shared.client, key),
      claimWith(shared.client, key),
    ]);

    expect(distinctResults.map((res) => res.status).sort()).toEqual([200, 409]);
    for (const res of sharedResults) {
      expect(res.status).toBe(200);
    }
    const sharedClaims = await Promise.all(
      sharedResults.map(async (res) => ClaimSchema.parse(await bodyOf(res))),
    );
    expect(sharedClaims[0]?.claimId).toBe(sharedClaims[1]?.claimId);
    for (const bettor of [distinct, shared]) {
      expect(await cashbackRows(e2e, bettor.userId)).toHaveLength(1);
      expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe('40.500000000000000000');
      expect((await accrualsOf(e2e, bettor.userId))[0]?.status).toBe('claimed');
    }
    const claimRows = await dbOf(e2e)
      .select()
      .from(promoRakebackClaim)
      .where(eq(promoRakebackClaim.userId, distinct.userId));
    expect(claimRows.length).toBeGreaterThanOrEqual(1);
  });

  it('claiming with nothing accrued is refused or returns an empty paid list', async () => {
    const bettor = await fundedBettor(e2e);

    const res = await claimWith(bettor.client);

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('CONFLICT');
    expect(await cashbackRows(e2e, bettor.userId)).toEqual([]);
    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe(scaled('50'));
    expect((await summaryOf(bettor.client)).claimBlockedBy).toBe('nothing_to_claim');
  });

  it('a suspended or closed account cannot claim rakeback', async () => {
    const suspended = await bettorWithAccrual(e2e, '10');
    const closed = await bettorWithAccrual(e2e, '10');
    await dbOf(e2e)
      .update(player)
      .set({ status: 'suspended' })
      .where(eq(player.userId, suspended.userId));
    await dbOf(e2e)
      .update(player)
      .set({ status: 'closed' })
      .where(eq(player.userId, closed.userId));

    const results = [await claimWith(suspended.client), await claimWith(closed.client)];

    for (const res of results) {
      expect(res.status).toBe(403);
      expect((await errorOf(res)).code).toBe('FORBIDDEN');
    }
    for (const bettor of [suspended, closed]) {
      expect(await cashbackRows(e2e, bettor.userId)).toEqual([]);
      expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe(scaled('40'));
      expect((await accrualsOf(e2e, bettor.userId))[0]?.status).toBe('accrued');
    }
  });

  it('a player under a responsible-gambling block cannot claim rakeback', async () => {
    const blocked = await bettorWithAccrual(e2e, '10');
    await dbOf(e2e).update(user).set({ rgBlocked: true }).where(eq(user.id, blocked.userId));

    const res = await claimWith(blocked.client);

    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('FORBIDDEN');
    expect(await cashbackRows(e2e, blocked.userId)).toEqual([]);
    expect((await accrualsOf(e2e, blocked.userId))[0]?.status).toBe('accrued');
  });

  it('a refunded or voided round reverses its accrual', async () => {
    const bettor = await fundedBettor(e2e);
    const placed = await wager(e2e, bettor, '10');
    expect((await accrualsOf(e2e, bettor.userId))[0]?.status).toBe('accrued');

    const reversal = LedgerV1MoveOutcomeSchema.parse(
      await e2e.app.container.get(LEDGER_API_V1).reverse({
        userId: bettor.userId,
        gameId: placed.gameId,
        providerName: placed.vendor,
        providerRefId: `rb-${randomUUID()}`,
        targetRefId: placed.betRef,
      }),
    );

    expect(reversal.status).toBe('applied');
    const [accrual] = await accrualsOf(e2e, bettor.userId);
    expect(accrual).toMatchObject({ status: 'reversed', amount: '0.500000000000000000' });
    expect((await summaryOf(bettor.client)).unclaimed).toEqual([]);
    const res = await claimWith(bettor.client);
    expect(res.status).toBe(409);
    expect(await cashbackRows(e2e, bettor.userId)).toEqual([]);
  });

  it("the rakeback summary of one player never includes another player's accruals", async () => {
    const first = await bettorWithAccrual(e2e, '10');
    const second = await bettorWithAccrual(e2e, '20');

    const firstSummary = await summaryOf(first.client);
    const secondSummary = await summaryOf(second.client);

    expect(firstSummary.unclaimed).toEqual([
      expect.objectContaining({ currency: first.currency, amount: '0.500000000000000000' }),
    ]);
    expect(secondSummary.unclaimed).toEqual([
      expect.objectContaining({ currency: second.currency, amount: '1.000000000000000000' }),
    ]);
  });

  it('claiming without a session is rejected as unauthorized', async () => {
    const bettor = await bettorWithAccrual(e2e, '10');

    const res = await e2e.app.app.request('/promo/rakeback/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: randomUUID() }),
    });

    expect(res.status).toBe(401);
    expect((await accrualsOf(e2e, bettor.userId))[0]?.status).toBe('accrued');
    expect(await cashbackRows(e2e, bettor.userId)).toEqual([]);
  });
});

describe('instant rakeback', () => {
  let e2e: WalletE2e;

  beforeAll(async () => {
    e2e = await bootWalletE2e();
    await configureLadder(e2e);
  }, 120_000);

  afterAll(() => closeWalletE2e(e2e));

  it('an instant-mode accrual is credited to the wallet immediately and creates no claim', async () => {
    const bettor = await fundedBettor(e2e, '50');

    await wager(e2e, bettor, '10');

    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe('40.500000000000000000');
    const rows = await cashbackRows(e2e, bettor.userId);
    expect(rows).toEqual([
      expect.objectContaining({ direction: 'credit', amount: '0.500000000000000000' }),
    ]);
    expect(await accrualsOf(e2e, bettor.userId)).toEqual([]);
    expect(
      await dbOf(e2e)
        .select()
        .from(promoRakebackClaim)
        .where(eq(promoRakebackClaim.userId, bettor.userId)),
    ).toEqual([]);
    expect(await summaryOf(bettor.client)).toMatchObject({
      unclaimed: [],
      claimBlockedBy: 'nothing_to_claim',
    });
    expect((await claimWith(bettor.client)).status).toBe(409);
  });
});

describe('admin rakeback', () => {
  let e2e: WalletE2e;

  beforeAll(async () => {
    e2e = await bootWalletE2e([claimModePlugin]);
    await configureLadder(e2e);
  }, 120_000);

  afterAll(() => closeWalletE2e(e2e));

  it('an admin lists accruals and reads a player summary', async () => {
    const bettor = await bettorWithAccrual(e2e, '10');
    await wager(e2e, bettor, '20');

    const listed = await e2e.admin.get(
      `/backoffice/promo/rakeback/accruals?userId=${bettor.userId}`,
    );
    const summary = await e2e.admin.get(`/backoffice/promo/rakeback/players/${bettor.userId}`);

    expect(listed.status).toBe(200);
    const page = AccrualPageSchema.parse(await bodyOf(listed));
    expect(page.total).toBe(2);
    expect(page.items.map((item) => item.amount).sort()).toEqual([
      '0.500000000000000000',
      '1.000000000000000000',
    ]);
    for (const item of page.items) {
      expect(item).toMatchObject({
        userId: bettor.userId,
        status: 'accrued',
        currency: bettor.currency,
      });
    }
    expect(summary.status).toBe(200);
    expect(PlayerSummarySchema.parse(await bodyOf(summary))).toMatchObject({
      userId: bettor.userId,
      unclaimed: [{ currency: bettor.currency, amount: '1.500000000000000000' }],
      lifetimeClaimed: [],
    });
  });

  it('an admin voids an unclaimed accrual and the void is audited', async () => {
    const bettor = await bettorWithAccrual(e2e, '10');
    const [accrual] = await accrualsOf(e2e, bettor.userId);
    if (!accrual) {
      throw new Error('accrual missing');
    }

    const res = await e2e.admin.post(`/backoffice/promo/rakeback/accruals/${accrual.id}/void`, {
      accrualId: accrual.id,
      reason: 'duplicate promo',
    });

    expect(res.status).toBe(200);
    expect(AccrualSchema.parse(await bodyOf(res))).toMatchObject({
      id: accrual.id,
      status: 'voided',
      voidReason: 'duplicate promo',
    });
    await flushAudit(e2e.app);
    const audits = await dbOf(e2e)
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'promo.rakeback.voided'), eq(auditLog.resourceId, accrual.id)),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.after).toMatchObject({
      status: 'voided',
      userId: bettor.userId,
      amount: '0.500000000000000000',
      reason: 'duplicate promo',
    });
    expect((await summaryOf(bettor.client)).unclaimed).toEqual([]);
    expect((await claimWith(bettor.client)).status).toBe(409);
    expect(await cashbackRows(e2e, bettor.userId)).toEqual([]);
  });

  it('voiding an accrual that is already claimed is refused with a conflict', async () => {
    const bettor = await bettorWithAccrual(e2e, '10');
    const [accrual] = await accrualsOf(e2e, bettor.userId);
    if (!accrual) {
      throw new Error('accrual missing');
    }
    expect((await claimWith(bettor.client)).status).toBe(200);

    const res = await e2e.admin.post(`/backoffice/promo/rakeback/accruals/${accrual.id}/void`, {
      accrualId: accrual.id,
      reason: 'too late',
    });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('CONFLICT');
    expect((await accrualsOf(e2e, bettor.userId))[0]?.status).toBe('claimed');
  });

  it('voiding an unknown accrual returns not found', async () => {
    const unknown = randomUUID();

    const res = await e2e.admin.post(`/backoffice/promo/rakeback/accruals/${unknown}/void`, {
      accrualId: unknown,
      reason: 'does not exist',
    });

    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe('NOT_FOUND');
  });

  it('the liability read totals unclaimed accruals per currency', async () => {
    const first = await bettorWithAccrual(e2e, '10');
    await wager(e2e, first, '20');
    const second = await bettorWithAccrual(e2e, '20');
    const claimed = await bettorWithAccrual(e2e, '10');
    expect((await claimWith(claimed.client)).status).toBe(200);

    const res = await e2e.admin.get('/backoffice/promo/rakeback/liability');

    expect(res.status).toBe(200);
    const liability = LiabilitySchema.parse(await bodyOf(res));
    const entry = (currency: string) =>
      liability.unclaimed.find((item) => item.currency === currency)?.amount;
    expect(entry(first.currency)).toBe('1.500000000000000000');
    expect(entry(second.currency)).toBe('1.000000000000000000');
    expect(entry(claimed.currency)).toBeUndefined();
  });

  it('a non-admin calling any admin rakeback route is refused as forbidden', async () => {
    const bettor = await bettorWithAccrual(e2e, '10');
    const [accrual] = await accrualsOf(e2e, bettor.userId);
    if (!accrual) {
      throw new Error('accrual missing');
    }
    const readOnly = (await newStaff(e2e.app, 'rakeback-readonly', 'admin')).client;
    const outsider = (await newPlayer(e2e.app, 'rakeback-outsider')).client;

    const reads = [
      '/backoffice/promo/rakeback/accruals',
      `/backoffice/promo/rakeback/players/${bettor.userId}`,
      '/backoffice/promo/rakeback/liability',
    ];
    const voidBody = { accrualId: accrual.id, reason: 'not allowed' };
    const voidPath = `/backoffice/promo/rakeback/accruals/${accrual.id}/void`;

    for (const path of reads) {
      expect((await outsider.get(path)).status).toBe(403);
    }
    expect((await outsider.post(voidPath, voidBody)).status).toBe(403);
    expect((await readOnly.post(voidPath, voidBody)).status).toBe(403);
    expect((await accrualsOf(e2e, bettor.userId))[0]?.status).toBe('accrued');
  });
});
