import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, eventOutbox, moneyAdd, moneyCompare } from '@openora/core/server';
import {
  BONUS_GRANTS,
  EXCHANGE_RATE_READER,
  WALLET_COMMANDS,
  type SportsbookBetResult,
  type WagerProduct,
} from '@openora/core/contracts';
import { exchangeRateQuote } from '@openora/core/fx/schema/exchange-rate';
import { promoGrant, promoWeight, promoWeightProfile } from '@openora/core/promo/schema/bonus';
import { user } from '@openora/core/pam/schema/identity';
import { adminRole, adminRoleAssignment } from '@openora/core/iam/schema';
import { walletTransaction } from '@openora/core/wallet/schema';
import {
  closeE2e,
  readJson,
  registerAndMaterializePlayer,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';
import {
  PROVIDER,
  acceptedBet,
  bootSportsbookApp,
  enableSportsbook,
  expectApplied,
  fundedPlayer,
  ledgerOf,
  txId,
  type SportsbookPlayer,
} from './fixtures/sportsbook.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let adminUserId: string;

const drizzle = () => app.container.get(DRIZZLE).db;
const commands = () => app.container.get(WALLET_COMMANDS);

const expectMoney = (actual: unknown, expected: string, label: string) =>
  expect(moneyCompare(String(actual), expected) === 0, `${label}: ${String(actual)}`).toBe(true);

async function summaryOf(client: TestClient) {
  const res = await client.get('/wallet/turnover');
  expect(res.status).toBe(200);
  return readJson(res);
}

const progressOf = async (client: TestClient) => String((await summaryOf(client)).progress);

const metEvents = (userId: string) =>
  drizzle()
    .select()
    .from(eventOutbox)
    .where(
      and(
        eq(eventOutbox.topic, 'wallet.turnover.met'),
        sql`${eventOutbox.payload}->>'userId' = ${userId}`,
      ),
    );

const ledgerRow = async (id: string) => {
  const [row] = await drizzle()
    .select()
    .from(walletTransaction)
    .where(eq(walletTransaction.id, id));
  if (!row) {
    throw new Error('ledger row missing');
  }
  return row;
};

async function bet(
  userId: string,
  amount: string,
  {
    product = 'casino',
    currency = 'USD',
    round = randomUUID(),
    refId = randomUUID(),
  }: { product?: WagerProduct; currency?: string; round?: string; refId?: string } = {},
) {
  const outcome = await drizzle().transaction((tx) =>
    commands().debit(tx, {
      userId,
      amount,
      currency,
      type: 'bet',
      context: { provider: 'aggregator', product },
      providerRef: { providerName: 'aggregator', providerRefId: refId, externalRoundId: round },
    }),
  );
  if (!outcome.ok || !outcome.moved) {
    throw new Error(`bet did not move: ${JSON.stringify(outcome)}`);
  }
  return { id: outcome.transactionId, round, refId };
}

const reverse = (
  userId: string,
  amount: string,
  round: string,
  reversesTransactionId?: string,
  refId = randomUUID(),
) =>
  drizzle().transaction((tx) =>
    commands().credit(tx, {
      userId,
      amount,
      currency: 'USD',
      type: 'bet_reversal',
      ...(reversesTransactionId === undefined ? {} : { reversesTransactionId }),
      providerRef: { providerName: 'aggregator', providerRefId: refId, externalRoundId: round },
    }),
  );

const settle = (providerBetId: string, result: SportsbookBetResult, payout: string) =>
  ledgerOf(app)
    .settle({ provider: PROVIDER, providerTxId: txId(), providerBetId, result, payout })
    .then(expectApplied);

const reopen = (providerBetId: string) =>
  ledgerOf(app)
    .reopen({ provider: PROVIDER, providerTxId: txId(), providerBetId })
    .then(expectApplied);

const stake = (player: SportsbookPlayer, amount = '50') =>
  acceptedBet(app, player, { stake: amount, potentialPayout: '200' });

beforeAll(async () => {
  ({ db, app } = await bootSportsbookApp({
    fixtures: [
      { id: 'testing-wallet-turnover-config', file: 'test-wallet-turnover-config-plugin.ts' },
    ],
  }));
  const registered = await registerAndMaterializePlayer(app, {
    email: `turnover-stakes-admin-${randomUUID()}@e2e.test`,
  });
  await drizzle().update(user).set({ role: 'admin' }).where(eq(user.id, registered.userId));
  const [role] = await drizzle().select().from(adminRole).where(eq(adminRole.key, 'super-admin'));
  if (!role) {
    throw new Error('no seeded super-admin role');
  }
  await drizzle()
    .insert(adminRoleAssignment)
    .values({ userId: registered.userId, roleId: role.id })
    .onConflictDoNothing();
  admin = registered.client;
  adminUserId = registered.userId;
  await enableSportsbook(app, {}, admin);
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('casino stakes', () => {
  it('meets a deposit requirement with casino and live-casino bets and emits met once', async () => {
    const player = await fundedPlayer(app, '100');

    const casino = await bet(player.userId, '60');
    const live = await bet(player.userId, '40', { product: 'live-casino' });

    const summary = await summaryOf(player.client);
    expectMoney(summary.progress, '100', 'progress');
    expectMoney(summary.remaining, '0', 'remaining');
    expect(summary.locked).toBe(false);
    expect(await metEvents(player.userId)).toHaveLength(1);
    expectMoney((await ledgerRow(casino.id)).turnoverContribution, '60', 'casino stamp');
    expectMoney((await ledgerRow(live.id)).turnoverContribution, '40', 'live stamp');

    await deposit(player.client, '10');
    const extra = await bet(player.userId, '5');
    expect(await ledgerRow(extra.id)).toMatchObject({ turnoverState: 'counted' });
    expectMoney(await progressOf(player.client), '105', 'after the next requirement');
  });

  it('stamps nothing on a bet once the requirement is met', async () => {
    const player = await fundedPlayer(app, '100');
    await bet(player.userId, '100');

    const extra = await bet(player.userId, '1');

    expect(await ledgerRow(extra.id)).toMatchObject({
      turnoverContribution: null,
      turnoverState: null,
    });
    expectMoney(await progressOf(player.client), '100', 'progress');
    expect(await metEvents(player.userId)).toHaveLength(1);
  });

  it('takes back a reversed bet once, pro rata for a partial reversal, and by the round share when unnamed', async () => {
    const player = await fundedPlayer(app, '300');

    const full = await bet(player.userId, '100');
    expectMoney(await progressOf(player.client), '100', 'after the bet');
    const reversalRef = randomUUID();
    const reversed = await reverse(player.userId, '100', full.round, full.id, reversalRef);
    expectMoney(await progressOf(player.client), '0', 'after the reversal');

    const betReplay = await drizzle().transaction((tx) =>
      commands().debit(tx, {
        userId: player.userId,
        amount: '100',
        currency: 'USD',
        type: 'bet',
        context: { provider: 'aggregator', product: 'casino' },
        providerRef: {
          providerName: 'aggregator',
          providerRefId: full.refId,
          externalRoundId: full.round,
        },
      }),
    );
    const reversalReplay = await reverse(player.userId, '100', full.round, full.id, reversalRef);
    expect(betReplay).toMatchObject({ ok: true, moved: false, replayedTransactionId: full.id });
    expect(reversalReplay).toMatchObject({ ok: true, moved: false });
    expectMoney(await progressOf(player.client), '0', 'after the replays');
    expectMoney((await ledgerRow(full.id)).turnoverContribution, '100', 'bet stamp');
    if (!reversed.ok || !reversed.moved) {
      throw new Error('reversal did not move');
    }
    expect(await ledgerRow(reversed.transactionId)).toMatchObject({ turnoverState: 'reversal' });
    expectMoney((await ledgerRow(reversed.transactionId)).turnoverContribution, '100', 'stamp');

    const partial = await bet(player.userId, '80');
    await reverse(player.userId, '20', partial.round, partial.id);
    expectMoney(await progressOf(player.client), '60', 'after a partial reversal');

    const round = randomUUID();
    await bet(player.userId, '50', { round });
    await bet(player.userId, '50', { round, product: 'pvp' });
    expectMoney(await progressOf(player.client), '110', 'pvp adds nothing');
    await reverse(player.userId, '50', round);
    expectMoney(await progressOf(player.client), '85', 'half the round share');
    await reverse(player.userId, '50', round);
    expectMoney(await progressOf(player.client), '60', 'the round returned in full');
  });
});

describe('sportsbook stakes', () => {
  it('counts a stake at its final result, a void as nothing and a reopen once', async () => {
    const player = await fundedPlayer(app, '1000');

    await bet(player.userId, '50', { product: 'pvp' });
    expectMoney(await progressOf(player.client), '0', 'pvp');

    const won = await stake(player);
    expectMoney(await progressOf(player.client), '0', 'at placement');
    await settle(won.args.providerBetId, 'won', '100');
    expectMoney(await progressOf(player.client), '50', 'won');

    const lost = await stake(player);
    await settle(lost.args.providerBetId, 'lost', '0');
    expectMoney(await progressOf(player.client), '100', 'lost');

    const voided = await stake(player);
    await settle(voided.args.providerBetId, 'void', '50');
    expectMoney(await progressOf(player.client), '100', 'void');

    const resettled = await stake(player);
    await settle(resettled.args.providerBetId, 'won', '100');
    await reopen(resettled.args.providerBetId);
    await settle(resettled.args.providerBetId, 'won', '120');
    expectMoney(await progressOf(player.client), '150', 'reopened and settled again');

    const unwound = await stake(player);
    await settle(unwound.args.providerBetId, 'won', '100');
    expectMoney(await progressOf(player.client), '200', 'won before the reopen');
    await reopen(unwound.args.providerBetId);
    await settle(unwound.args.providerBetId, 'void', '50');
    expectMoney(await progressOf(player.client), '150', 'voided after the reopen');
  });

  it('counts a stake at the percent in force when it was placed', async () => {
    const player = await fundedPlayer(app, '1000');

    const before = await stake(player);
    const set = await admin.put('/wallet/admin/turnover-config', {
      productPercent: { sportsbook: 50 },
    });
    expect(set.status).toBe(200);
    try {
      const after = await stake(player);
      await settle(before.args.providerBetId, 'lost', '0');
      await settle(after.args.providerBetId, 'lost', '0');
    } finally {
      const reset = await admin.put('/wallet/admin/turnover-config', {
        productPercent: { sportsbook: null },
      });
      expect(reset.status).toBe(200);
    }

    expectMoney(await progressOf(player.client), '75', 'progress');
  });
});

describe('a stake in another currency', () => {
  it('counts at the rate in force when the bet was placed', async () => {
    const player = await fundedPlayer(app, '100000');
    await drizzle()
      .insert(exchangeRateQuote)
      .values({
        baseCurrency: 'BTC',
        quoteCurrency: 'USD',
        rate: '50000',
        providerAsOf: new Date(),
      })
      .onConflictDoNothing();
    const funded = await admin.post('/wallet/manual-adjustments', {
      userId: player.userId,
      direction: 'credit',
      amount: '0.01',
      currency: 'BTC',
      reason: 'turnover stake test funds',
      idempotencyKey: randomUUID(),
    });
    expect(funded.status).toBe(200);
    const progressBefore = await progressOf(player.client);
    const expected = await app.container.get(EXCHANGE_RATE_READER).convert('0.001', 'BTC', 'USD');
    if (expected === null) {
      throw new Error('no BTC rate');
    }

    const placed = await bet(player.userId, '0.001', { currency: 'BTC' });

    expectMoney((await ledgerRow(placed.id)).turnoverContribution, expected, 'stamp');
    const counted = await progressOf(player.client);
    expect(moneyCompare(counted, progressBefore)).toBe(1);
    await drizzle()
      .insert(exchangeRateQuote)
      .values({
        baseCurrency: 'BTC',
        quoteCurrency: 'USD',
        rate: '90000',
        providerAsOf: new Date(Date.now() + 60_000),
      })
      .onConflictDoNothing();
    expectMoney(await progressOf(player.client), counted, 'after the rate moved');
    expectMoney((await ledgerRow(placed.id)).turnoverContribution, expected, 'stamp kept');
  });
});

describe('a stake funded partly by a bonus', () => {
  it('advances the grant by the stake and turnover by the real part only', async () => {
    const player = await fundedPlayer(app, '100');
    const [profile] = await drizzle()
      .insert(promoWeightProfile)
      .values({ name: `profile-${randomUUID()}` })
      .returning();
    if (!profile) {
      throw new Error('seed profile: no row');
    }
    await drizzle().insert(promoWeight).values({
      profileId: profile.id,
      scope: 'product',
      scopeRef: 'casino',
      contributionPercent: '100',
    });
    const granted = await drizzle().transaction((tx) =>
      app.container.get(BONUS_GRANTS).grant(tx, {
        userId: player.userId,
        currency: 'USD',
        amount: '50',
        source: 'manual',
        sourceRef: randomUUID(),
        actor: { type: 'admin', id: adminUserId },
        buckets: { linked: '0', unlinked: '0' },
        terms: {
          wageringMultiplier: '5',
          expiryDays: 30,
          weightProfileId: profile.id,
          funds: {
            rolloverBase: 'bonus',
            existingBalance: 'free',
            freeFundsOrder: 'last',
            dustThresholdUsd: '0.01',
            decimals: 18,
          },
        },
      }),
    );
    if (!granted.ok) {
      throw new Error(`grant refused: ${granted.reason}`);
    }
    const grantProgress = async () => {
      const [row] = await drizzle()
        .select()
        .from(promoGrant)
        .where(eq(promoGrant.id, granted.grantId));
      return row?.wageringProgress;
    };
    const progressBefore = await progressOf(player.client);

    const bonusOnly = await bet(player.userId, '30');

    expect(await ledgerRow(bonusOnly.id)).toMatchObject({ turnoverContribution: null });
    expectMoney(await progressOf(player.client), progressBefore, 'bonus-only stake');
    expectMoney(await grantProgress(), '30', 'grant progress after the bonus-only stake');

    const mixed = await bet(player.userId, '40');

    expectMoney(await grantProgress(), '70', 'grant progress after the mixed stake');
    expect(await ledgerRow(mixed.id)).toMatchObject({ turnoverState: 'counted' });
    expectMoney((await ledgerRow(mixed.id)).realShare, '20', 'real part');
    expectMoney((await ledgerRow(mixed.id)).turnoverContribution, '20', 'contribution');
    expectMoney(
      await progressOf(player.client),
      moneyAdd(progressBefore, '20'),
      'turnover after the mixed stake',
    );
  });
});

async function deposit(client: TestClient, amount: string) {
  const res = await client.post('/wallet/deposit', {
    idempotencyKey: randomUUID(),
    amount,
    currency: 'USD',
  });
  expect(res.status).toBe(200);
}
