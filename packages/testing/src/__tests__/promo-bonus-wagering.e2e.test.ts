import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { BONUS_GRANTS, WALLET_COMMANDS } from '@openora/core/contracts';
import type {
  WalletCreditArgs,
  WalletDebitArgs,
  WalletDebitOutcome,
} from '@openora/core/contracts';
import { wallet, walletBalance, walletTransaction } from '@openora/core/wallet/schema';
import {
  promoGrant,
  promoGrantEntry,
  promoWeight,
  promoWeightProfile,
} from '@openora/core/promo/schema/bonus';
import {
  setupTestDb,
  bootTestApp,
  seedMinimal,
  registerAndMaterializePlayer,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let weightProfileId: string;

const CASINO = { provider: 'aggregator', product: 'casino' } as const;
const BETS_WITHIN_POOL = 8;

const drizzle = () => app.container.get(DRIZZLE).db;

async function player(realBalance: string) {
  const { client, userId } = await registerAndMaterializePlayer(app, {
    email: `wagering-${randomUUID()}@example.test`,
  });
  if (realBalance === '0') {
    await openEmptyWallet(userId);
  } else {
    await deposit(client, realBalance);
  }
  return { client, userId };
}

async function openEmptyWallet(userId: string) {
  const [row] = await drizzle().insert(wallet).values({ userId, currency: 'USD' }).returning();
  if (!row) {
    throw new Error('openEmptyWallet: wallet insert returned no row');
  }
  await drizzle().insert(walletBalance).values({ walletId: row.id, currency: 'USD', amount: '0' });
}

async function deposit(client: TestClient, amount: string, currency = 'USD') {
  const res = await client.post('/wallet/deposit', {
    amount,
    currency,
    idempotencyKey: randomUUID(),
  });
  if (res.status !== 200) {
    throw new Error(`deposit failed (${res.status}): ${await res.text()}`);
  }
}

async function grantBonus(userId: string, amount: string, multiplier: string, currency = 'USD') {
  const outcome = await drizzle().transaction((tx) =>
    app.container.get(BONUS_GRANTS).grant(tx, {
      userId,
      currency,
      amount,
      source: 'deposit',
      sourceRef: randomUUID(),
      actor: { type: 'system' },
      terms: { wageringMultiplier: multiplier, expiryDays: 30, weightProfileId },
    }),
  );
  if (!outcome.ok) {
    throw new Error('grantBonus: grant was refused');
  }
  return outcome.grantId;
}

const debit = (args: WalletDebitArgs): Promise<WalletDebitOutcome> =>
  drizzle().transaction((tx) => app.container.get(WALLET_COMMANDS).debit(tx, args));

const credit = (args: WalletCreditArgs) =>
  drizzle().transaction((tx) => app.container.get(WALLET_COMMANDS).credit(tx, args));

const bet = (userId: string, amount: string, round: string) =>
  debit({
    userId,
    amount,
    type: 'bet',
    currency: 'USD',
    context: CASINO,
    providerRef: {
      providerName: 'aggregator',
      providerRefId: `bet-${round}`,
      externalRoundId: round,
    },
  });

const reverse = (userId: string, amount: string, round: string, ref: string) =>
  credit({
    userId,
    amount,
    currency: 'USD',
    type: 'bet_reversal',
    providerRef: {
      providerName: 'aggregator',
      providerRefId: `${ref}-${round}`,
      externalRoundId: round,
    },
  });

async function grantRow(id: string) {
  const [row] = await drizzle().select().from(promoGrant).where(eq(promoGrant.id, id));
  if (!row) {
    throw new Error('grantRow: query returned no row');
  }
  return row;
}

async function realBalanceOf(userId: string) {
  const [row] = await drizzle()
    .select({ amount: walletBalance.amount })
    .from(walletBalance)
    .innerJoin(
      sql`wallet`,
      sql`wallet.id = ${walletBalance.walletId} and wallet.user_id = ${userId}`,
    );
  return row?.amount ?? '0';
}

const stakeEntries = (grantId: string) =>
  drizzle()
    .select()
    .from(promoGrantEntry)
    .where(and(eq(promoGrantEntry.grantId, grantId), eq(promoGrantEntry.type, 'stake')));

async function ledgerSum(grantId: string) {
  const [row] = await drizzle()
    .select({ total: sql<string>`coalesce(sum(${promoGrantEntry.bonusAmount}), 0)::text` })
    .from(promoGrantEntry)
    .where(eq(promoGrantEntry.grantId, grantId));
  return row?.total ?? '0';
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.dispose();
});

beforeEach(async () => {
  const [profile] = await drizzle()
    .insert(promoWeightProfile)
    .values({ name: `profile-${randomUUID()}` })
    .returning();
  if (!profile) {
    throw new Error('seed profile: query returned no row');
  }
  weightProfileId = profile.id;
  await drizzle().insert(promoWeight).values({
    profileId: weightProfileId,
    scope: 'product',
    scopeRef: 'casino',
    contributionPercent: '100',
  });
});

describe('a bet against a bonus', () => {
  it('takes the real balance first and the bonus only for what it could not cover', async () => {
    const { userId } = await player('30');
    const grantId = await grantBonus(userId, '100', '10');

    const outcome = await bet(userId, '50', randomUUID());

    expect(outcome).toMatchObject({ ok: true, bonusSpent: '20.000000000000000000' });
    expect(await realBalanceOf(userId)).toBe('0.000000000000000000');
    expect((await grantRow(grantId)).bonusBalance).toBe('80.000000000000000000');
  });

  it('leaves the bonus untouched when the real balance covers the stake', async () => {
    const { userId } = await player('100');
    const grantId = await grantBonus(userId, '100', '10');

    await bet(userId, '40', randomUUID());

    expect(await realBalanceOf(userId)).toBe('60.000000000000000000');
    expect((await grantRow(grantId)).bonusBalance).toBe('100.000000000000000000');
  });

  it('advances wagering by the weighted stake, whichever balance paid', async () => {
    const { userId } = await player('100');
    const grantId = await grantBonus(userId, '100', '10');

    await bet(userId, '40', randomUUID());

    expect((await grantRow(grantId)).wageringProgress).toBe('40.000000000000000000');
  });

  it('refuses a stake neither balance can cover and moves nothing', async () => {
    const { userId } = await player('10');
    const grantId = await grantBonus(userId, '20', '10');

    const outcome = await bet(userId, '100', randomUUID());

    expect(outcome).toMatchObject({ ok: false });
    expect(await realBalanceOf(userId)).toBe('10.000000000000000000');
    expect((await grantRow(grantId)).bonusBalance).toBe('20.000000000000000000');
  });

  it('does not touch a grant held in another currency', async () => {
    const { userId } = await player('0');
    const grantId = await grantBonus(userId, '100', '10', 'EUR');

    const outcome = await bet(userId, '10', randomUUID());

    expect(outcome).toMatchObject({ ok: false });
    expect((await grantRow(grantId)).bonusBalance).toBe('100.000000000000000000');
  });

  it('scores a bet the profile does not weight at zero', async () => {
    const { userId } = await player('100');
    const grantId = await grantBonus(userId, '100', '10');

    await debit({
      userId,
      amount: '40',
      type: 'bet',
      currency: 'USD',
      context: { provider: 'aggregator', product: 'pvp' },
      providerRef: {
        providerName: 'aggregator',
        providerRefId: randomUUID(),
        externalRoundId: randomUUID(),
      },
    });

    expect((await grantRow(grantId)).wageringProgress).toBe('0.000000000000000000');
  });

  it('draws no bonus funds and earns no progress for a bet with no round id', async () => {
    const { userId } = await player('10');
    const grantId = await grantBonus(userId, '100', '10');

    const outcome = await debit({
      userId,
      amount: '40',
      type: 'bet',
      currency: 'USD',
      context: CASINO,
      providerRef: { providerName: 'aggregator', providerRefId: randomUUID() },
    });

    // A bet without a round id can never be found again to settle its win or reversal, so it is
    // refused the moment the real balance alone cannot cover it - the normal insufficient-funds
    // outcome, not a bonus-funded one.
    expect(outcome).toMatchObject({ ok: false, available: '10.000000000000000000' });
    expect(await realBalanceOf(userId)).toBe('10.000000000000000000');
    const row = await grantRow(grantId);
    expect(row.bonusBalance).toBe('100.000000000000000000');
    expect(row.wageringProgress).toBe('0.000000000000000000');
  });
});

describe('a replayed wager', () => {
  it('buys no second contribution and spends no second time', async () => {
    const { userId } = await player('0');
    const grantId = await grantBonus(userId, '100', '10');
    const round = randomUUID();

    await bet(userId, '40', round);
    await bet(userId, '40', round);

    const row = await grantRow(grantId);
    expect(row.bonusBalance).toBe('60.000000000000000000');
    expect(row.wageringProgress).toBe('40.000000000000000000');
    expect(await stakeEntries(grantId)).toHaveLength(1);
  });

  it('buys no second contribution when the replay races the original, not just follows it', async () => {
    const { userId } = await player('0');
    const grantId = await grantBonus(userId, '100', '10');
    const round = randomUUID();

    // The wallet's duplicate-provider-reference guard has to hold under real concurrency, not
    // only when the second call is known to start after the first has committed - the unique
    // index is the guard here, not the read that precedes it.
    await Promise.all([bet(userId, '40', round), bet(userId, '40', round)]);

    const row = await grantRow(grantId);
    expect(row.bonusBalance).toBe('60.000000000000000000');
    expect(row.wageringProgress).toBe('40.000000000000000000');
    expect(await stakeEntries(grantId)).toHaveLength(1);
  });
});

describe('the transaction boundary', () => {
  it('rolls the contribution back with the debit when the caller fails', async () => {
    const { userId } = await player('100');
    const grantId = await grantBonus(userId, '100', '10');

    await expect(
      drizzle().transaction(async (tx) => {
        await app.container.get(WALLET_COMMANDS).debit(tx, {
          userId,
          amount: '40',
          type: 'bet',
          currency: 'USD',
          context: CASINO,
          providerRef: {
            providerName: 'aggregator',
            providerRefId: `bet-${randomUUID()}`,
            externalRoundId: randomUUID(),
          },
        });
        throw new Error('caller failed after the debit');
      }),
    ).rejects.toThrow('caller failed after the debit');

    expect(await realBalanceOf(userId)).toBe('100.000000000000000000');
    expect((await grantRow(grantId)).wageringProgress).toBe('0.000000000000000000');
    expect(await stakeEntries(grantId)).toHaveLength(0);
  });
});

describe('concurrent bets against one grant', () => {
  it('never overdraws the bonus and the ledger still explains the balance', async () => {
    const { userId } = await player('0');
    const grantId = await grantBonus(userId, '40', '100');

    const outcomes = await Promise.all(
      Array.from({ length: BETS_WITHIN_POOL }, () => bet(userId, '10', randomUUID())),
    );

    const row = await grantRow(grantId);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(4);
    expect(row.bonusBalance).toBe('0.000000000000000000');
    expect(await ledgerSum(grantId)).toBe(row.bonusBalance);
  }, 30_000);
});

describe('meeting the requirement', () => {
  it('converts what is left to the real balance and closes the grant', async () => {
    const { userId } = await player('200');
    const grantId = await grantBonus(userId, '100', '1');

    await bet(userId, '100', randomUUID());

    const row = await grantRow(grantId);
    expect(row.status).toBe('completed');
    expect(row.bonusBalance).toBe('0.000000000000000000');
    expect(row.closedAt).toBeInstanceOf(Date);
    expect(await realBalanceOf(userId)).toBe('200.000000000000000000');
    const bonusRows = await drizzle()
      .select()
      .from(walletTransaction)
      .where(eq(walletTransaction.type, 'bonus'));
    expect(bonusRows).toHaveLength(1);
  });

  it('caps progress at the requirement rather than overshooting it', async () => {
    const { userId } = await player('500');
    const grantId = await grantBonus(userId, '100', '1');

    await bet(userId, '400', randomUUID());

    expect((await grantRow(grantId)).wageringProgress).toBe('100.000000000000000000');
  });

  it('takes no further progress once the grant has completed', async () => {
    const { userId } = await player('500');
    const grantId = await grantBonus(userId, '100', '1');
    await bet(userId, '100', randomUUID());

    await bet(userId, '50', randomUUID());

    expect((await grantRow(grantId)).wageringProgress).toBe('100.000000000000000000');
  });
});

describe('a win on a bonus-funded round', () => {
  it('splits back in the same proportion the stake was paid in', async () => {
    const { userId } = await player('50');
    const grantId = await grantBonus(userId, '100', '100');
    const round = randomUUID();
    await bet(userId, '100', round);

    await credit({
      userId,
      amount: '200',
      currency: 'USD',
      type: 'win',
      providerRef: {
        providerName: 'aggregator',
        providerRefId: `win-${round}`,
        externalRoundId: round,
      },
    });

    expect((await grantRow(grantId)).bonusBalance).toBe('150.000000000000000000');
    expect(await realBalanceOf(userId)).toBe('100.000000000000000000');
  });

  it('credits the real balance in full when the round drew no bonus funds', async () => {
    const { userId } = await player('100');
    const grantId = await grantBonus(userId, '100', '100');
    const round = randomUUID();
    await bet(userId, '40', round);

    await credit({
      userId,
      amount: '80',
      currency: 'USD',
      type: 'win',
      providerRef: {
        providerName: 'aggregator',
        providerRefId: `win-${round}`,
        externalRoundId: round,
      },
    });

    expect((await grantRow(grantId)).bonusBalance).toBe('100.000000000000000000');
    expect(await realBalanceOf(userId)).toBe('140.000000000000000000');
  });

  it('settles only the stake its own provider took, not another provider reusing the same round id', async () => {
    const { userId } = await player('30');
    const grantId = await grantBonus(userId, '100', '10');
    const round = randomUUID();

    // Two different providers minting the same round id independently. Provider A's stake is
    // part cash, part bonus; provider B's is bonus only - chosen so a settlement that wrongly
    // pooled the two would produce a different split than one scoped to A alone.
    await bet(userId, '40', round); // provider 'aggregator': 30 real, 10 bonus
    await debit({
      userId,
      amount: '20',
      type: 'bet',
      currency: 'USD',
      context: CASINO,
      providerRef: {
        providerName: 'other-aggregator',
        providerRefId: `bet-other-${round}`,
        externalRoundId: round,
      },
    });

    await credit({
      userId,
      amount: '100',
      currency: 'USD',
      type: 'win',
      providerRef: {
        providerName: 'aggregator',
        providerRefId: `win-${round}`,
        externalRoundId: round,
      },
    });

    // Scoped to provider A's 30 real / 10 bonus stake alone: a quarter of the win is bonus.
    expect((await grantRow(grantId)).bonusBalance).toBe('95.000000000000000000');
    expect(await realBalanceOf(userId)).toBe('75.000000000000000000');
  });

  it('pays neither balance when the funding grant expired before the win arrived', async () => {
    const { userId } = await player('0');
    const grantId = await grantBonus(userId, '100', '10');
    const round = randomUUID();
    await bet(userId, '40', round);
    await drizzle().update(promoGrant).set({ status: 'expired' }).where(eq(promoGrant.id, grantId));

    await credit({
      userId,
      amount: '80',
      currency: 'USD',
      type: 'win',
      providerRef: {
        providerName: 'aggregator',
        providerRefId: `win-${round}`,
        externalRoundId: round,
      },
    });

    // Question 8's default: an expiry takes the winnings from that bonus along with the bonus
    // balance. Neither balance grows - the money is not the player's to have. (This test flips
    // the status directly rather than through an expiry sweep, which is a later PR in the
    // stack; the bonus balance a real sweep would already have zeroed is incidental here.)
    expect((await grantRow(grantId)).bonusBalance).toBe('60.000000000000000000');
    expect(await realBalanceOf(userId)).toBe('0.000000000000000000');
  });

  it('pays neither balance when the funding grant was forfeited before the win arrived', async () => {
    const { userId } = await player('0');
    const grantId = await grantBonus(userId, '100', '10');
    const round = randomUUID();
    await bet(userId, '40', round);
    await drizzle()
      .update(promoGrant)
      .set({ status: 'forfeited', forfeitReason: 'admin' })
      .where(eq(promoGrant.id, grantId));

    await credit({
      userId,
      amount: '80',
      currency: 'USD',
      type: 'win',
      providerRef: {
        providerName: 'aggregator',
        providerRefId: `win-${round}`,
        externalRoundId: round,
      },
    });

    expect((await grantRow(grantId)).bonusBalance).toBe('60.000000000000000000');
    expect(await realBalanceOf(userId)).toBe('0.000000000000000000');
  });
});

describe('a voided round', () => {
  it('is reversed once, however many times the provider reports it', async () => {
    const { userId } = await player('0');
    const grantId = await grantBonus(userId, '100', '10');
    const round = randomUUID();
    await bet(userId, '40', round);

    await reverse(userId, '40', round, 'void-a');
    await reverse(userId, '40', round, 'void-b');

    const row = await grantRow(grantId);
    expect(row.bonusBalance).toBe('100.000000000000000000');
    expect(row.wageringProgress).toBe('0.000000000000000000');
    // The stake came out of the bonus, so the second callback must put nothing in the real
    // balance: cash here is an un-wagered bonus the player could withdraw straight away.
    expect(await realBalanceOf(userId)).toBe('0.000000000000000000');
    expect(await ledgerSum(grantId)).toBe(row.bonusBalance);
  });

  it('returns a stake voided in two parts once in total, not once per callback', async () => {
    const { userId } = await player('0');
    const grantId = await grantBonus(userId, '100', '10');
    const round = randomUUID();
    await bet(userId, '40', round);

    await reverse(userId, '25', round, 'void-a');
    await reverse(userId, '15', round, 'void-b');

    const row = await grantRow(grantId);
    expect(row.bonusBalance).toBe('100.000000000000000000');
    expect(await realBalanceOf(userId)).toBe('0.000000000000000000');
    expect(await ledgerSum(grantId)).toBe(row.bonusBalance);
  });

  it('gives back the stake once when two reversal callbacks for the same round race each other', async () => {
    const { userId } = await player('0');
    const grantId = await grantBonus(userId, '100', '10');
    const round = randomUUID();
    await bet(userId, '40', round);

    // Different provider references, so the wallet's own duplicate-reference guard does not
    // catch this: only the round-level settlement lock does. Without it, both callbacks read the
    // same outstanding stake and both give it back, refunding the bonus twice.
    await Promise.all([
      reverse(userId, '40', round, 'void-a'),
      reverse(userId, '40', round, 'void-b'),
    ]);

    const row = await grantRow(grantId);
    expect(row.bonusBalance).toBe('100.000000000000000000');
    expect(row.wageringProgress).toBe('0.000000000000000000');
    expect(await realBalanceOf(userId)).toBe('0.000000000000000000');
    expect(await ledgerSum(grantId)).toBe(row.bonusBalance);
  });

  it('takes back only the progress the returned part of the stake bought', async () => {
    const { userId } = await player('0');
    const grantId = await grantBonus(userId, '100', '10');
    const round = randomUUID();
    await bet(userId, '40', round);

    await reverse(userId, '10', round, 'partial');

    const row = await grantRow(grantId);
    expect(row.bonusBalance).toBe('70.000000000000000000');
    expect(row.wageringProgress).toBe('30.000000000000000000');
  });

  it('takes back the progress a cash-funded bet bought under an active grant when it is voided', async () => {
    const { userId } = await player('40');
    const grantId = await grantBonus(userId, '100', '10');
    const round = randomUUID();

    // The real balance covers this stake in full; no bonus funds are spent, but the grant still
    // counts the full stake toward its requirement.
    await bet(userId, '40', round);
    expect(await realBalanceOf(userId)).toBe('0.000000000000000000');
    expect((await grantRow(grantId)).wageringProgress).toBe('40.000000000000000000');

    await reverse(userId, '40', round, 'void-cash');

    const row = await grantRow(grantId);
    expect(row.bonusBalance).toBe('100.000000000000000000');
    expect(row.wageringProgress).toBe('0.000000000000000000');
    expect(await realBalanceOf(userId)).toBe('40.000000000000000000');
  });

  it("returns a completed grant's voided stake as cash, not to a bonus balance that already converted", async () => {
    const { userId } = await player('0');
    const grantId = await grantBonus(userId, '100', '0.4');
    const round = randomUUID();
    // Meets the requirement in one bet: the remaining $60 converts to real cash immediately.
    await bet(userId, '40', round);
    expect(await realBalanceOf(userId)).toBe('60.000000000000000000');

    await reverse(userId, '40', round, 'after-completion');

    const row = await grantRow(grantId);
    expect(row.status).toBe('completed');
    expect(row.bonusBalance).toBe('0.000000000000000000');
    // The voided stake's value already became real money at completion; a routine provider void
    // for that same round returns it as cash too, the same as it would for a plain cash bet.
    expect(await realBalanceOf(userId)).toBe('100.000000000000000000');
  });

  it('withholds a voided stake from both balances when its grant expired or was forfeited first', async () => {
    const { userId } = await player('0');
    const grantId = await grantBonus(userId, '100', '10');
    const round = randomUUID();
    await bet(userId, '40', round);

    // Flips the status directly rather than through a forfeiture sweep, which is a later PR in
    // the stack; same pattern as the win-side "pays neither balance" tests above.
    await drizzle()
      .update(promoGrant)
      .set({ status: 'forfeited', forfeitReason: 'admin' })
      .where(eq(promoGrant.id, grantId));

    await reverse(userId, '40', round, 'after-forfeiture');

    const row = await grantRow(grantId);
    expect(row.bonusBalance).toBe('60.000000000000000000');
    // Neither balance receives it: the bonus was already taken away, and crediting it as cash
    // would let a void cash out a forfeited bonus.
    expect(await realBalanceOf(userId)).toBe('0.000000000000000000');
    const [forfeitEntry] = await drizzle()
      .select()
      .from(promoGrantEntry)
      .where(and(eq(promoGrantEntry.grantId, grantId), eq(promoGrantEntry.type, 'forfeit')));
    expect(forfeitEntry?.realAmount).toBe('40.000000000000000000');
  });

  it('pays a win to the real balance when the funding grant already converted', async () => {
    const { userId } = await player('200');
    const grantId = await grantBonus(userId, '100', '1');
    const round = randomUUID();
    await bet(userId, '100', round);
    expect((await grantRow(grantId)).status).toBe('completed');

    await credit({
      userId,
      amount: '50',
      currency: 'USD',
      type: 'win',
      providerRef: {
        providerName: 'aggregator',
        providerRefId: `win-${round}`,
        externalRoundId: round,
      },
    });

    expect(await realBalanceOf(userId)).toBe('250.000000000000000000');
  });

  it('returns the bonus stake and takes back the progress it bought', async () => {
    const { userId } = await player('0');
    const grantId = await grantBonus(userId, '100', '10');
    const round = randomUUID();
    await bet(userId, '40', round);

    await credit({
      userId,
      amount: '40',
      currency: 'USD',
      type: 'bet_reversal',
      providerRef: {
        providerName: 'aggregator',
        providerRefId: `void-${round}`,
        externalRoundId: round,
      },
    });

    const row = await grantRow(grantId);
    expect(row.bonusBalance).toBe('100.000000000000000000');
    expect(row.wageringProgress).toBe('0.000000000000000000');
    expect(await realBalanceOf(userId)).toBe('0.000000000000000000');
  });
});
