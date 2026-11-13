import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { GAMING_COMMANDS } from '@openora/core/contracts';
import { game, gameProvider, gameRound, ledgerGame } from '@openora/core/casino/schema/gaming';
import { wallet, walletBalance, walletTransaction } from '@openora/core/wallet/schema';
import {
  registerAndMaterializePlayer,
  type TestDb,
  type TestApp,
  type TestClient,
  bootE2e,
  closeE2e,
  readJson,
} from '../index.js';

const exchangeRatePluginPath = fileURLToPath(
  new URL('../test-exchange-rate-provider-plugin.ts', import.meta.url),
);

let db: TestDb;
let app: TestApp;

const drizzle = () => app.container.get(DRIZZLE).db;

async function importGame(label: string) {
  const [provider] = await drizzle()
    .insert(gameProvider)
    .values({ slug: `round-ledger-${randomUUID()}`, name: `${label} Studio`, isActive: true })
    .returning();
  const [row] = await drizzle()
    .insert(game)
    .values({
      reviewStatus: 'approved',
      name: `${label} Game`,
      slug: `round-ledger-${randomUUID()}`,
      providerId: provider!.id,
      aggregator: 'direct',
      isActive: true,
    })
    .returning();
  if (!row) {
    throw new Error(`failed to import the ${label} game`);
  }
  return row;
}

async function projectedVersion(gameId: string) {
  const [row] = await drizzle().select().from(ledgerGame).where(eq(ledgerGame.gameId, gameId));
  return row?.version;
}

async function fundedPlayer(label: string): Promise<{ client: TestClient; userId: string }> {
  const player = await registerAndMaterializePlayer(app, {
    email: `round-ledger-${label}-${randomUUID()}@example.com`,
  });
  const res = await player.client.post('/wallet/deposit', {
    idempotencyKey: randomUUID(),
    amount: '100',
    currency: 'USD',
  });
  expect(res.status).toBe(200);
  return player;
}

async function ledgerOf(userId: string) {
  const balances = await drizzle()
    .select({ amount: walletBalance.amount, walletId: wallet.id })
    .from(walletBalance)
    .innerJoin(wallet, eq(wallet.id, walletBalance.walletId))
    .where(eq(wallet.userId, userId));
  const rows = await drizzle()
    .select()
    .from(walletTransaction)
    .where(eq(walletTransaction.walletId, balances[0]?.walletId ?? ''));
  return { balance: balances[0]?.amount, rows };
}

beforeAll(async () => {
  ({ db, app } = await bootE2e({
    plugins: [
      ...(await loadExtensions()),
      { id: 'testing-exchange-rate-provider', path: exchangeRatePluginPath },
    ],
    seed: false,
  }));
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('round ledger e2e', () => {
  it('refuses a round on a game the ledger has not been told about and moves no money', async () => {
    const imported = await importGame('Unreported');
    const { client, userId } = await fundedPlayer('unreported');
    const before = await ledgerOf(userId);

    const res = await client.post('/gaming/rounds/start', {
      gameId: imported.id,
      currency: 'USD',
      betAmount: '30',
    });

    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/unknown to the round ledger/);
    expect(await ledgerOf(userId)).toEqual(before);
    expect(await drizzle().select().from(gameRound).where(eq(gameRound.userId, userId))).toEqual(
      [],
    );
  });

  it('plays a reported game, and a later catalogue change leaves the settled round as it was', async () => {
    const imported = await importGame('Reported');
    await app.container.get(GAMING_COMMANDS).notifyGamesCreated?.({ gameIds: [imported.id] });
    await vi.waitFor(async () => expect(await projectedVersion(imported.id)).toBe(0));
    const { client, userId } = await fundedPlayer('reported');

    const start = await client.post('/gaming/rounds/start', {
      gameId: imported.id,
      currency: 'USD',
      betAmount: '30',
    });
    expect(start.status).toBe(200);
    const { roundId } = (await readJson(start)) as { roundId: string };
    expect((await client.post(`/gaming/rounds/${roundId}/end`, {})).status).toBe(200);
    const settledRound = await drizzle().select().from(gameRound).where(eq(gameRound.id, roundId));
    const settledLedger = await ledgerOf(userId);
    expect(settledLedger.balance).toBe('70.000000000000000000');

    await drizzle()
      .update(game)
      .set({ providerId: (await importGame('Acquirer')).providerId, gameType: 'original' })
      .where(eq(game.id, imported.id));
    await app.container.get(GAMING_COMMANDS).notifyGamesChanged?.({ gameIds: [imported.id] });
    await vi.waitFor(async () => expect(await projectedVersion(imported.id)).toBe(1));

    expect(await drizzle().select().from(gameRound).where(eq(gameRound.id, roundId))).toEqual(
      settledRound,
    );
    expect(await ledgerOf(userId)).toEqual(settledLedger);
  });
});
