import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import * as z from 'zod';
import { DRIZZLE } from '@openora/core/server';
import { game, gameProvider, gameRound, ledgerGame } from '@openora/core/casino/schema/gaming';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import type { TestClient } from '../../index.js';
import { balanceOf, deliverWebhook, newDepositScenario, type WalletE2e } from './wallet.js';

const pluginPath = (file: string) => fileURLToPath(new URL(file, import.meta.url));

export const geoIpPlugin = {
  id: 'testing-geo-ip',
  path: pluginPath('../../test-geo-ip-plugin.ts'),
};
export const gameAdapterPlugin = {
  id: 'testing-game-adapter',
  path: pluginPath('./test-game-adapter-plugin.ts'),
};

export const ALLOWED_IP = '203.0.113.20';
export const DE_IP = '203.0.113.10';

export const StartedRoundSchema = z.object({
  roundId: z.string(),
  launchUrl: z.string(),
  token: z.string(),
});

export const EndedRoundSchema = z.object({ success: z.literal(true), winAmount: z.string() });

export const RoundViewSchema = z.object({
  id: z.string(),
  gameId: z.string(),
  userId: z.string(),
  status: z.enum(['active', 'completed', 'cancelled']),
  betAmount: z.string(),
  winAmount: z.string(),
  currency: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});

export async function bodyOf(res: Response): Promise<unknown> {
  const text = await res.text();
  return text === '' ? null : JSON.parse(text);
}

export const scaled = (amount: string) => `${amount}.000000000000000000`;

type NewGameOptions = {
  isActive?: boolean;
  providerActive?: boolean;
  withLedger?: boolean;
  name?: string;
  providerId?: string;
};

export async function newGame(
  e2e: WalletE2e,
  {
    isActive = true,
    providerActive = true,
    withLedger = true,
    name = 'Rounds Game',
    providerId,
  }: NewGameOptions = {},
) {
  const db = e2e.app.container.get(DRIZZLE).db;
  const [provider] = providerId
    ? await db.select().from(gameProvider).where(eq(gameProvider.id, providerId))
    : await db
        .insert(gameProvider)
        .values({
          slug: `rounds-prov-${randomUUID()}`,
          name: 'Rounds Provider',
          isActive: providerActive,
        })
        .returning();
  if (!provider) {
    throw new Error('provider seed failed');
  }
  const [created] = await db
    .insert(game)
    .values({
      name,
      slug: `rounds-game-${randomUUID()}`,
      providerId: provider.id,
      aggregator: 'rounds-e2e',
      isActive,
      reviewStatus: 'approved',
    })
    .returning();
  if (!created) {
    throw new Error('game seed failed');
  }
  if (withLedger) {
    await db.insert(ledgerGame).values({
      gameId: created.id,
      providerId: provider.id,
      gameType: 'casino',
      version: Math.max(created.ledgerVersion, 1),
    });
  }
  return { gameId: created.id, providerId: provider.id, slug: created.slug };
}

export async function fundedBettor(e2e: WalletE2e, amount = '50') {
  const scenario = await newDepositScenario(e2e, { minDeposit: '1' });
  const res = await deliverWebhook(e2e, scenario.deposit({ amount }));
  if (res.status !== 200) {
    throw new Error(`funding deposit failed (${res.status})`);
  }
  await vi.waitFor(
    async () => {
      expect(await balanceOf(e2e, scenario.userId, scenario.currency)).toBe(scaled(amount));
    },
    { timeout: 10_000, interval: 100 },
  );
  return scenario;
}

export type Bettor = Awaited<ReturnType<typeof fundedBettor>>;

export const startRoundAs = (
  client: TestClient,
  body: { gameId: string; currency: string; betAmount: string },
  ip = ALLOWED_IP,
) =>
  client.request('/gaming/rounds/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify(body),
  });

export const startRound = (bettor: Bettor, gameId: string, betAmount = '1', ip = ALLOWED_IP) =>
  startRoundAs(bettor.client, { gameId, currency: bettor.currency, betAmount }, ip);

export async function startedRound(bettor: Bettor, gameId: string, betAmount = '1') {
  const res = await startRound(bettor, gameId, betAmount);
  if (res.status !== 200) {
    throw new Error(`start round failed (${res.status}): ${await res.text()}`);
  }
  return StartedRoundSchema.parse(await bodyOf(res));
}

export const endRoundAs = (client: TestClient, roundId: string) =>
  client.post(`/gaming/rounds/${roundId}/end`, {});

export const roundRows = (e2e: WalletE2e, userId: string) =>
  e2e.app.container.get(DRIZZLE).db.select().from(gameRound).where(eq(gameRound.userId, userId));

export const ledgerRowsOf = (e2e: WalletE2e, userId: string, type: 'bet' | 'win') =>
  e2e.app.container
    .get(DRIZZLE)
    .db.select({
      amount: walletTransaction.amount,
      type: walletTransaction.type,
      providerRefId: walletTransaction.providerRefId,
    })
    .from(walletTransaction)
    .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
    .where(and(eq(wallet.userId, userId), eq(walletTransaction.type, type)));

export const allLedgerRowsOf = (e2e: WalletE2e, userId: string) =>
  e2e.app.container
    .get(DRIZZLE)
    .db.select({
      amount: walletTransaction.amount,
      type: walletTransaction.type,
      direction: walletTransaction.direction,
      providerRefId: walletTransaction.providerRefId,
    })
    .from(walletTransaction)
    .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
    .where(eq(wallet.userId, userId));
