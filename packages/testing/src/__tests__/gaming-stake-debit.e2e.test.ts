import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  loadExtensions,
  DRIZZLE,
  type Container,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { game, gameRound } from '@openora/core/casino/schema/gaming';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import {
  setupTestDb,
  bootTestApp,
  asPlayer,
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

async function registerAndLogin(email: string): Promise<{ client: TestClient; userId: string }> {
  const res = await app.app.request('/identity/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', name: 'Stake Debit E2E Player' }),
  });
  if (!res.ok) {
    throw new Error(`register failed (${res.status}): ${await res.text()}`);
  }
  const body = (await readJson(res)) as { user: { id: string } };
  const client = await asPlayer(app.app, { email });
  return { client, userId: body.user.id };
}

async function deposit(client: TestClient, amount: string, currency = 'USD') {
  const res = await client.post('/wallet/deposit', { amount, currency });
  if (res.status !== 200) {
    throw new Error(`deposit failed (${res.status}): ${await res.text()}`);
  }
}

async function balanceOf(container: Container<CoreTokenCatalog>, userId: string): Promise<string> {
  const [row] = await container
    .get(DRIZZLE)
    .db.select()
    .from(wallet)
    .where(eq(wallet.userId, userId));
  return row?.balance ?? '0';
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  const plugins = await loadExtensions();
  app = await bootTestApp({ plugins, databaseUrl: db.url });

  const [row] = await app.container
    .get(DRIZZLE)
    .db.insert(game)
    .values({ name: 'Stake Debit E2E Game', provider: 'mock', category: 'slots' })
    .returning();
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
    const { client, userId } = await registerAndLogin(`stake-debit-${randomUUID()}@example.com`);
    await deposit(client, '100');

    const res = await client.post('/gaming/rounds/start', {
      gameId,
      currency: 'USD',
      betAmount: '30',
    });
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { roundId: string };

    expect(await balanceOf(app.container, userId)).toBe('70.00000000');

    const [round] = await app.container
      .get(DRIZZLE)
      .db.select()
      .from(gameRound)
      .where(eq(gameRound.id, body.roundId));
    expect(round?.betAmount).toBe('30.00');
    expect(round?.winAmount).toBe('0.00');

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
    expect(betRow?.amount).toBe('30.00000000');
    expect(betRow?.status).toBe('completed');
  });

  it('rejects starting a round the player cannot afford and creates no round', async () => {
    const { client } = await registerAndLogin(`stake-debit-poor-${randomUUID()}@example.com`);
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
});
