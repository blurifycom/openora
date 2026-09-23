import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  loadExtensions,
  DRIZZLE,
  EVENT_BUS,
  type Container,
  type CoreTokenCatalog,
} from '@openora/core/server';
import {
  game,
  gameCategory,
  gameCategoryGame,
  gameProvider,
  gameRound,
} from '@openora/core/casino/schema/gaming';
import { wallet, walletBalance, walletTransaction } from '@openora/core/wallet/schema';
import { BONUS_GRANTS } from '@openora/core/contracts';
import { promoWeight, promoWeightProfile } from '@openora/core/promo/schema/bonus';
import {
  setupTestDb,
  bootTestApp,
  registerAndMaterializePlayer,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let gameId: string;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

async function deposit(client: TestClient, amount: string, currency = 'USD') {
  const res = await client.post('/wallet/deposit', {
    idempotencyKey: randomUUID(),
    amount,
    currency,
  });
  if (res.status !== 200) {
    throw new Error(`deposit failed (${res.status}): ${await res.text()}`);
  }
}

async function balanceOf(container: Container<CoreTokenCatalog>, userId: string): Promise<string> {
  const [row] = await container
    .get(DRIZZLE)
    .db.select({ amount: walletBalance.amount })
    .from(walletBalance)
    .innerJoin(wallet, eq(wallet.id, walletBalance.walletId))
    .where(eq(wallet.userId, userId));
  return row?.amount ?? '0';
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  const plugins = await loadExtensions();
  app = await bootTestApp({ plugins, databaseUrl: db.url });

  const [providerRow] = await app.container
    .get(DRIZZLE)
    .db.insert(gameProvider)
    .values({ slug: `e2e-studio-${randomUUID()}`, name: 'E2E Studio', isActive: true })
    .returning();
  const [categoryRow] = await app.container
    .get(DRIZZLE)
    .db.insert(gameCategory)
    .values({ slug: `e2e-category-${randomUUID()}`, name: 'E2E Category' })
    .returning();
  const [row] = await app.container
    .get(DRIZZLE)
    .db.insert(game)
    .values({
      name: 'Stake Debit E2E Game',
      slug: `stake-debit-e2e-${randomUUID()}`,
      providerId: providerRow!.id,
      aggregator: 'direct',
      isActive: true,
    })
    .returning();
  await app.container
    .get(DRIZZLE)
    .db.insert(gameCategoryGame)
    .values({ gameId: row!.id, categoryId: categoryRow!.id });
  if (!row) {
    throw new Error('failed to seed a game row');
  }
  gameId = row.id;
}, 60_000);

afterAll(async () => {
  await app.container.get(DRIZZLE).db.delete(gameRound).where(eq(gameRound.gameId, gameId));
  await app.container.get(DRIZZLE).db.delete(game).where(eq(game.id, gameId));
  await app.close();
  await db.dispose();
});

describe('gaming stake debit e2e', () => {
  it('debits the stake atomically with the round and records a completed bet ledger row', async () => {
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `stake-debit-${randomUUID()}@example.com`,
    });
    await deposit(client, '100');

    const res = await client.post('/gaming/rounds/start', {
      gameId,
      currency: 'USD',
      betAmount: '30',
    });
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { roundId: string };

    expect(await balanceOf(app.container, userId)).toBe('70.000000000000000000');

    const [round] = await app.container
      .get(DRIZZLE)
      .db.select()
      .from(gameRound)
      .where(eq(gameRound.id, body.roundId));
    expect(round?.betAmount).toBe('30.000000000000000000');
    expect(round?.winAmount).toBe('0.000000000000000000');

    const [walletRow] = await app.container
      .get(DRIZZLE)
      .db.select()
      .from(wallet)
      .where(eq(wallet.userId, userId));
    const betRows = await app.container
      .get(DRIZZLE)
      .db.select()
      .from(walletTransaction)
      .where(eq(walletTransaction.walletId, walletRow?.id ?? ''));
    const betRow = betRows.find((r) => r.type === 'bet');
    expect(betRow?.amount).toBe('30.000000000000000000');
    expect(betRow?.status).toBe('completed');
  });

  it('rejects starting a round the player cannot afford and creates no round', async () => {
    const { client } = await registerAndMaterializePlayer(app, {
      email: `stake-debit-poor-${randomUUID()}@example.com`,
    });
    await deposit(client, '5');

    const res = await client.post('/gaming/rounds/start', {
      gameId,
      currency: 'USD',
      betAmount: '50',
    });

    expect(res.status).toBe(400);

    const rounds = await client.get('/gaming/rounds');
    const roundsBody = (await readJson(rounds)) as unknown[];
    expect(roundsBody).toHaveLength(0);
  });

  it("refuses a stake over an active bonus grant's max bet, not as a short balance, and starts no round", async () => {
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `stake-debit-maxbet-${randomUUID()}@example.com`,
    });
    await deposit(client, '100');

    const [profile] = await app.container
      .get(DRIZZLE)
      .db.insert(promoWeightProfile)
      .values({ name: `maxbet-e2e-${randomUUID()}` })
      .returning();
    if (!profile) {
      throw new Error('seed weight profile: insert returned no row');
    }
    await app.container.get(DRIZZLE).db.insert(promoWeight).values({
      profileId: profile.id,
      scope: 'product',
      scopeRef: 'casino',
      contributionPercent: '100',
    });

    const grantOutcome = await app.container.get(DRIZZLE).db.transaction((tx) =>
      app.container.get(BONUS_GRANTS).grant(tx, {
        userId,
        currency: 'USD',
        amount: '10',
        source: 'deposit',
        sourceRef: randomUUID(),
        actor: { type: 'system' },
        terms: {
          wageringMultiplier: '5',
          expiryDays: 30,
          weightProfileId: profile.id,
          maxBet: '5',
        },
      }),
    );
    if (!grantOutcome.ok) {
      throw new Error('seed grant: grant was refused');
    }

    const res = await client.post('/gaming/rounds/start', {
      gameId,
      currency: 'USD',
      betAmount: '30',
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/maximum bet/i);
    expect(await balanceOf(app.container, userId)).toBe('100.000000000000000000');

    const rounds = await client.get('/gaming/rounds');
    const roundsBody = (await readJson(rounds)) as unknown[];
    expect(roundsBody).toHaveLength(0);
  });
});

describe('gaming wallet.balance.changed e2e', () => {
  it('emits the event for the bet debit with the ledger row the request wrote', async () => {
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `balance-changed-${randomUUID()}@example.com`,
    });
    await deposit(client, '100');
    const seen: Array<{ userId: string; transactionId: string; direction: string }> = [];
    const off = app.container.get(EVENT_BUS).on('wallet.balance.changed', (payload) => {
      if (payload.userId === userId) {
        seen.push(payload);
      }
    });

    try {
      const res = await client.post('/gaming/rounds/start', {
        gameId,
        currency: 'USD',
        betAmount: '25',
      });
      expect(res.status).toBe(200);

      const [walletRow] = await app.container
        .get(DRIZZLE)
        .db.select()
        .from(wallet)
        .where(eq(wallet.userId, userId));
      const betRows = (
        await app.container
          .get(DRIZZLE)
          .db.select()
          .from(walletTransaction)
          .where(eq(walletTransaction.walletId, walletRow?.id ?? ''))
      ).filter((r) => r.type === 'bet');
      expect(betRows).toHaveLength(1);

      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(seen[0]).toMatchObject({
        userId,
        amount: '25',
        currency: 'USD',
        transactionId: betRows[0]?.id,
        type: 'bet',
        direction: 'debit',
      });
    } finally {
      off();
    }
  });

  it('emits no credit event when ending a round that pays no win', async () => {
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `balance-changed-nowin-${randomUUID()}@example.com`,
    });
    await deposit(client, '100');
    const bus = app.container.get(EVENT_BUS);
    const seen: Array<{ direction: string }> = [];
    const endedRoundIds: string[] = [];
    const offBalance = bus.on('wallet.balance.changed', (payload) => {
      if (payload.userId === userId) {
        seen.push(payload);
      }
    });
    const offEnded = bus.on('gaming.round.ended', (payload) => {
      endedRoundIds.push(payload.roundId);
    });

    try {
      const start = await client.post('/gaming/rounds/start', {
        gameId,
        currency: 'USD',
        betAmount: '10',
      });
      expect(start.status).toBe(200);
      const { roundId } = (await readJson(start)) as { roundId: string };

      const end = await client.post(`/gaming/rounds/${roundId}/end`, {});
      expect(end.status).toBe(200);

      const [round] = await app.container
        .get(DRIZZLE)
        .db.select()
        .from(gameRound)
        .where(eq(gameRound.id, roundId));
      expect(round?.status).not.toBe('active');
      expect(await balanceOf(app.container, userId)).toBe('90.000000000000000000');
      // endRound emits any balance event before gaming.round.ended, so once that arrives
      // a stray credit event would already have landed.
      await vi.waitFor(() => {
        expect(endedRoundIds).toContain(roundId);
        expect(seen).toHaveLength(1);
      });
      expect(seen).toEqual([expect.objectContaining({ type: 'bet', direction: 'debit' })]);
    } finally {
      offBalance();
      offEnded();
    }
  });
});
