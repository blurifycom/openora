import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { loadExtensions, DRIZZLE, EVENT_BUS } from '@openora/core/server';
import { GAMING_COMMANDS, GamingUnknownGameError, WALLET_COMMANDS } from '@openora/core/contracts';
import { game, gameProvider, gameRound, ledgerGame } from '@openora/core/casino/schema/gaming';
import { wallet, walletBalance, walletTransaction } from '@openora/core/wallet/schema';
import {
  registerAndMaterializePlayer,
  type TestDb,
  type TestApp,
  type TestClient,
  bootE2e,
  bootTestApp,
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

let bootPlugins: Awaited<ReturnType<typeof loadExtensions>>;

beforeAll(async () => {
  bootPlugins = [
    ...(await loadExtensions()),
    { id: 'testing-exchange-rate-provider', path: exchangeRatePluginPath },
  ];
  ({ db, app } = await bootE2e({ plugins: bootPlugins, seed: false }));
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('round ledger e2e', () => {
  it('refuses a round on a game the ledger has not been told about and moves no money', async () => {
    // Funded first, so the boot backfill has run and cannot project the game imported next.
    const { client, userId } = await fundedPlayer('unreported');
    const imported = await importGame('Unreported');
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

  it('credits a win that opens a round on an unreported game, and refuses a stake there', async () => {
    const { userId } = await fundedPlayer('win-first');
    const imported = await importGame('Free Rounds');
    const commands = {
      wallet: app.container.get(WALLET_COMMANDS),
      gaming: app.container.get(GAMING_COMMANDS),
    };
    const round = { gameId: imported.id, userId, currency: 'USD' };
    const providerRef = (externalRoundId: string) => ({
      providerName: 'round-ledger',
      providerRefId: randomUUID(),
      externalRoundId,
    });

    await drizzle().transaction(async (tx) => {
      await commands.wallet.credit(tx, {
        userId,
        amount: '25',
        currency: 'USD',
        type: 'win',
        providerRef: providerRef('free-round'),
      });
      await commands.gaming.accumulateExternalRound(tx, {
        ...round,
        externalRoundId: 'free-round',
        winDelta: '25',
        isFinal: true,
      });
    });
    const afterWin = await ledgerOf(userId);
    expect(afterWin.balance).toBe('125.000000000000000000');

    await expect(
      drizzle().transaction(async (tx) => {
        await commands.wallet.debit(tx, {
          userId,
          amount: '10',
          currency: 'USD',
          type: 'bet',
          providerRef: providerRef('paid-round'),
        });
        await commands.gaming.accumulateExternalRound(tx, {
          ...round,
          externalRoundId: 'paid-round',
          betDelta: '10',
        });
      }),
    ).rejects.toBeInstanceOf(GamingUnknownGameError);
    expect(await ledgerOf(userId)).toEqual(afterWin);
    expect(await drizzle().select().from(gameRound).where(eq(gameRound.userId, userId))).toEqual([
      expect.objectContaining({ externalRoundId: 'free-round', status: 'completed' }),
    ]);
  });

  it('plays a reported game, and a later catalogue change leaves the settled round as it was', async () => {
    const imported = await importGame('Reported');
    await app.container.get(GAMING_COMMANDS).notifyGamesCreated?.({ gameIds: [imported.id] });
    await vi.waitFor(async () =>
      expect(await projectedVersion(imported.id)).toBe(imported.ledgerVersion),
    );
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

    const [moved] = await drizzle()
      .update(game)
      .set({ providerId: (await importGame('Acquirer')).providerId, gameType: 'original' })
      .where(eq(game.id, imported.id))
      .returning();
    await app.container.get(GAMING_COMMANDS).notifyGamesChanged?.({ gameIds: [imported.id] });
    await vi.waitFor(async () =>
      expect(await projectedVersion(imported.id)).toBe(moved?.ledgerVersion),
    );

    expect(await drizzle().select().from(gameRound).where(eq(gameRound.id, roundId))).toEqual(
      settledRound,
    );
    expect(await ledgerOf(userId)).toEqual(settledLedger);
  });

  it('projects a snapshot delivered over the bus through the gaming handler', async () => {
    const gameId = randomUUID();

    app.container.get(EVENT_BUS).emit('gaming.ledger_game.projected', {
      games: [{ gameId, providerId: randomUUID(), gameType: 'casino', version: 7 }],
    });

    await vi.waitFor(async () => expect(await projectedVersion(gameId)).toBe(7));
  });

  it('backfills at boot a game an importer wrote without notifying', async () => {
    const imported = await importGame('Silent');
    const rebooted = await bootTestApp({ plugins: bootPlugins, databaseUrl: db.url });

    try {
      await vi.waitFor(async () =>
        expect(await projectedVersion(imported.id)).toBe(imported.ledgerVersion),
      );
    } finally {
      await rebooted.close();
    }
  });
});
