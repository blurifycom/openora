import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions, moneyCompare } from '@openora/core/server';
import {
  BONUS_GRANTS,
  WALLET_COMMANDS,
  type BonusFreeFundsOrder,
  type BonusGrantSource,
} from '@openora/core/contracts';
import { wallet, walletBalance, walletTransaction } from '@openora/core/wallet/schema';
import { promoGrant, promoWeight, promoWeightProfile } from '@openora/core/promo/schema/bonus';
import { user } from '@openora/core/pam/schema/identity';
import { adminRole, adminRoleAssignment } from '@openora/core/iam/schema';
import {
  bootE2e,
  closeE2e,
  readJson,
  registerAndMaterializePlayer,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../../index.js';

const CASINO = { provider: 'aggregator', product: 'casino' } as const;
const fixture = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export const expectMoney = (actual: string, expected: string, label: string) =>
  expect(moneyCompare(actual, expected) === 0, `${label}: ${actual}, expected ${expected}`).toBe(
    true,
  );

type GrantOptions = {
  source?: BonusGrantSource;
  currency?: string;
  amount?: string;
  linked?: string;
  unlinked?: string;
  multiplier?: string;
  lock?: boolean;
  order?: BonusFreeFundsOrder;
};

export function useBonusLockHarness(
  mode: 'block' | 'forfeit',
  { config, rates = true }: { config?: { id: string; file: string }; rates?: boolean } = {},
) {
  let db: TestDb;
  let app: TestApp;
  let admin: TestClient;
  let adminUserId: string;
  let weightProfileId: string;

  beforeAll(async () => {
    ({ db, app } = await bootE2e({
      plugins: [
        ...(await loadExtensions()),
        ...(config
          ? [{ id: config.id, path: fixture(config.file) }]
          : mode === 'block'
            ? [
                {
                  id: 'testing-bonus-withdrawal-block-config',
                  path: fixture('./test-bonus-withdrawal-block-config-plugin.ts'),
                },
              ]
            : []),
        { id: 'testing-swap-desk', path: fixture('../../test-swap-desk-plugin.ts') },
        ...(rates
          ? [
              {
                id: 'testing-exchange-rate-provider',
                path: fixture('../../test-exchange-rate-provider-plugin.ts'),
              },
            ]
          : []),
      ],
    }));
    const registered = await registerAndMaterializePlayer(app, {
      email: `bonus-lock-admin-${randomUUID()}@e2e.test`,
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
  }, 60_000);

  afterAll(async () => {
    await closeE2e({ app, db });
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

  const drizzle = () => app.container.get(DRIZZLE).db;
  const commands = () => app.container.get(WALLET_COMMANDS);

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

  async function player(cash: string, currency = 'USD') {
    const registered = await registerAndMaterializePlayer(app, {
      email: `bonus-lock-${randomUUID()}@e2e.test`,
    });
    await deposit(registered.client, cash, currency);
    return registered;
  }

  async function grant(
    userId: string,
    {
      source = 'deposit',
      currency = 'USD',
      amount = '100',
      linked = '100',
      unlinked = '0',
      multiplier = '5',
      lock,
      order = 'first',
    }: GrantOptions = {},
  ) {
    const outcome = await drizzle().transaction((tx) =>
      app.container.get(BONUS_GRANTS).grant(tx, {
        userId,
        currency,
        amount,
        source,
        sourceRef: randomUUID(),
        actor: source === 'manual' ? { type: 'admin', id: adminUserId } : { type: 'system' },
        buckets: { linked, unlinked },
        terms: {
          wageringMultiplier: multiplier,
          expiryDays: 30,
          weightProfileId,
          funds: {
            rolloverBase: 'bonus',
            existingBalance: 'free',
            freeFundsOrder: order,
            dustThresholdUsd: '0.01',
            decimals: 18,
            ...(lock === undefined ? {} : { lockWithdrawals: lock }),
          },
        },
      }),
    );
    if (!outcome.ok) {
      throw new Error(`grant refused: ${outcome.reason}`);
    }
    return outcome.grantId;
  }

  async function grantRow(id: string): Promise<typeof promoGrant.$inferSelect> {
    const [row] = await drizzle().select().from(promoGrant).where(eq(promoGrant.id, id));
    if (!row) {
      throw new Error('grantRow: query returned no row');
    }
    return row;
  }

  async function realBalance(userId: string, currency = 'USD') {
    const [row] = await drizzle()
      .select({ amount: walletBalance.amount })
      .from(walletBalance)
      .innerJoin(wallet, eq(wallet.id, walletBalance.walletId))
      .where(and(eq(wallet.userId, userId), eq(walletBalance.currency, currency)));
    return row?.amount ?? '0';
  }

  const ledgerRows = (userId: string, type: 'withdrawal' | 'swap_out') =>
    drizzle()
      .select({ id: walletTransaction.id })
      .from(walletTransaction)
      .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
      .where(and(eq(wallet.userId, userId), eq(walletTransaction.type, type)));

  const withdraw = (client: TestClient, amount: string, idempotencyKey: string = randomUUID()) =>
    client.post('/wallet/withdraw', { idempotencyKey, amount, currency: 'USD' });

  const roundDebit = (userId: string, type: 'bet' | 'loss', amount: string, round: string) =>
    drizzle().transaction((tx) =>
      commands().debit(tx, {
        userId,
        amount,
        type,
        currency: 'USD',
        context: CASINO,
        providerRef: {
          providerName: 'aggregator',
          providerRefId: `${type}-${round}`,
          externalRoundId: round,
        },
      }),
    );

  async function btcHolder() {
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `bonus-lock-swap-${randomUUID()}@e2e.test`,
    });
    const credited = await admin.post('/wallet/manual-adjustments', {
      userId,
      direction: 'credit',
      amount: '0.02',
      currency: 'BTC',
      reason: 'swap test funds',
      idempotencyKey: randomUUID(),
    });
    expect(credited.status).toBe(200);
    const grantId = await grant(userId, {
      source: 'manual',
      lock: true,
      currency: 'BTC',
      amount: '0.01',
      linked: '0.015',
    });
    return { client, userId, grantId };
  }

  async function swap(client: TestClient, fromAmount: string) {
    const quote = await readJson(
      await client.post('/wallet/swap/quote', {
        fromCurrency: 'BTC',
        toCurrency: 'USDT',
        fromAmount,
      }),
    );
    return client.post('/wallet/swap', {
      fromCurrency: 'BTC',
      toCurrency: 'USDT',
      fromAmount,
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
    });
  }

  return {
    app: () => app,
    admin: () => admin,
    drizzle,
    commands,
    deposit,
    player,
    grant,
    grantRow,
    realBalance,
    ledgerRows,
    withdraw,
    bet: (userId: string, amount: string, round: string) =>
      roundDebit(userId, 'bet', amount, round),
    lose: (userId: string, round: string) => roundDebit(userId, 'loss', '0', round),
    btcHolder,
    swap,
    anonymousGet: (path: string) => app.app.request(path, { method: 'GET' }),
  };
}
