import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { BONUS_GRANTS, WALLET_COMMANDS } from '@openora/core/contracts';
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

type HistoryItem = {
  id: string;
  type: string;
  amount: string;
  currency: string;
  status: string;
  direction: string | null;
  createdAt: string;
};
type History = { items: HistoryItem[]; total: number };

const drizzle = () => app.container.get(DRIZZLE).db;

async function deposit(client: TestClient, amount: string): Promise<string> {
  const res = await client.post('/wallet/deposit', {
    amount,
    currency: 'USD',
    idempotencyKey: randomUUID(),
  });
  if (res.status !== 200) {
    throw new Error(`deposit failed (${res.status}): ${await res.text()}`);
  }
  const body: unknown = await res.json();
  if (typeof body !== 'object' || body === null || !('transactionId' in body)) {
    throw new Error('deposit returned no transactionId');
  }
  return String(body.transactionId);
}

const credit = (userId: string, amount: string, type: 'gift' | 'rain') =>
  drizzle().transaction((tx) =>
    app.container.get(WALLET_COMMANDS).credit(tx, {
      userId,
      amount,
      currency: 'USD',
      type,
      providerRef: { providerName: 'chat', providerRefId: randomUUID() },
    }),
  );

const grantBonus = (userId: string, amount: string) =>
  drizzle().transaction((tx) =>
    app.container.get(BONUS_GRANTS).grant(tx, {
      userId,
      currency: 'USD',
      amount,
      source: 'manual',
      sourceRef: randomUUID(),
      actor: { type: 'admin', id: randomUUID() },
      terms: { wageringMultiplier: '1', expiryDays: 30 },
    }),
  );

async function history(client: TestClient, query = ''): Promise<History> {
  const res = await client.get(`/wallet/transactions?page=1&limit=50${query}`);
  if (res.status !== 200) {
    throw new Error(`history failed (${res.status}): ${await res.text()}`);
  }
  // oxlint-disable-next-line no-unsafe-type-assertion -- the route's own output schema validated it
  return (await res.json()) as History;
}

/** A player with a deposit of 100, a gift of 5, a rain drop of 1 and a manual bonus of 20. */
async function seededPlayer() {
  const player = await registerAndMaterializePlayer(app, {
    email: `history-${randomUUID()}@example.test`,
  });
  const depositId = await deposit(player.client, '100');
  await credit(player.userId, '5', 'gift');
  await credit(player.userId, '1', 'rain');
  await grantBonus(player.userId, '20');
  return { ...player, depositId };
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

describe('player transaction history', () => {
  it('lists the bonus, gift and rain grants the player received next to their ledger', async () => {
    const { client } = await seededPlayer();

    const { items, total } = await history(client);

    expect(total).toBe(4);
    expect(items.map((i) => i.type).sort()).toEqual(['bonus', 'deposit', 'gift', 'rain']);
    expect(items.find((i) => i.type === 'gift')).toMatchObject({
      amount: '5.000000000000000000',
      currency: 'USD',
      status: 'completed',
      direction: 'credit',
    });
  });

  it('filters by type, status and currency across the ledger and the grants', async () => {
    const { client } = await seededPlayer();

    const grantsOnly = await history(client, '&types[]=gift&types[]=rain');
    expect(grantsOnly.total).toBe(2);
    expect(grantsOnly.items.map((i) => i.type).sort()).toEqual(['gift', 'rain']);

    expect((await history(client, '&statuses[]=pending')).total).toBe(0);
    expect((await history(client, '&currencies[]=btc')).total).toBe(0);
    expect((await history(client, '&currencies[]=usd')).total).toBe(4);
  });

  it('filters by date range', async () => {
    const { client } = await seededPlayer();
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const hourAhead = new Date(Date.now() + 3_600_000).toISOString();

    expect((await history(client, `&from=${hourAgo}&to=${hourAhead}`)).total).toBe(4);
    expect((await history(client, `&from=${hourAhead}`)).total).toBe(0);
  });

  it('sorts by amount across the ledger and the grants', async () => {
    const { client } = await seededPlayer();

    const asc = await history(client, '&sortBy=amount&sortOrder=asc');
    const desc = await history(client, '&sortBy=amount&sortOrder=desc');

    expect(asc.items.map((i) => Number(i.amount))).toEqual([1, 5, 20, 100]);
    expect(desc.items.map((i) => Number(i.amount))).toEqual([100, 20, 5, 1]);
  });

  it('pages over the whole filtered history, not one half of it', async () => {
    const { client } = await seededPlayer();

    const res = await client.get('/wallet/transactions?page=2&limit=3&sortBy=amount&sortOrder=asc');
    // oxlint-disable-next-line no-unsafe-type-assertion -- the route's own output schema validated it
    const page = (await res.json()) as History;

    expect(page.total).toBe(4);
    expect(page.items.map((i) => Number(i.amount))).toEqual([100]);
  });

  it('finds a transaction by a prefix of its id', async () => {
    const { client, depositId } = await seededPlayer();
    const [gift] = (await history(client, '&types[]=gift')).items;

    const byDeposit = await history(client, `&search=${depositId.slice(0, 8).toUpperCase()}`);
    const byGrant = await history(client, `&search=${gift?.id}`);

    expect(byDeposit.items.map((i) => i.id)).toEqual([depositId]);
    expect(byGrant.items.map((i) => i.id)).toEqual([gift?.id]);
  });

  it('treats a LIKE wildcard in the search as a literal', async () => {
    const { client } = await seededPlayer();

    expect((await history(client, '&search=%25')).total).toBe(0);
  });

  it("never shows one player another player's grants", async () => {
    await seededPlayer();
    const stranger = await registerAndMaterializePlayer(app, {
      email: `history-stranger-${randomUUID()}@example.test`,
    });

    expect(await history(stranger.client)).toMatchObject({ total: 0, items: [] });
  });

  it('rejects a range whose start is after its end, and an unknown type', async () => {
    const { client } = await seededPlayer();
    const now = Date.now();
    const later = new Date(now + 60_000).toISOString();
    const earlier = new Date(now).toISOString();

    const inverted = await client.get(`/wallet/transactions?from=${later}&to=${earlier}`);
    const unknownType = await client.get('/wallet/transactions?types[]=jackpot');

    expect(inverted.status).toBe(400);
    expect(unknownType.status).toBe(400);
  });
});
