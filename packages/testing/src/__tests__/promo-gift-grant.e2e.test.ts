import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { WALLET_COMMANDS } from '@openora/core/contracts';
import { walletBalance } from '@openora/core/wallet/schema';
import { promoGrant } from '@openora/core/promo/schema/bonus';
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

const drizzle = () => app.container.get(DRIZZLE).db;

async function deposit(client: TestClient, amount: string) {
  const res = await client.post('/wallet/deposit', {
    amount,
    currency: 'USD',
    idempotencyKey: randomUUID(),
  });
  if (res.status !== 200) {
    throw new Error(`deposit failed (${res.status}): ${await res.text()}`);
  }
}

const gift = (userId: string, amount: string) =>
  drizzle().transaction((tx) =>
    app.container.get(WALLET_COMMANDS).credit(tx, {
      userId,
      amount,
      currency: 'USD',
      type: 'gift',
    }),
  );

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

const grantsOf = (userId: string) =>
  drizzle().select().from(promoGrant).where(eq(promoGrant.userId, userId));

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

describe('money the platform gifts', () => {
  it('lands on a grant to be wagered, not in the balance the player can withdraw', async () => {
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `gift-${randomUUID()}@example.test`,
    });
    await deposit(client, '100');

    const outcome = await gift(userId, '50');

    expect(outcome.ok).toBe(true);
    expect(await realBalanceOf(userId)).toBe('100.000000000000000000');
    const grants = await grantsOf(userId);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      source: 'gift',
      currency: 'USD',
      grantedAmount: '50.000000000000000000',
      bonusBalance: '50.000000000000000000',
      wageringRequired: '50.000000000000000000',
      status: 'active',
    });
  });

  it('leaves the player free to withdraw every unit of their own deposit', async () => {
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `gift-withdraw-${randomUUID()}@example.test`,
    });
    await deposit(client, '100');
    await gift(userId, '500');

    const debited = await drizzle().transaction((tx) =>
      app.container.get(WALLET_COMMANDS).debit(tx, {
        userId,
        amount: '100',
        currency: 'USD',
        type: 'withdrawal',
      }),
    );

    expect(debited).toMatchObject({ ok: true, newBalance: '0.000000000000000000' });
  });

  it('grants once when the same gift is delivered twice', async () => {
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `gift-replay-${randomUUID()}@example.test`,
    });
    await deposit(client, '10');
    const providerRef = {
      providerName: 'chat',
      providerRefId: `gift-${randomUUID()}`,
    };

    await drizzle().transaction((tx) =>
      app.container.get(WALLET_COMMANDS).credit(tx, {
        userId,
        amount: '25',
        currency: 'USD',
        type: 'gift',
        providerRef,
      }),
    );
    await drizzle().transaction((tx) =>
      app.container.get(WALLET_COMMANDS).credit(tx, {
        userId,
        amount: '25',
        currency: 'USD',
        type: 'gift',
        providerRef,
      }),
    );

    const grants = await grantsOf(userId);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ bonusBalance: '25.000000000000000000' });
  });

  it('scores a gift against the default weight profile', async () => {
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `gift-weights-${randomUUID()}@example.test`,
    });
    await deposit(client, '10');
    await gift(userId, '40');

    // The whole row set is snapshotted, exclusions included: a gift is wagered on the same
    // terms as any other bonus, so PvP and sportsbook do not clear it either.
    const [grant] = await grantsOf(userId);
    expect(grant?.terms.weights).toEqual(
      expect.arrayContaining([
        { scope: 'default', scopeRef: null, contributionPercent: '100.00' },
        { scope: 'product', scopeRef: 'pvp', contributionPercent: '0.00' },
        { scope: 'product', scopeRef: 'sportsbook', contributionPercent: '0.00' },
      ]),
    );
    expect(grant?.terms.weights).toHaveLength(3);
  });
});
